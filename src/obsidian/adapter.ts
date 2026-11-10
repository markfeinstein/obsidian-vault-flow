import { getAllTags, normalizePath, parseFrontMatterTags, TExternalFile, TFolder, type App, type CachedMetadata, type HeadingCache, type TFile } from "obsidian";
import type { Frontmatter, FrontmatterValue, JsonScalar, NoteState, PlannedMutation, ReconciliationConverged } from "../engine";
import type { CollisionPolicy } from "./settings";
import { captureNoteIdentity, type NoteIdentity } from "./note-identity";

const MAX_COLLISION_SUFFIX_ATTEMPTS = 10_000;
const PROTECTED_VAULT_PATHS = [".trash"];
const SUPPORTED_NOTE_EXTENSIONS = new Set(["md"]);

type MoveCollisionResolution =
  | { readonly status: "ready"; readonly path: string; readonly collided: boolean }
  | { readonly status: "skipped"; readonly path: string; readonly message: string };

type MutableFrontmatter = Record<string, unknown>;

export class TransactionInterruptedError extends Error {
  public constructor(public readonly reason: "stale" | "active" | "changed") {
    super(`Transaction interrupted before note mutation: ${reason}.`);
  }
}

export interface AppliedReconciliationTransaction {
  readonly beforePath: string;
  readonly afterPath: string;
  readonly beforeFrontmatter?: Record<string, unknown>;
  readonly afterFrontmatter?: Record<string, unknown>;
  readonly afterIdentity?: NoteIdentity;
}

export function isMarkdownFile(file: TFile): boolean {
  return file.extension.toLowerCase() === "md";
}

export function isProcessableFile(file: TFile): boolean {
  return isMarkdownFile(file) && !(file instanceof TExternalFile);
}

export function noteStateFromObsidian(
  file: TFile,
  cache: CachedMetadata | null,
  options?: { bodyContent?: string },
): NoteState {
  const headings = cache?.headings;
  const bodyH1 = firstH1Heading(headings);
  const rawFrontmatter = rawFrontmatterFromCache(cache);
  return {
    path: normalizePath(file.path),
    basename: file.basename,
    extension: file.extension,
    frontmatter: frontmatterFromCache(cache),
    frontmatterKeys: frontmatterKeysFromCache(cache),
    ...(rawFrontmatter === undefined ? {} : { rawFrontmatter }),
    tags: tagsFromCache(cache),
    frontmatterTags: frontmatterTagsFromCache(cache),
    inlineTags: inlineTagsFromCache(cache),
    stat: { ctime: file.stat.ctime, mtime: file.stat.mtime },
    ...(bodyH1 !== undefined ? { bodyH1 } : {}),
    ...(options?.bodyContent !== undefined ? { bodyContent: options.bodyContent } : {}),
  };
}

export function resolveMoveCollision(
  app: App,
  file: TFile,
  desiredPath: string,
  policy: CollisionPolicy,
): MoveCollisionResolution {
  const currentPath = normalizePath(file.path);
  const normalizedDesiredPath = normalizePath(desiredPath);
  const existing = app.vault.getAbstractFileByPath(normalizedDesiredPath);

  if (existing === null || normalizePath(existing.path) === currentPath) {
    return { status: "ready", path: normalizedDesiredPath, collided: false };
  }

  if (policy === "skip") {
    return {
      status: "skipped",
      path: normalizedDesiredPath,
      message: `Path change skipped because destination already exists: ${normalizedDesiredPath}`,
    };
  }

  return {
    status: "ready",
    path: findAvailableSiblingPath(app, currentPath, normalizedDesiredPath),
    collided: true,
  };
}

export function validateReconciliationResult(app: App, file: TFile, result: ReconciliationConverged): void {
  const rawDesiredPath = result.desired.path;
  const desiredPath = normalizePath(rawDesiredPath);
  const pathChanged = (hasMutation(result.mutations, "move") || hasMutation(result.mutations, "rename"))
    && normalizePath(file.path) !== desiredPath;
  if (!pathChanged) {
    return;
  }

  validateVaultPath(app, rawDesiredPath);
  validateVaultPath(app, desiredPath);
  validateDestinationExtension(desiredPath, file.extension);
}

