import { normalizePath } from "obsidian";
import type { FrontmatterValue, NoteState } from "../engine";
import { canonicalFrontmatter, canonicalValue as stringifyValue, rawFrontmatterEqual, sortValue } from "../engine/value-utils";

export function sameNoteStateBaseline(planned: NoteState, current: NoteState): boolean {
  return planned.path === current.path
    && planned.basename === current.basename
    && planned.extension === current.extension
    && planned.stat?.ctime === current.stat?.ctime
    && planned.stat?.mtime === current.stat?.mtime
    && planned.bodyH1 === current.bodyH1
    && (planned.bodyFingerprint === undefined ? planned.bodyContent === current.bodyContent : planned.bodyFingerprint === current.bodyFingerprint)
    && arraysEqual(normalizeTags(planned.tags), normalizeTags(current.tags))
    && arraysEqual(frontmatterKeys(planned), frontmatterKeys(current))
    && canonicalFrontmatter(planned.frontmatter) === canonicalFrontmatter(current.frontmatter)
    && (planned.rawFrontmatter === undefined
      || (current.rawFrontmatter !== undefined && rawFrontmatterEqual(planned.rawFrontmatter, current.rawFrontmatter)));
}

export function countFrontmatterChanges(current: NoteState, desired: NoteState): number {
  const currentKeys = new Set(frontmatterKeys(current));
  const desiredKeys = new Set(frontmatterKeys(desired));
  const keys = new Set([...currentKeys, ...desiredKeys]);
  let count = 0;
  for (const key of keys) {
    if (currentKeys.has(key) !== desiredKeys.has(key)
      || canonicalValue(current.frontmatter[key], key === "tags") !== canonicalValue(desired.frontmatter[key], key === "tags")) {
      count += 1;
    }
  }
  return count;
}

export function withNoteStatePath(state: NoteState, path: string): NoteState {
  const normalizedPath = normalizePath(path);
  const filename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const dotIndex = filename.lastIndexOf(".");
  return {
    ...state,
    path: normalizedPath,
    basename: dotIndex <= 0 ? filename : filename.slice(0, dotIndex),
    extension: dotIndex <= 0 ? "" : filename.slice(dotIndex + 1),
  };
}

function frontmatterKeys(state: NoteState): readonly string[] {
  return [...new Set([...(state.frontmatterKeys ?? []), ...Object.keys(state.frontmatter)])].sort();
}

function canonicalValue(value: FrontmatterValue | undefined, tags: boolean): string {
  if (value === undefined) return "undefined";
  return stringifyValue(tags ? [...normalizeTags(frontmatterTagsFromValue(value))] : sortValue(value));
}

function frontmatterTagsFromValue(value: FrontmatterValue): readonly string[] {
  if (typeof value === "string") {
    return value.split(/[\s,]+/u);
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  const valuesByKey = new Map<string, string>();
  for (const tag of tags) {
    const normalized = tag.trim().replace(/^#+/u, "");
    const key = normalized.toLocaleLowerCase();
    if (normalized.length > 0 && !valuesByKey.has(key)) {
      valuesByKey.set(key, normalized);
    }
  }
  return [...valuesByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
