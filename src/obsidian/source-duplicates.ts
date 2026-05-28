import type { App } from "obsidian";
import type { Rule, RulePredicate } from "../engine";

export interface SourceUrlOccurrence {
  readonly path: string;
  readonly property: string;
}

export interface DuplicateSourceUrlGroup {
  readonly url: string;
  readonly occurrences: readonly SourceUrlOccurrence[];
}

export interface SourceDuplicateScanInput {
  readonly path: string;
  readonly frontmatter: unknown;
}

export function collectSourceUrlProperties(rules: readonly Rule[]): readonly string[] {
  const properties = new Set<string>();

  for (const rule of rules) {
    if (rule.enabled) {
      collectSourceUrlPropertiesFromPredicate(rule.when, properties);
    }
  }

  return [...properties];
}

export function findDuplicateSourceUrls(
  notes: readonly SourceDuplicateScanInput[],
  properties: readonly string[],
): readonly DuplicateSourceUrlGroup[] {
  const sourceProperties = uniqueNonEmptyStrings(properties);
  const occurrencesByUrl = new Map<string, SourceUrlOccurrence[]>();

  for (const note of notes) {
    if (!isRecord(note.frontmatter)) {
      continue;
    }

    for (const property of sourceProperties) {
      const url = normalizeSourceUrl(note.frontmatter[property]);
      if (url === null) {
        continue;
      }

      const occurrences = occurrencesByUrl.get(url) ?? [];
      occurrences.push({ path: note.path, property });
      occurrencesByUrl.set(url, occurrences);
    }
  }

  return [...occurrencesByUrl.entries()]
    .filter(([, occurrences]) => hasMultiplePaths(occurrences))
    .map(([url, occurrences]) => ({
      url,
      occurrences: [...occurrences].sort(compareOccurrences),
    }))
    .sort((left, right) => left.url.localeCompare(right.url));
}

export function scanVaultForDuplicateSourceUrls(app: App, properties: readonly string[]): readonly DuplicateSourceUrlGroup[] {
  return findDuplicateSourceUrls(
    app.vault.getMarkdownFiles().map((file) => ({
      path: file.path,
      frontmatter: app.metadataCache.getFileCache(file)?.frontmatter,
    })),
    properties,
  );
}

export function normalizeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return null;
  }

  try {
    return new URL(trimmedValue).href;
  } catch {
    return null;
  }
}

function collectSourceUrlPropertiesFromPredicate(predicate: RulePredicate, properties: Set<string>): void {
  switch (predicate.type) {
    case "sourceUrl": {
      const property = predicate.property.trim();
      if (property.length > 0) {
        properties.add(property);
      }
      break;
    }
    case "all":
    case "any":
      for (const child of predicate.predicates) {
        collectSourceUrlPropertiesFromPredicate(child, properties);
      }
      break;
    case "not":
      collectSourceUrlPropertiesFromPredicate(predicate.predicate, properties);
      break;
    case "pathGlob":
    case "tag":
    case "basename":
    case "frontmatterValue":
      break;
  }
}

function uniqueNonEmptyStrings(values: readonly string[]): readonly string[] {
  const uniqueValues = new Set<string>();
  for (const value of values) {
    const trimmedValue = value.trim();
    if (trimmedValue.length > 0) {
      uniqueValues.add(trimmedValue);
    }
  }
  return [...uniqueValues];
}

function hasMultiplePaths(occurrences: readonly SourceUrlOccurrence[]): boolean {
  return new Set(occurrences.map((occurrence) => occurrence.path)).size > 1;
}

function compareOccurrences(left: SourceUrlOccurrence, right: SourceUrlOccurrence): number {
  const pathComparison = left.path.localeCompare(right.path);
  if (pathComparison !== 0) {
    return pathComparison;
  }

  return left.property.localeCompare(right.property);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