export async function applyReconciliationResult(
  app: App,
  file: TFile,
  current: NoteState,
  result: ReconciliationConverged,
  assertCanStart: () => void = () => {},
  onMutationStarted: () => void = () => {},
): Promise<AppliedReconciliationTransaction> {
  const desiredPath = normalizePath(result.desired.path);

  const activeMutations = result.mutations;
  const pathChanged = (hasMutation(activeMutations, "move") || hasMutation(activeMutations, "rename"))
    && normalizePath(file.path) !== desiredPath;

  assertCanStart();
  if (pathChanged) {
    validateReconciliationResult(app, file, result);
    await ensureDestinationFolder(app, desiredPath, assertCanStart);
  }

  // Preparation may await folder creation. Recheck immediately before the first
  // note mutation; after a rename starts, complete or roll back the transaction
  // even if the plugin is disabled in the meantime.
  assertCanStart();
  let renamed = false;
  if (pathChanged) {
    onMutationStarted();
    await app.fileManager.renameFile(file, desiredPath);
    renamed = true;
  }

  let beforeFrontmatter: Record<string, unknown> | undefined;
  let afterFrontmatter: Record<string, unknown> | undefined;
  const shouldUpdateFrontmatter = hasMutation(activeMutations, "frontmatter") && frontmatterChanged(current, result.desired);
  if (shouldUpdateFrontmatter) {
    try {
      await app.fileManager.processFrontMatter(file, (value: unknown) => {
        if (!renamed) assertCanStart();
        if (!isPlainObject(value)) {
          throw new Error("Obsidian returned invalid frontmatter data.");
        }
        if (current.rawFrontmatter !== undefined && !rawFrontmatterEqual(current.rawFrontmatter, value)) {
          throw new Error("The note frontmatter changed after reconciliation was planned.");
        }
        if (!renamed) onMutationStarted();
        beforeFrontmatter = cloneUnknownRecord(value);
        applyDesiredFrontmatter(value, result.desired, current);
        afterFrontmatter = cloneUnknownRecord(value);
      });
    } catch (error) {
      if (renamed) {
        try {
          await app.fileManager.renameFile(file, current.path);
        } catch (rollbackError) {
          throw new Error(`Frontmatter write failed after rename, and rollback to ${current.path} failed: ${formatError(rollbackError)}. Original error: ${formatError(error)}`);
        }
      }
      throw error;
    }
  }

  // Identity capture failure must not turn a successful write into a reported
  // transaction failure. Such entries remain inspectable but cannot be undone.
  let afterIdentity: NoteIdentity | undefined;
  try {
    afterIdentity = await captureNoteIdentity(app, file);
  } catch {
    afterIdentity = undefined;
  }
  return {
    ...(afterIdentity === undefined ? {} : { afterIdentity }),
    beforePath: current.path,
    afterPath: desiredPath,
    ...(beforeFrontmatter === undefined ? {} : { beforeFrontmatter }),
    ...(afterFrontmatter === undefined ? {} : { afterFrontmatter }),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof structuredClone === "function") {
    return structuredClone<Record<string, unknown>>(value);
  }
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isPlainObject(parsed) ? parsed : Object.create(null) as Record<string, unknown>;
}

function stableStringifyUnknown(value: unknown): string {
  return JSON.stringify(sortUnknown(value));
}

export function rawFrontmatterEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return JSON.stringify(sortRawFrontmatter(left)) === JSON.stringify(sortRawFrontmatter(right));
}

function sortRawFrontmatter(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    sorted[key] = key === "tags" ? normalizeUnknownFrontmatterTags(value[key]) : sortUnknown(value[key]);
  }
  return sorted;
}

