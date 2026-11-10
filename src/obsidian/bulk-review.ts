import type { VaultPreviewEntry } from "./vault-preview-modal";
export interface PreviewFilter { readonly query: string; readonly outcome: string; readonly ruleId: string; readonly groupBy: "none" | "folder" | "rule" }
export function previewRuleIds(entry: VaultPreviewEntry): readonly string[] {
  const preview = entry.preview.preview;
  return [...new Set([...preview.appliedRuleIds, ...preview.involvedRuleIds, ...(preview.dryRunRuleIds ?? [])])].sort();
}
export function previewGroup(entry: VaultPreviewEntry, groupBy: PreviewFilter["groupBy"]): string {
  return groupBy === "folder" ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) || "/" : groupBy === "rule" ? previewRuleIds(entry).join(", ") || "(no matching rule)" : "";
}
export function filterPreviewEntries(entries: readonly VaultPreviewEntry[], filter: PreviewFilter): readonly VaultPreviewEntry[] {
  const query = filter.query.toLocaleLowerCase();
  const selected = entries.filter((entry) => (!query || [entry.path, entry.desiredPath ?? ""].some((path) => path.toLocaleLowerCase().includes(query)))
    && (!filter.outcome || entry.preview.preview.outcome === filter.outcome) && (!filter.ruleId || previewRuleIds(entry).includes(filter.ruleId)));
  return filter.groupBy === "none" ? selected : selected.sort((a, b) => previewGroup(a, filter.groupBy).localeCompare(previewGroup(b, filter.groupBy)) || a.path.localeCompare(b.path));
}
export function previewReviewSummary(entries: readonly VaultPreviewEntry[]): string {
  const destinations = new Map<string, number>();
  for (const entry of entries) destinations.set(entry.desiredPath ?? entry.path, (destinations.get(entry.desiredPath ?? entry.path) ?? 0) + 1);
  const collisions = [...destinations.values()].filter((count) => count > 1).length;
  return `${entries.length} selected note(s); ${entries.reduce((sum, entry) => sum + entry.propertyChangeCount, 0)} property change(s).${collisions ? " " + collisions + " duplicate proposed destination(s); collisions are rechecked during apply." : ""}`;
}
/** An explicit clipboard export: paths/rule IDs/property names, never body text or values. */
export function exportPreviewSummary(entries: readonly VaultPreviewEntry[]): string {
  return JSON.stringify({ schemaVersion: 1, summary: previewReviewSummary(entries), plans: entries.map((entry) => ({
    path: entry.path, desiredPath: entry.desiredPath ?? entry.path, outcome: entry.preview.preview.outcome, ruleIds: previewRuleIds(entry), propertyChangeCount: entry.propertyChangeCount,
    propertyNames: [...new Set([...Object.keys(entry.preview.current.frontmatter), ...Object.keys(entry.preview.result?.desired.frontmatter ?? {})])].sort(),
  })) }, null, 2);
}
