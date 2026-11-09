import type { NoteState } from "../engine";
import { sortValue } from "../engine/value-utils";

export interface FrontmatterDiffEntry {
  readonly property: string;
  readonly before: string;
  readonly after: string;
}

export function frontmatterDiff(current: NoteState, desired: NoteState): readonly FrontmatterDiffEntry[] {
  const currentKeys = new Set([...(current.frontmatterKeys ?? []), ...Object.keys(current.frontmatter)]);
  const desiredKeys = new Set([...(desired.frontmatterKeys ?? []), ...Object.keys(desired.frontmatter)]);
  const result: FrontmatterDiffEntry[] = [];
  for (const key of [...new Set([...currentKeys, ...desiredKeys])].sort()) {
    const before = Object.prototype.hasOwnProperty.call(current.frontmatter, key) ? current.frontmatter[key] : current.rawFrontmatter?.[key];
    const after = Object.prototype.hasOwnProperty.call(desired.frontmatter, key) ? desired.frontmatter[key] : current.rawFrontmatter?.[key];
    const beforeText = currentKeys.has(key) ? formatValue(before) : "(absent)";
    const afterText = desiredKeys.has(key) ? formatValue(after) : "(absent)";
    if (beforeText !== afterText) result.push({ property: key, before: beforeText, after: afterText });
  }
  return result;
}

function formatValue(value: unknown): string {
  const text = JSON.stringify(sortValue(value), null, 2) ?? "undefined";
  return text;
}

/** Text-only, lazily rendered details shared by active-note, vault, and Bases previews. */
export function renderFrontmatterDiff(parent: HTMLElement, current: NoteState, desired: NoteState): void {
  const changes = frontmatterDiff(current, desired);
  if (changes.length === 0) return;
  const details = parent.createEl("details", { cls: "vf-property-diff" });
  details.createEl("summary", { text: `Review ${changes.length} property change${changes.length === 1 ? "" : "s"}` });
  let rendered = false;
  details.addEventListener("toggle", () => {
    if (!details.open || rendered) return;
    rendered = true;
    const table = details.createEl("table", { cls: "vf-preview-table" });
    const header = table.createEl("thead").createEl("tr");
    for (const label of ["Property", "Before", "After"]) header.createEl("th", { text: label, attr: { scope: "col" } });
    const body = table.createEl("tbody");
    for (const change of changes) {
      const row = body.createEl("tr");
      row.createEl("th", { text: change.property, attr: { scope: "row" } });
      for (const value of [change.before, change.after]) {
        const cell = row.createEl("td");
        cell.createEl("pre", { text: value.length > 8_000 ? `${value.slice(0, 8_000)}\n… (display truncated)` : value });
      }
    }
  });
}