function normalizeUnknownFrontmatterTags(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeTagsForFrontmatter(value.split(/[\s,]+/));
  }
  if (Array.isArray(value)) {
    const tags: string[] = [];
    for (const item of value as unknown[]) {
      if (typeof item === "string") tags.push(item);
      else return sortUnknown(value);
    }
    return normalizeTagsForFrontmatter(tags);
  }
  return sortUnknown(value);
}

function sortUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortUnknown);
  }
  if (isPlainObject(value)) {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortUnknown(value[key]);
    }
    return sorted;
  }
  return value;
}

function frontmatterFromCache(cache: CachedMetadata | null): Frontmatter {
  const source: unknown = cache?.frontmatter;
  if (!isPlainObject(source)) {
    return {};
  }

  const frontmatter = Object.create(null) as Record<string, FrontmatterValue>;
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (isUnsafeObjectKey(key)) {
      continue;
    }

    const converted = toFrontmatterValue(value);
    if (converted !== undefined) {
      frontmatter[key] = converted;
    }
  }

  return frontmatter;
}

function rawFrontmatterFromCache(cache: CachedMetadata | null): Readonly<Record<string, unknown>> | undefined {
  const source: unknown = cache?.frontmatter;
  if (!isPlainObject(source)) {
    // A populated metadata cache confirms absence. Keep that empty baseline so
    // the atomic callback can reject frontmatter added after planning.
    return cache === null ? undefined : {};
  }
  return cloneUnknownRecord(source);
}

function frontmatterKeysFromCache(cache: CachedMetadata | null): readonly string[] {
  const source: unknown = cache?.frontmatter;
  if (!isPlainObject(source)) {
    return [];
  }
  return Object.keys(source)
    .filter((key) => !isUnsafeObjectKey(key))
    .sort();
}

function tagsFromCache(cache: CachedMetadata | null): readonly string[] {
  return [...(cache === null ? [] : getAllTags(cache) ?? [])].sort();
}

function frontmatterTagsFromCache(cache: CachedMetadata | null): readonly string[] {
  return [...(parseFrontMatterTags(cache?.frontmatter ?? null) ?? [])].sort();
}

function inlineTagsFromCache(cache: CachedMetadata | null): readonly string[] {
  return [...(cache?.tags ?? [])].map((tag) => tag.tag).sort();
}

