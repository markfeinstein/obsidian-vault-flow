import type { Frontmatter, NoteState, ReconciliationResult, Rule, RuleRunOn } from "./types";
import { reconcileFileState } from "./reconcile";
import { canonicalValue, normalizeRawTags } from "./value-utils";

export interface RuleFixture {
  readonly name: string;
  readonly note: {
    readonly path: string;
    readonly frontmatter?: Frontmatter;
    readonly tags?: readonly string[];
    readonly body?: string;
    readonly h1?: string;
    readonly ctime?: number;
    readonly mtime?: number;
  };
  readonly expected: {
    readonly path?: string;
    /** A subset of properties expected in the result. */
    readonly frontmatter?: Frontmatter;
    readonly absentProperties?: readonly string[];
    readonly changed?: boolean;
    readonly status?: ReconciliationResult["status"];
  };
  readonly now?: number;
  readonly triggerContext?: RuleRunOn;
}
export interface RuleFixtureResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const scalar = (value: unknown): boolean => value === null || typeof value === "string" || typeof value === "boolean" || finite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
function frontmatter(value: unknown): boolean {
  return record(value) && Object.entries(value).every(([key, item]) => !["__proto__", "constructor", "prototype"].includes(key)
    && (scalar(item) || (Array.isArray(item) && item.every(scalar)) || (record(item) && Object.entries(item).every(([child, value]) => !["__proto__", "constructor", "prototype"].includes(child) && scalar(value)))));
}

/** Reject malformed/oversized fixtures, rather than silently weakening assertions. */
export function readRuleFixtures(value: unknown): readonly RuleFixture[] | null {
  try {
    if (!Array.isArray(value) || value.length > 20 || JSON.stringify(value).length > 200_000) return null;
    for (const item of value as unknown[]) {
      if (!record(item) || !keys(item, ["name", "note", "expected", "now", "triggerContext"]) || typeof item.name !== "string" || !item.name.trim() || !record(item.note) || !record(item.expected)) return null;
      const note = item.note, expected = item.expected;
      if (!keys(note, ["path", "frontmatter", "tags", "body", "h1", "ctime", "mtime"]) || typeof note.path !== "string" || !note.path.endsWith(".md") || note.path.split("/").some((part) => part === "..")) return null;
      if (note.frontmatter !== undefined && !frontmatter(note.frontmatter)) return null;
      if (note.tags !== undefined && !strings(note.tags)) return null;
      if (note.body !== undefined && typeof note.body !== "string") return null;
      if (note.h1 !== undefined && typeof note.h1 !== "string") return null;
      if ([note.ctime, note.mtime, item.now].some((time) => time !== undefined && !finite(time))) return null;
      if (item.triggerContext !== undefined && (typeof item.triggerContext !== "string" || !["always", "live", "sweep", "manual"].includes(item.triggerContext))) return null;
      if (!keys(expected, ["path", "frontmatter", "absentProperties", "changed", "status"]) || Object.keys(expected).length === 0) return null;
      if (expected.path !== undefined && typeof expected.path !== "string") return null;
      if (expected.frontmatter !== undefined && !frontmatter(expected.frontmatter)) return null;
      if (expected.absentProperties !== undefined && !strings(expected.absentProperties)) return null;
      if (expected.changed !== undefined && typeof expected.changed !== "boolean") return null;
      if (expected.status !== undefined && (typeof expected.status !== "string" || !["converged", "cycle-detected", "max-iterations-exceeded"].includes(expected.status))) return null;
    }
    // JSON was validated recursively above; detach editor/import inputs from settings.
    return JSON.parse(JSON.stringify(value)) as RuleFixture[];
  } catch { return null; }
}

export function runRuleFixtures(rule: Rule, maxIterations = 10): readonly RuleFixtureResult[] {
  return (rule.fixtures ?? []).map((fixture) => {
    const path = fixture.note.path;
    const rawTags = normalizeRawTags(fixture.note.frontmatter?.tags);
    const fmTags = Array.isArray(rawTags) ? (rawTags as unknown[]).filter((tag): tag is string => typeof tag === "string") : [];
    const note: NoteState = {
      path, basename: path.slice(path.lastIndexOf("/") + 1, -3), extension: "md",
      frontmatter: fixture.note.frontmatter ?? {}, tags: [...(fixture.note.tags ?? []), ...fmTags],
      ...(fixture.note.body === undefined ? {} : { bodyContent: fixture.note.body }),
      ...(fixture.note.h1 === undefined ? {} : { bodyH1: fixture.note.h1 }),
      stat: { ctime: fixture.note.ctime ?? 0, mtime: fixture.note.mtime ?? 0 },
    };
    const result = reconcileFileState({ file: note, rules: [{ ...rule, enabled: true }], options: { now: fixture.now ?? 0, triggerContext: fixture.triggerContext ?? "manual", maxIterations } });
    const failures: string[] = [];
    if (fixture.expected.status !== undefined && result.status !== fixture.expected.status) failures.push(`status: expected ${fixture.expected.status}, got ${result.status}`);
    const changed = result.status === "converged" ? result.changed : undefined;
    if (fixture.expected.changed !== undefined && changed !== fixture.expected.changed) failures.push(`changed: expected ${fixture.expected.changed}, got ${changed ?? result.status}`);
    const desired = result.status === "converged" ? result.desired : undefined;
    if (fixture.expected.path !== undefined && desired?.path !== fixture.expected.path) failures.push(`path: expected ${fixture.expected.path}, got ${desired?.path ?? result.status}`);
    for (const [key, value] of Object.entries(fixture.expected.frontmatter ?? {})) {
      if (canonicalValue(desired?.frontmatter[key]) !== canonicalValue(value)) failures.push(`property “${key}” did not match`);
    }
    for (const key of fixture.expected.absentProperties ?? []) if (desired === undefined || Object.prototype.hasOwnProperty.call(desired.frontmatter, key)) failures.push(`property “${key}” must be absent`);
    return { name: fixture.name, passed: failures.length === 0, failures };
  });
}
