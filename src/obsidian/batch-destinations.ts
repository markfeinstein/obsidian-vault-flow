import { normalizePath, TFolder, type App } from "obsidian";
import { resolveMoveCollision } from "./adapter";
import { withNoteStatePath } from "./note-state";
import type { CollisionPolicy } from "./settings";
import type { VaultPreviewEntry } from "./vault-preview-modal";

const pathKey = (path: string): string => normalizePath(path).toLowerCase();

/** Reserve against the current vault AND earlier selected rows, in the same
 * stable order used by apply. Never assume that a source path will be vacated:
 * earlier rows can be skipped, so swaps and dependencies must not overwrite it.
 */
export function reserveBatchDestinations(app: App, entries: readonly VaultPreviewEntry[], policy: CollisionPolicy): ReadonlyMap<VaultPreviewEntry, VaultPreviewEntry> {
  const reserved = new Set<string>();
  const folders = new Set<string>();
  const reserve = (path: string): void => {
    reserved.add(pathKey(path));
    for (const parent of parentPaths(path)) folders.add(pathKey(parent));
  };
  const sources = new Set<string>();
  const plans = new Map<VaultPreviewEntry, VaultPreviewEntry>();
  for (const entry of entries) {
    if (entry.preview.result === null || entry.preview.preview.outcome !== "changed") { plans.set(entry, entry); continue; }
    const source = entry.preview.current.path;
    if (sources.has(pathKey(source))) { plans.set(entry, blocked(entry, "The same source note occurs more than once in this batch. Select it only once.")); continue; }
    sources.add(pathKey(source));
    const hasPathChange = entry.preview.preview.mutationKinds.some((kind) => kind === "move" || kind === "rename");
    if (!hasPathChange) { reserve(source); plans.set(entry, entry); continue; }
    try {
      const resolution = resolveMoveCollision(app, { path: source }, entry.preview.collisionBasePath ?? entry.preview.result.desired.path, policy,
        (path) => reserved.has(pathKey(path)) || folders.has(pathKey(path)));
      if (resolution.status === "skipped") { plans.set(entry, blocked(entry, "Batch destination is occupied or already reserved: " + resolution.path)); continue; }
      const blockedParent = parentPaths(resolution.path).find((parent) => {
        const existing = app.vault.getAbstractFileByPath(parent);
        return reserved.has(pathKey(parent)) || (existing !== null && !(existing instanceof TFolder));
      });
      if (blockedParent !== undefined) { plans.set(entry, blocked(entry, `Batch destination parent is a file or is reserved as a file: ${blockedParent}`)); continue; }
      reserve(resolution.path);
      const result = { ...entry.preview.result, desired: withNoteStatePath(entry.preview.result.desired, resolution.path) };
      plans.set(entry, { ...entry, desiredPath: resolution.path, preview: { ...entry.preview, result,
        preview: { ...entry.preview.preview, desiredPath: resolution.path, message: "This exact destination is reserved for the selected batch. Changes require a new preview." } } });
    } catch (error) { plans.set(entry, blocked(entry, error instanceof Error ? error.message : String(error))); }
  }
  return plans;
}

function parentPaths(path: string): readonly string[] {
  const result: string[] = [];
  let current = normalizePath(path);
  for (let slash = current.lastIndexOf("/"); slash > 0; slash = current.lastIndexOf("/")) {
    current = current.slice(0, slash);
    result.push(current);
  }
  return result;
}

function blocked(entry: VaultPreviewEntry, message: string): VaultPreviewEntry {
  return { ...entry, preview: { ...entry.preview, result: null, preview: { ...entry.preview.preview, outcome: "skipped", message } } };
}