function toFrontmatterValue(value: unknown): FrontmatterValue | undefined {
  if (isJsonScalar(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const result: JsonScalar[] = [];
    for (const item of value as unknown[]) {
      if (!isJsonScalar(item)) return undefined;
      result.push(item);
    }
    return result;
  }

  if (isPlainObject(value)) {
    const record = Object.create(null) as Record<string, JsonScalar>;
    for (const key of Object.keys(value)) {
      const nestedValue = value[key];
      if (isUnsafeObjectKey(key) || !isJsonScalar(nestedValue)) {
        return undefined;
      }
      record[key] = nestedValue;
    }
    return record;
  }

  return undefined;
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMutation(mutations: readonly PlannedMutation[], kind: PlannedMutation["kind"]): boolean {
  return mutations.some((mutation) => mutation.kind === kind);
}

function frontmatterChanged(current: NoteState, desired: NoteState): boolean {
  return stableStringifyFrontmatter(frontmatterWithoutTags(current.frontmatter)) !== stableStringifyFrontmatter(frontmatterWithoutTags(desired.frontmatter))
    || JSON.stringify(noteFrontmatterKeys(current)) !== JSON.stringify(noteFrontmatterKeys(desired))
    || JSON.stringify(noteFrontmatterTags(current)) !== JSON.stringify(noteFrontmatterTags(desired));
}

function applyDesiredFrontmatter(frontmatter: MutableFrontmatter, desired: NoteState, current: NoteState): void {
  // Delete properties that existed in current state but were removed in desired state.
  // This handles the deleteProperties action, including unsupported nested YAML values.
  const desiredKeys = new Set(noteFrontmatterKeys(desired));
  for (const key of noteFrontmatterKeys(current)) {
    if (isUnsafeObjectKey(key)) {
      continue;
    }
    if (key !== "tags" && !desiredKeys.has(key)) {
      Reflect.deleteProperty(frontmatter, key);
    }
  }

  for (const key of Object.keys(desired.frontmatter)) {
    const value = desired.frontmatter[key];
    if (isUnsafeObjectKey(key) || key === "tags") {
      continue;
    }
    if (stableStringifyUnknown(current.frontmatter[key]) !== stableStringifyUnknown(value)) {
      frontmatter[key] = value;
    }
  }

  const currentFrontmatterTags = noteFrontmatterTags(current);
  const desiredFrontmatterTags = noteFrontmatterTags(desired);
  if (!desiredKeys.has("tags")) {
    Reflect.deleteProperty(frontmatter, "tags");
  } else if (JSON.stringify(currentFrontmatterTags) !== JSON.stringify(desiredFrontmatterTags)) {
    if (desiredFrontmatterTags.length > 0) {
      frontmatter.tags = desiredFrontmatterTags;
    } else {
      Reflect.deleteProperty(frontmatter, "tags");
    }
  }
}

function frontmatterWithoutTags(source: Frontmatter): Frontmatter {
  const result = Object.create(null) as Frontmatter;
  for (const key of Object.keys(source)) {
    if (isUnsafeObjectKey(key)) {
      continue;
    }
    if (key !== "tags") {
      result[key] = source[key];
    }
  }
  return result;
}

function noteFrontmatterKeys(state: NoteState): readonly string[] {
  return [...new Set([...(state.frontmatterKeys ?? []), ...Object.keys(state.frontmatter)])]
    .filter((key) => !isUnsafeObjectKey(key))
    .sort();
}

function noteFrontmatterTags(state: NoteState): readonly string[] {
  return normalizeTagsForFrontmatter(state.frontmatterTags ?? frontmatterTagsFromValue(state.frontmatter.tags));
}

function frontmatterTagsFromValue(value: FrontmatterValue | undefined): readonly string[] {
  if (typeof value === "string") {
    return normalizeTagsForFrontmatter(value.split(/[\s,]+/));
  }

  if (Array.isArray(value)) {
    return normalizeTagsForFrontmatter(value.filter((item): item is string => typeof item === "string"));
  }

  return [];
}

function normalizeTagsForFrontmatter(tags: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (const tag of tags) {
    const normalizedTag = stripHashPrefix(tag.trim()).replace(/^#+/, "");
    if (normalizedTag.length > 0 && !normalized.includes(normalizedTag)) {
      normalized.push(normalizedTag);
    }
  }
  return normalized.sort();
}

function stableStringifyFrontmatter(frontmatter: Frontmatter): string {
  return JSON.stringify(sortedFrontmatter(frontmatter));
}

function sortedFrontmatter(frontmatter: Frontmatter): Frontmatter {
  const sorted = Object.create(null) as Frontmatter;
  for (const key of Object.keys(frontmatter).sort()) {
    sorted[key] = sortFrontmatterValue(frontmatter[key]);
  }
  return sorted;
}

function sortFrontmatterValue(value: FrontmatterValue): FrontmatterValue {
  if (Array.isArray(value)) {
    return [...value];
  }

  if (value !== null && typeof value === "object") {
    const sorted = Object.create(null) as Record<string, JsonScalar>;
    for (const key of Object.keys(value).sort()) {
      if (!isUnsafeObjectKey(key)) {
        sorted[key] = value[key];
      }
    }
    return sorted;
  }

  return value;
}

function stripHashPrefix(tag: string): string {
  return tag.startsWith("#") ? tag.slice(1) : tag;
}

function validateVaultPath(app: App, path: string): void {
  const normalized = normalizePath(path);
  const unsafeSegment = normalized.split("/").some((segment) => segment === "..");
  if (unsafeSegment) {
    throw new Error(`Unsafe vault path contains '..' segment: ${path}`);
  }

  const lowerPath = normalized.toLowerCase();
  const protectedPaths = [app.vault.configDir, ...PROTECTED_VAULT_PATHS]
    .filter((protectedPath) => typeof protectedPath === "string" && protectedPath.length > 0)
    .map((protectedPath) => normalizePath(protectedPath).toLowerCase());
  if (protectedPaths.some((protectedPath) => lowerPath === protectedPath || lowerPath.startsWith(`${protectedPath}/`))) {
    throw new Error(`Unsafe vault path targets protected folder: ${path}`);
  }
}

function validateDestinationExtension(path: string, currentExtension: string): void {
  const extension = parseVaultPath(path).extensionWithDot.slice(1).toLowerCase();
  const normalizedCurrentExtension = currentExtension.toLowerCase();
  if (!SUPPORTED_NOTE_EXTENSIONS.has(normalizedCurrentExtension)) {
    throw new Error(`Unsupported note extension .${currentExtension} for markdown processing.`);
  }
  if (extension !== normalizedCurrentExtension) {
    throw new Error(`Unsafe vault path changes file extension from .${currentExtension} to .${extension || ""}: ${path}`);
  }
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

async function ensureDestinationFolder(app: App, destinationPath: string, assertCanStart: () => void): Promise<void> {
  const folderPath = parentFolderPath(destinationPath);
  if (folderPath === "") {
    return;
  }

  const segments = folderPath.split("/");
  let currentPath = "";
  for (const segment of segments) {
    assertCanStart();
    currentPath = normalizePath(currentPath === "" ? segment : `${currentPath}/${segment}`);
    const existing = app.vault.getAbstractFileByPath(currentPath);
    if (existing === null) {
      try {
        await app.vault.createFolder(currentPath);
      } catch (error) {
        const racedFolder = app.vault.getAbstractFileByPath(currentPath);
        if (!(racedFolder instanceof TFolder)) {
          throw error;
        }
      }
      continue;
    }

    if (!(existing instanceof TFolder)) {
      throw new Error(`Cannot create folder ${currentPath}; a file exists at that path.`);
    }
  }
}

function parentFolderPath(path: string): string {
  const normalized = normalizePath(path);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? "" : normalized.slice(0, separatorIndex);
}

function findAvailableSiblingPath(app: App, currentPath: string, desiredPath: string): string {
  const parsed = parseVaultPath(desiredPath);
  for (let suffix = 1; suffix <= MAX_COLLISION_SUFFIX_ATTEMPTS; suffix += 1) {
    const candidatePath = normalizePath(`${parsed.folderPrefix}${parsed.basename} ${suffix}${parsed.extensionWithDot}`);
    const existing = app.vault.getAbstractFileByPath(candidatePath);
    if (existing === null || normalizePath(existing.path) === currentPath) {
      return candidatePath;
    }
  }

  throw new Error(`Could not find an available filename for ${desiredPath}.`);
}

function firstH1Heading(headings: HeadingCache[] | undefined): string | undefined {
  if (headings === undefined || headings.length === 0) {
    return undefined;
  }

  const h1 = headings.find((h) => h.level === 1);
  return h1?.heading;
}

function parseVaultPath(path: string): { readonly folderPrefix: string; readonly basename: string; readonly extensionWithDot: string } {
  const normalized = normalizePath(path);
  const separatorIndex = normalized.lastIndexOf("/");
  const folderPrefix = separatorIndex === -1 ? "" : `${normalized.slice(0, separatorIndex)}/`;
  const filename = separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
  const dotIndex = filename.lastIndexOf(".");

  if (dotIndex <= 0) {
    return { folderPrefix, basename: filename, extensionWithDot: "" };
  }

  return {
    folderPrefix,
    basename: filename.slice(0, dotIndex),
    extensionWithDot: filename.slice(dotIndex),
  };
}
