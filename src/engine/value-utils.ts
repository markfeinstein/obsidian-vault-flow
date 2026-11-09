/** Canonical JSON helpers shared by planning, writing, undo, and display. */
export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

export function canonicalValue(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function unknownValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalValue(left) === canonicalValue(right);
}

export function normalizeRawTags(value: unknown): unknown {
  const values = typeof value === "string" ? value.split(/[\s,]+/u) : value;
  if (!Array.isArray(values) || !values.every((item: unknown) => typeof item === "string")) return sortValue(value);
  return [...new Set(values.map((tag) => tag.trim().replace(/^#+/u, "")).filter(Boolean))].sort();
}

export function canonicalFrontmatter(value: Readonly<Record<string, unknown>>): string {
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) sorted[key] = key === "tags" ? normalizeRawTags(value[key]) : sortValue(value[key]);
  return JSON.stringify(sorted);
}

export function rawFrontmatterEqual(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  return canonicalFrontmatter(left) === canonicalFrontmatter(right);
}
