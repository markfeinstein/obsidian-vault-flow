import { moment, normalizePath, type CachedMetadata, type TFile } from "obsidian";
import { isMarkdownFile } from "./adapter";
import type { Rule, RulePredicate } from "../engine";

export type MtimeMap = Readonly<Record<string, number>>;

export interface MtimeSweepPlan {
  readonly filesToEnqueue: readonly TFile[];
  readonly trackedMtimes: MtimeMap;
  readonly changed: boolean;
}

export interface MtimeMapUpdate {
  readonly trackedMtimes: MtimeMap;
  readonly changed: boolean;
}

export function sweepRulesDependOnTime(rules: readonly Rule[]): boolean {
  return rules.some((rule) => rule.enabled
    && (rule.runOn === undefined || rule.runOn === "always" || rule.runOn === "sweep")
    && (predicateDependsOnTime(rule.when) || actionDependsOnTime(rule)));
}

function predicateDependsOnTime(predicate: RulePredicate): boolean {
  if (predicate.type === "fileAge" || predicate.type === "frontmatterDateAge") return true;
  if (predicate.type === "all" || predicate.type === "any") return predicate.predicates.some(predicateDependsOnTime);
  return predicate.type === "not" && predicateDependsOnTime(predicate.predicate);
}

export function planMtimeSweep(
  files: readonly TFile[],
  previous: MtimeMap,
  options: { readonly force?: boolean; readonly shouldReevaluate?: (file: TFile) => boolean } = {},
): MtimeSweepPlan {
  const filesToEnqueue: TFile[] = [];
  const trackedMtimes: Record<string, number> = {};

  for (const file of files) {
    if (!isMarkdownFile(file) || !isFiniteMtime(file.stat.mtime)) {
      continue;
    }

    const path = normalizePath(file.path);
    const mtime = file.stat.mtime;
    trackedMtimes[path] = mtime;

    if (options.force === true || previous[path] !== mtime || options.shouldReevaluate?.(file) === true) {
      filesToEnqueue.push(file);
    }
  }

  return {
    filesToEnqueue,
    trackedMtimes,
    changed: !mtimeMapsEqual(previous, trackedMtimes),
  };
}

/** Return true only when an unchanged note crossed an age threshold or a
 * current-time template would render differently since the previous sweep. */
export function timeDependentSweepDue(
  file: TFile,
  cache: CachedMetadata | null,
  rules: readonly Rule[],
  previousNow: number,
  now: number,
): boolean {
  const applicable = rules.filter((rule) => rule.enabled
    && (rule.runOn === undefined || rule.runOn === "always" || rule.runOn === "sweep"));
  if (applicable.length === 0) return false;
  if (!Number.isFinite(previousNow) || !Number.isFinite(now) || now <= previousNow) {
    return applicable.some((rule) => predicateDependsOnTime(rule.when) || actionDependsOnTime(rule));
  }
  const frontmatter = cache?.frontmatter;
  return applicable.some((rule) => predicateTimeBoundaryCrossed(rule.when, file, frontmatter, previousNow, now)
    || actionTemplateChanged(rule, frontmatter, previousNow, now));
}

function predicateTimeBoundaryCrossed(
  predicate: RulePredicate,
  file: TFile,
  frontmatter: Readonly<Record<string, unknown>> | undefined,
  previousNow: number,
  now: number,
): boolean {
  if (predicate.type === "fileAge") {
    const timestamp = predicate.field === "ctime" ? file.stat.ctime : file.stat.mtime;
    return ageBoundaryCrossed(timestamp, predicate.olderThanDays, predicate.newerThanDays, previousNow, now);
  }
  if (predicate.type === "frontmatterDateAge") {
    const timestamp = frontmatterDateTimestamp(frontmatter?.[predicate.property]);
    return timestamp !== null
      && ageBoundaryCrossed(timestamp, predicate.olderThanDays, predicate.newerThanDays, previousNow, now);
  }
  if (predicate.type === "all" || predicate.type === "any") {
    return predicate.predicates.some((child) => predicateTimeBoundaryCrossed(child, file, frontmatter, previousNow, now));
  }
  return predicate.type === "not"
    && predicateTimeBoundaryCrossed(predicate.predicate, file, frontmatter, previousNow, now);
}

function ageBoundaryCrossed(
  timestamp: number,
  olderThanDays: number | undefined,
  newerThanDays: number | undefined,
  previousNow: number,
  now: number,
): boolean {
  if (!Number.isFinite(timestamp) || timestamp < 0) return false;
  const olderBoundary = olderThanDays === undefined ? null : timestamp + olderThanDays * 86_400_000;
  const newerBoundary = newerThanDays === undefined ? null : timestamp + newerThanDays * 86_400_000;
  return (olderBoundary !== null && previousNow <= olderBoundary && now > olderBoundary)
    || (newerBoundary !== null && previousNow < newerBoundary && now >= newerBoundary);
}

function frontmatterDateTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function actionDependsOnTime(rule: Rule): boolean {
  return [rule.then.moveTo, rule.then.renameTo].some((template) => template !== undefined && timeTemplateKeys(template).length > 0);
}

function actionTemplateChanged(
  rule: Rule,
  frontmatter: Readonly<Record<string, unknown>> | undefined,
  previousNow: number,
  now: number,
): boolean {
  for (const template of [rule.then.moveTo, rule.then.renameTo]) {
    if (template === undefined) continue;
    for (const key of timeTemplateKeys(template)) {
      if ((key === "now" || key === "today") && scalarOverrideExists(frontmatter?.[key])) continue;
      const format = key.startsWith("date:") ? key.slice(5)
        : key.startsWith("now:") ? key.slice(4)
        : key.startsWith("today:") ? key.slice(6)
        : "YYYY-MM-DD";
      if (moment(previousNow).format(format) !== moment(now).format(format)) return true;
    }
  }
  return false;
}

function timeTemplateKeys(template: string): readonly string[] {
  const keys: string[] = [];
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== "{") continue;
    if (template[index + 1] === "{") { index += 1; continue; }
    const closing = template.indexOf("}", index + 1);
    if (closing === -1) break;
    const key = template.slice(index + 1, closing).trim();
    if (key.startsWith("date:") || key === "now" || key.startsWith("now:") || key === "today" || key.startsWith("today:")) keys.push(key);
    index = closing;
  }
  return keys;
}

function scalarOverrideExists(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== "object";
}

export function trackFileMtime(previous: MtimeMap, file: TFile): MtimeMapUpdate {
  if (!isMarkdownFile(file) || !isFiniteMtime(file.stat.mtime)) {
    return { trackedMtimes: previous, changed: false };
  }

  const path = normalizedMtimePath(file.path);
  const mtime = file.stat.mtime;
  if (previous[path] === mtime) {
    return { trackedMtimes: previous, changed: false };
  }

  return {
    trackedMtimes: {
      ...previous,
      [path]: mtime,
    },
    changed: true,
  };
}

export function pruneTrackedMtimesToFiles(previous: MtimeMap, files: readonly TFile[]): MtimeMapUpdate {
  const currentPaths = new Set(
    files
      .filter((file) => isMarkdownFile(file) && isFiniteMtime(file.stat.mtime))
      .map((file) => normalizedMtimePath(file.path)),
  );
  const trackedMtimes: Record<string, number> = {};
  let changed = false;

  for (const [trackedPath, mtime] of Object.entries(previous)) {
    const normalizedTrackedPath = normalizedMtimePath(trackedPath);
    if (!currentPaths.has(normalizedTrackedPath)) {
      changed = true;
      continue;
    }

    trackedMtimes[normalizedTrackedPath] = mtime;
    if (normalizedTrackedPath !== trackedPath) {
      changed = true;
    }
  }

  if (!changed) {
    return { trackedMtimes: previous, changed: false };
  }

  return { trackedMtimes, changed: true };
}

export function removeTrackedMtimePath(previous: MtimeMap, path: string): MtimeMapUpdate {
  const normalizedPath = normalizedMtimePath(path);
  const descendantPrefix = `${normalizedPath}/`;
  const trackedMtimes: Record<string, number> = {};
  let changed = false;

  for (const [trackedPath, mtime] of Object.entries(previous)) {
    const normalizedTrackedPath = normalizedMtimePath(trackedPath);
    if (normalizedTrackedPath === normalizedPath || normalizedTrackedPath.startsWith(descendantPrefix)) {
      changed = true;
      continue;
    }

    trackedMtimes[normalizedTrackedPath] = mtime;
    if (normalizedTrackedPath !== trackedPath) {
      changed = true;
    }
  }

  if (!changed) {
    return { trackedMtimes: previous, changed: false };
  }

  return { trackedMtimes, changed: true };
}

function isFiniteMtime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function normalizedMtimePath(path: string): string {
  return normalizePath(path).replace(/\/+$/, "");
}

function mtimeMapsEqual(left: MtimeMap, right: MtimeMap): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
