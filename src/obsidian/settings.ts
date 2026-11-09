import { compileRuleRegex } from "../engine/rule-regex";
import { compilePathGlob } from "../engine/path-glob";
import { readRuleFixtures } from "../engine/rule-fixtures";
import { normalizePath } from "obsidian";
import type { FrontmatterValue, PlannedMutation, Rule, RuleActionSet, RulePredicate, RuleId, RuleRunOn } from "../engine";
import { cloneDecision, type ReconciliationDecision, type ReconciliationDecisionOutcome } from "./diagnostics";
import { MIN_SWEEP_INTERVAL_MS } from "./periodic-schedule";
import type { MtimeMap } from "./sweep";
import { pruneTransactionHistory } from "./transaction-history";
import type { NoteIdentity } from "./note-identity";
import { sanitizeBatchHistory, type BatchReceipt } from "./batch-history";

export type CollisionPolicy = "skip" | "rename-with-suffix";

export const SETTINGS_SCHEMA_VERSION = 4;

export type RuleStatsMap = Record<string, { matchCount: number; lastMatchAt: number }>;

export interface VaultFlowSettings {
  readonly rules: readonly Rule[];
  readonly debounceMs: number;
  readonly maxIterations: number;
  readonly useRegexSet: boolean;
  readonly maxWritesPerMinute: number;
  readonly maxBatchWrites: number;
  readonly dryRun: boolean;
  readonly collisionPolicy: CollisionPolicy;
  readonly sweepOnStartup: boolean;
  readonly periodicSweepEnabled: boolean;
  readonly sweepIntervalMs: number;
  readonly monitoredFolders: readonly string[];
  /** Glob patterns for files/folders that should never be processed (blocklist). */
  readonly exclusionPatterns: readonly string[];
  /**
   * Frontmatter key that disables Vault Flow processing for a specific note.
   * When this key is present with a truthy value, the note is skipped.
   * Default: "vault-flow-disable"
   */
  readonly disableFrontmatterKey: string;
  readonly trackedMtimes: MtimeMap;
  readonly recentDecisions: readonly ReconciliationDecision[];
  readonly ruleStats: RuleStatsMap;
}

export interface SanitizedVaultFlowSettings {
  readonly settings: VaultFlowSettings;
  readonly sanitized: boolean;
  readonly incompatibleVersion?: number;
  readonly regexErrors?: readonly string[];
  readonly scopeErrors?: readonly string[];
}

export interface VaultFlowRuntimeState {
  readonly trackedMtimes: MtimeMap;
  readonly recentDecisions: readonly ReconciliationDecision[];
  readonly ruleStats: RuleStatsMap;
  /** Optional on old installations; migrated from complete diagnostic snapshots. */
  readonly transactions?: readonly ReconciliationDecision[];
  readonly batches?: readonly BatchReceipt[];
}

export interface SanitizedVaultFlowRuntimeState {
  readonly runtimeState: VaultFlowRuntimeState;
  readonly sanitized: boolean;
}

export const DEFAULT_SETTINGS: VaultFlowSettings = {
  rules: [],
  debounceMs: 500,
  maxIterations: 10,
  useRegexSet: false,
  maxWritesPerMinute: 100,
  maxBatchWrites: 100,
  dryRun: true,
  collisionPolicy: "skip",
  sweepOnStartup: true,
  periodicSweepEnabled: false,
  sweepIntervalMs: 300000,
  monitoredFolders: [],
  exclusionPatterns: [],
  disableFrontmatterKey: "vault-flow-disable",
  trackedMtimes: {},
  recentDecisions: [],
  ruleStats: {},
};

export function sanitizeVaultFlowSettings(data: unknown, defaults: VaultFlowSettings = DEFAULT_SETTINGS): SanitizedVaultFlowSettings {
  if (data === null || data === undefined) {
    return { settings: cloneSettings(defaults), sanitized: false };
  }

  if (!isRecord(data)) {
    return { settings: cloneSettings(defaults), sanitized: true };
  }

  let sanitized = false;
  const settingsSource = isRecord(data.settings) ? data.settings : data;

  if (typeof data.settingsVersion === "number" && Number.isSafeInteger(data.settingsVersion) && data.settingsVersion > SETTINGS_SCHEMA_VERSION) {
    return {
      settings: cloneSettings(defaults),
      sanitized: false,
      incompatibleVersion: data.settingsVersion,
    };
  }
  if (data.settingsVersion !== undefined && data.settingsVersion !== SETTINGS_SCHEMA_VERSION) {
    sanitized = true;
  }

  const debounceMs = readPositiveInteger(settingsSource.debounceMs, defaults.debounceMs);
  if (settingsSource.debounceMs !== undefined && debounceMs !== settingsSource.debounceMs) {
    sanitized = true;
  }

  const useRegexSet = readBoolean(settingsSource.useRegexSet, defaults.useRegexSet);
  if (settingsSource.useRegexSet !== undefined && useRegexSet !== settingsSource.useRegexSet) sanitized = true;
  const maxIterations = readPositiveInteger(settingsSource.maxIterations, defaults.maxIterations);
  if (settingsSource.maxIterations !== undefined && maxIterations !== settingsSource.maxIterations) {
    sanitized = true;
  }

  const maxWritesPerMinute = readWriteLimit(settingsSource.maxWritesPerMinute, defaults.maxWritesPerMinute);
  const maxBatchWrites = readWriteLimit(settingsSource.maxBatchWrites, defaults.maxBatchWrites);
  for (const [key, value] of [["maxWritesPerMinute", maxWritesPerMinute], ["maxBatchWrites", maxBatchWrites]] as const) {
    if (settingsSource[key] !== undefined && settingsSource[key] !== value) sanitized = true;
  }

  const dryRun = readBoolean(settingsSource.dryRun, defaults.dryRun);
  if (settingsSource.dryRun !== undefined && dryRun !== settingsSource.dryRun) {
    sanitized = true;
  }

  const sweepOnStartup = readBoolean(settingsSource.sweepOnStartup, defaults.sweepOnStartup);
  if (settingsSource.sweepOnStartup !== undefined && sweepOnStartup !== settingsSource.sweepOnStartup) {
    sanitized = true;
  }

  const periodicSweepEnabled = readBoolean(settingsSource.periodicSweepEnabled, defaults.periodicSweepEnabled);
  if (settingsSource.periodicSweepEnabled !== undefined && periodicSweepEnabled !== settingsSource.periodicSweepEnabled) {
    sanitized = true;
  }

  const sweepIntervalMs = readSweepIntervalMs(settingsSource.sweepIntervalMs, defaults.sweepIntervalMs);
  if (settingsSource.sweepIntervalMs !== undefined && sweepIntervalMs !== settingsSource.sweepIntervalMs) {
    sanitized = true;
  }

  const collisionPolicy = readCollisionPolicy(settingsSource.collisionPolicy, defaults.collisionPolicy);
  if (settingsSource.collisionPolicy !== undefined && collisionPolicy !== settingsSource.collisionPolicy) {
    sanitized = true;
  }

  const scopeErrors: string[] = [];
  for (const key of ["maxWritesPerMinute", "maxBatchWrites"] as const) {
    const value: unknown = settingsSource[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) scopeErrors.push(key);
  }
  for (const key of ["monitoredFolders", "exclusionPatterns"] as const) {
    const value: unknown = settingsSource[key];
    if (value !== undefined && (!Array.isArray(value)
      || value.some((item: unknown) => typeof item !== "string" || item.trim().length === 0
        || (key === "monitoredFolders" && normalizePath(item).replace(/\/+$/u, "").length === 0)))) {
      scopeErrors.push(key);
    }
  }
  if (settingsSource.disableFrontmatterKey !== undefined && readNonEmptyString(settingsSource.disableFrontmatterKey) === null) {
    scopeErrors.push("disableFrontmatterKey");
  }

  const monitoredFoldersResult = readStringPatternList(settingsSource.monitoredFolders, defaults.monitoredFolders);
  if (monitoredFoldersResult.sanitized) {
    sanitized = true;
  }

  const exclusionPatternsResult = readRawStringList(settingsSource.exclusionPatterns, defaults.exclusionPatterns);
  if (exclusionPatternsResult.sanitized) {
    sanitized = true;
  }

  const disableFrontmatterKey = readNonEmptyString(settingsSource.disableFrontmatterKey) ?? defaults.disableFrontmatterKey;
  if (settingsSource.disableFrontmatterKey !== undefined && disableFrontmatterKey !== settingsSource.disableFrontmatterKey) {
    sanitized = true;
  }

  const regexErrors = [...unsupportedRulePatterns(settingsSource.rules)];
  if (Array.isArray(settingsSource.exclusionPatterns)) {
    for (const [index, pattern] of settingsSource.exclusionPatterns.entries()) {
      if (typeof pattern !== "string") continue;
      try {
        compilePathGlob(pattern.trim(), "iu");
      } catch {
        regexErrors.push(`exclusion pattern ${index + 1}`);
      }
    }
  }
  const rulesResult = sanitizeRules(settingsSource.rules, defaults.rules);
  if (rulesResult.sanitized) {
    sanitized = true;
  }

  const decisionsResult = readDecisions(settingsSource.recentDecisions, defaults.recentDecisions);
  if (decisionsResult.sanitized) {
    sanitized = true;
  }

  const trackedMtimesResult = readMtimeMap(settingsSource.trackedMtimes, defaults.trackedMtimes);
  if (trackedMtimesResult.sanitized) {
    sanitized = true;
  }

  const ruleStatsResult = readRuleStatsMap(settingsSource.ruleStats, defaults.ruleStats);
  if (ruleStatsResult.sanitized) {
    sanitized = true;
  }

  return {
    settings: {
      rules: rulesResult.rules,
      debounceMs,
      maxIterations,
      useRegexSet,
      maxWritesPerMinute,
      maxBatchWrites,
      dryRun,
      collisionPolicy,
      sweepOnStartup,
      periodicSweepEnabled,
      sweepIntervalMs,
      monitoredFolders: monitoredFoldersResult.values,
      exclusionPatterns: exclusionPatternsResult.values,
      disableFrontmatterKey,
      trackedMtimes: trackedMtimesResult.mtimes,
      recentDecisions: decisionsResult.decisions,
      ruleStats: ruleStatsResult.ruleStats,
    },
    sanitized,
    ...(regexErrors.length === 0 ? {} : { regexErrors }),
    ...(scopeErrors.length === 0 ? {} : { scopeErrors }),
  };
}

// Preserve the original settings file on upgrades that encounter regexes the
// linear-time engine cannot execute. Do not silently sanitize and save them away.
function unsupportedRulePatterns(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const errors: string[] = [];
  for (const rule of value as unknown[]) {
    if (!isRecord(rule)) continue;
    const pending: unknown[] = [rule.when];
    const visited = new Set<unknown>();
    while (pending.length > 0) {
      const predicate = pending.pop();
      if (!isRecord(predicate) || visited.has(predicate)) continue;
      visited.add(predicate);
      if (predicate.type === "pathGlob" && typeof predicate.glob === "string") {
        try {
          compilePathGlob(predicate.glob);
        } catch {
          errors.push(typeof rule.id === "string" ? rule.id : "Unnamed rule");
          break;
        }
      }
      if (["basename", "bodyH1", "frontmatterRegex", "contentRegex"].includes(String(predicate.type)) && typeof predicate.pattern === "string") {
        try {
          compileRuleRegex(predicate.pattern, rule.regexLookbehind === true);
        } catch {
          errors.push(typeof rule.id === "string" ? rule.id : "Unnamed rule");
          break;
        }
      }
      if ((predicate.type === "all" || predicate.type === "any") && Array.isArray(predicate.predicates)) {
        for (const child of predicate.predicates as unknown[]) pending.push(child);
      } else if (predicate.type === "not") {
        pending.push(predicate.predicate);
      }
    }
  }
  return errors;
}

export function sanitizeVaultFlowRuntimeState(
  data: unknown,
  fallback: VaultFlowRuntimeState = {
    trackedMtimes: DEFAULT_SETTINGS.trackedMtimes,
    recentDecisions: DEFAULT_SETTINGS.recentDecisions,
    ruleStats: DEFAULT_SETTINGS.ruleStats,
  },
): SanitizedVaultFlowRuntimeState {
  const source = isRecord(data) ? data : fallback;
  const trackedMtimes = readMtimeMap(source.trackedMtimes, fallback.trackedMtimes);
  const recentDecisions = readDecisions(source.recentDecisions, fallback.recentDecisions);
  const ruleStats = readRuleStatsMap(source.ruleStats, fallback.ruleStats);
  const transactions = readDecisions(
    source.transactions,
    fallback.transactions ?? recentDecisions.decisions,
  );
  return {
    runtimeState: {
      trackedMtimes: trackedMtimes.mtimes,
      recentDecisions: recentDecisions.decisions,
      ruleStats: ruleStats.ruleStats,
      transactions: pruneTransactionHistory(transactions.decisions),
      batches: sanitizeBatchHistory(source.batches),
    },
    sanitized: (data !== null && data !== undefined && !isRecord(data))
      || (isRecord(data) && data.transactions === undefined)
      || trackedMtimes.sanitized || recentDecisions.sanitized || ruleStats.sanitized || transactions.sanitized,
  };
}

export interface RulesResult {
  readonly rules: readonly Rule[];
  readonly sanitized: boolean;
}

interface DecisionsResult {
  readonly decisions: readonly ReconciliationDecision[];
  readonly sanitized: boolean;
}

interface MtimeMapResult {
  readonly mtimes: MtimeMap;
  readonly sanitized: boolean;
}

interface RuleStatsResult {
  readonly ruleStats: RuleStatsMap;
  readonly sanitized: boolean;
}

interface StringListResult {
  readonly values: readonly string[];
  readonly sanitized: boolean;
}

function cloneSettings(settings: VaultFlowSettings): VaultFlowSettings {
  return {
    rules: settings.rules.map(cloneRule),
    debounceMs: settings.debounceMs,
    maxIterations: settings.maxIterations,
    useRegexSet: settings.useRegexSet,
    maxWritesPerMinute: settings.maxWritesPerMinute,
    maxBatchWrites: settings.maxBatchWrites,
    dryRun: settings.dryRun,
    collisionPolicy: settings.collisionPolicy,
    sweepOnStartup: settings.sweepOnStartup,
    periodicSweepEnabled: settings.periodicSweepEnabled,
    sweepIntervalMs: settings.sweepIntervalMs,
    monitoredFolders: [...settings.monitoredFolders],
    exclusionPatterns: [...settings.exclusionPatterns],
    disableFrontmatterKey: settings.disableFrontmatterKey,
    trackedMtimes: cloneMtimeMap(settings.trackedMtimes),
    recentDecisions: settings.recentDecisions.map(cloneDecision),
    ruleStats: cloneRuleStatsMap(settings.ruleStats),
  };
}

function readWriteLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

interface TagReadResult {
  readonly value: string;
  readonly sanitized: boolean;
}

interface TagArrayReadResult {
  readonly values: readonly string[];
  readonly sanitized: boolean;
}

function readTag(value: unknown): TagReadResult | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/^#+/u, "");
  if (!isValidObsidianTag(normalized)) {
    return null;
  }
  return { value: normalized, sanitized: normalized !== value };
}

function readTagArray(value: unknown): TagArrayReadResult | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const values: string[] = [];
  const seen = new Set<string>();
  let sanitized = false;
  for (const item of value) {
    const tag = readTag(item);
    if (tag === null) {
      return null;
    }
    const comparisonKey = tag.value.toLocaleLowerCase();
    if (seen.has(comparisonKey)) {
      sanitized = true;
      continue;
    }
    seen.add(comparisonKey);
    values.push(tag.value);
    sanitized ||= tag.sanitized;
  }

  return { values, sanitized };
}

function isValidObsidianTag(tag: string): boolean {
  if (tag.length === 0 || /\s/u.test(tag) || !/[^\p{N}]/u.test(tag)) {
    return false;
  }

  for (const character of tag) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0x7f || /[A-Za-z0-9_/-]/u.test(character)) {
      continue;
    }
    return false;
  }
  return true;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readSweepIntervalMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_SWEEP_INTERVAL_MS ? value : fallback;
}

function readCollisionPolicy(value: unknown, fallback: CollisionPolicy): CollisionPolicy {
  return value === "skip" || value === "rename-with-suffix" ? value : fallback;
}

/** Reads a list of strings, normalizing each as a vault path (for monitored folders). */
function readStringPatternList(value: unknown, fallback: readonly string[]): StringListResult {
  if (value === undefined) {
    return { values: [...fallback], sanitized: false };
  }

  if (!Array.isArray(value)) {
    return { values: [...fallback], sanitized: true };
  }

  const values: string[] = [];
  let sanitized = false;
  for (const item of value) {
    if (typeof item !== "string") {
      sanitized = true;
      continue;
    }

    const normalized = normalizePath(item).replace(/\/+$/u, "");
    if (normalized.length === 0) {
      sanitized = true;
      continue;
    }

    if (!values.includes(normalized)) {
      values.push(normalized);
    } else {
      sanitized = true;
    }
    if (normalized !== item) {
      sanitized = true;
    }
  }

  return { values, sanitized };
}

/** Reads a list of strings as-is (for exclusion patterns, globs, etc.). */
function readRawStringList(value: unknown, fallback: readonly string[]): StringListResult {
  if (value === undefined) {
    return { values: [...fallback], sanitized: false };
  }

  if (!Array.isArray(value)) {
    return { values: [...fallback], sanitized: true };
  }

  const values: string[] = [];
  let sanitized = false;
  for (const item of value) {
    if (typeof item !== "string") {
      sanitized = true;
      continue;
    }

    const trimmed = item.trim();
    if (trimmed.length > 0) {
      values.push(trimmed);
    } else {
      sanitized = true;
    }
  }

  return { values, sanitized };
}

function readMtimeMap(value: unknown, fallback: MtimeMap): MtimeMapResult {
  if (value === undefined) {
    return { mtimes: cloneMtimeMap(fallback), sanitized: false };
  }

  if (!isRecord(value)) {
    return { mtimes: cloneMtimeMap(fallback), sanitized: true };
  }

  const mtimes: Record<string, number> = {};
  let sanitized = false;
  for (const [path, mtime] of Object.entries(value)) {
    if (typeof mtime === "number" && Number.isFinite(mtime) && mtime >= 0) {
      const normalizedPath = normalizePath(path);
      mtimes[normalizedPath] = mtime;
      if (normalizedPath !== path) {
        sanitized = true;
      }
    } else {
      sanitized = true;
    }
  }

  return { mtimes, sanitized };
}

function readDecisions(value: unknown, fallback: readonly ReconciliationDecision[]): DecisionsResult {
  if (value === undefined) {
    return { decisions: fallback.map(cloneDecision), sanitized: false };
  }

  if (!Array.isArray(value)) {
    return { decisions: fallback.map(cloneDecision), sanitized: true };
  }

  const decisions: ReconciliationDecision[] = [];
  let sanitized = false;
  for (const item of value) {
    const decision = readDecision(item);
    if (decision === null) {
      sanitized = true;
    } else {
      decisions.push(decision);
    }
  }

  return { decisions, sanitized };
}

function readDecision(value: unknown): ReconciliationDecision | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.timestamp !== "number"
    || !Number.isFinite(value.timestamp)
    || typeof value.path !== "string"
    || !isDecisionOutcome(value.outcome)
    || !isStringArray(value.appliedRuleIds)
    || !isStringArray(value.involvedRuleIds)
    || !isMutationKindArray(value.mutationKinds)
    || typeof value.iterations !== "number"
    || !Number.isFinite(value.iterations)
  ) {
    return null;
  }

  if (value.desiredPath !== undefined && typeof value.desiredPath !== "string") {
    return null;
  }

  if (value.afterIdentity !== undefined && (!isRecord(value.afterIdentity)
    || ![value.afterIdentity.ctime, value.afterIdentity.mtime, value.afterIdentity.size].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    || typeof value.afterIdentity.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.afterIdentity.sha256))) return null;

  if (value.message !== undefined && typeof value.message !== "string") {
    return null;
  }
  if (value.beforeFrontmatter !== undefined && !isRecord(value.beforeFrontmatter)) {
    return null;
  }
  if (value.afterFrontmatter !== undefined && !isRecord(value.afterFrontmatter)) {
    return null;
  }
  if (value.dryRunRuleIds !== undefined && !isStringArray(value.dryRunRuleIds)) {
    return null;
  }
  if (value.batchId !== undefined && typeof value.batchId !== "string") return null;
  if (value.transactionId !== undefined && typeof value.transactionId !== "string") {
    return null;
  }
  if (value.revertsTransactionId !== undefined && typeof value.revertsTransactionId !== "string") {
    return null;
  }

  return {
    timestamp: value.timestamp,
    path: value.path,
    outcome: value.outcome,
    appliedRuleIds: [...value.appliedRuleIds] as RuleId[],
    involvedRuleIds: [...value.involvedRuleIds] as RuleId[],
    mutationKinds: [...value.mutationKinds] as PlannedMutation["kind"][],
    iterations: value.iterations,
    ...(value.desiredPath === undefined ? {} : { desiredPath: value.desiredPath }),
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.afterIdentity === undefined ? {} : { afterIdentity: { ...(value.afterIdentity as unknown as NoteIdentity) } }),
    ...(value.beforeFrontmatter === undefined ? {} : { beforeFrontmatter: cloneUnknownRecord(value.beforeFrontmatter) }),
    ...(value.afterFrontmatter === undefined ? {} : { afterFrontmatter: cloneUnknownRecord(value.afterFrontmatter) }),
    ...(value.dryRunRuleIds === undefined ? {} : { dryRunRuleIds: [...value.dryRunRuleIds] as RuleId[] }),
    ...(value.batchId === undefined ? {} : { batchId: value.batchId }),
    ...(value.transactionId === undefined ? {} : { transactionId: value.transactionId }),
    ...(value.revertsTransactionId === undefined ? {} : { revertsTransactionId: value.revertsTransactionId }),
  };
}

interface RuleReadResult {
  readonly rule: Rule;
  readonly sanitized: boolean;
}

interface PredicateReadResult {
  readonly predicate: RulePredicate;
  readonly sanitized: boolean;
}

export function sanitizeRules(value: unknown, fallback: readonly Rule[] = []): RulesResult {
  if (value === undefined) {
    return { rules: fallback.map(cloneRule), sanitized: false };
  }

  if (!Array.isArray(value)) {
    return { rules: fallback.map(cloneRule), sanitized: true };
  }

  const rules: Rule[] = [];
  const seenRuleIds = new Set<string>();
  let sanitized = false;

  for (const item of value) {
    const result = readRule(item);
    if (result === null) {
      sanitized = true;
    } else if (seenRuleIds.has(result.rule.id)) {
      sanitized = true;
    } else {
      seenRuleIds.add(result.rule.id);
      rules.push(result.rule);
      if (result.sanitized) {
        sanitized = true;
      }
    }
  }

  return { rules, sanitized };
}

function readRule(value: unknown): RuleReadResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readNonEmptyString(value.id);
  const name = readNonEmptyString(value.name);
  if (
    id === null
    || name === null
    || typeof value.enabled !== "boolean"
    || typeof value.priority !== "number"
    || !Number.isFinite(value.priority)
    || typeof value.order !== "number"
    || !Number.isFinite(value.order)
  ) {
    return null;
  }

  if (value.regexLookbehind !== undefined && typeof value.regexLookbehind !== "boolean") return null;
  const when = readPredicate(value.when, value.regexLookbehind === true);
  if (when === null) {
    return null;
  }

  const then = readActionSet(value.then);
  if (then === null) {
    return null;
  }

  if (value.stopOnMatch !== undefined && typeof value.stopOnMatch !== "boolean") {
    return null;
  }
  const stopOnMatch = value.stopOnMatch;
  const runOn = readRunOn(value.runOn);
  if (runOn === null) {
    return null;
  }
  if (value.dryRun !== undefined && typeof value.dryRun !== "boolean") {
    return null;
  }
  const dryRun = value.dryRun;
  const fixtures = value.fixtures === undefined ? undefined : readRuleFixtures(value.fixtures);
  if (fixtures === null) return null;

  return {
    rule: {
      id,
      name,
      enabled: value.enabled,
      priority: value.priority,
      order: value.order,
      when: when.predicate,
      then: then.actionSet,
      ...(fixtures === undefined ? {} : { fixtures }),
      ...(value.regexLookbehind === true ? { regexLookbehind: true } : {}),
      ...(stopOnMatch === undefined || stopOnMatch === false ? {} : { stopOnMatch }),
      ...(runOn === undefined ? {} : { runOn }),
      ...(dryRun === undefined || dryRun === false ? {} : { dryRun }),
    },
    sanitized: when.sanitized
      || then.sanitized
      || id !== value.id
      || name !== value.name
      || hasUnknownKeys(value, ["id", "name", "enabled", "priority", "order", "when", "then", "stopOnMatch", "runOn", "dryRun", "fixtures", "regexLookbehind"]),
  };
}

function readRunOn(value: unknown): RuleRunOn | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === "always" || value === "live" || value === "sweep" || value === "manual"
    ? value
    : null;
}

function readPredicate(value: unknown, allowLookbehinds = false): PredicateReadResult | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "tag": {
      const tag = readTag(value.tag);
      return tag === null
        ? null
        : { predicate: { type: "tag", tag: tag.value }, sanitized: hasUnknownKeys(value, ["type", "tag"]) || tag.sanitized };
    }
    case "pathGlob": {
      const glob = readNonEmptyString(value.glob);
      if (glob === null) return null;
      try {
        compilePathGlob(glob);
      } catch {
        return null;
      }
      return { predicate: { type: "pathGlob", glob }, sanitized: hasUnknownKeys(value, ["type", "glob"]) || glob !== value.glob };
    }
    case "basename": {
      const pattern = readNonEmptyString(value.pattern);
      if (pattern === null) {
        return null;
      }
      try {
        compileRuleRegex(pattern, allowLookbehinds);
      } catch {
        return null;
      }
      return {
        predicate: { type: "basename", pattern },
        sanitized: hasUnknownKeys(value, ["type", "pattern"]) || pattern !== value.pattern,
      };
    }
    case "frontmatterValue": {
      const property = readNonEmptyString(value.property);
      if (property === null || isUnsafeObjectKey(property)) {
        return null;
      }
      if (!isJsonScalar(value.value)) {
        return null;
      }
      return {
        predicate: { type: "frontmatterValue", property, value: value.value },
        sanitized: hasUnknownKeys(value, ["type", "property", "value"]) || property !== value.property,
      };
    }
    case "frontmatterExists": {
      const property = readNonEmptyString(value.property);
      return property === null || isUnsafeObjectKey(property)
        ? null
        : {
          predicate: { type: "frontmatterExists", property },
          sanitized: hasUnknownKeys(value, ["type", "property"]) || property !== value.property,
        };
    }
    case "frontmatterMissing": {
      const property = readNonEmptyString(value.property);
      return property === null || isUnsafeObjectKey(property)
        ? null
        : {
          predicate: { type: "frontmatterMissing", property },
          sanitized: hasUnknownKeys(value, ["type", "property"]) || property !== value.property,
        };
    }
    case "frontmatterContains": {
      const property = readNonEmptyString(value.property);
      if (property === null || isUnsafeObjectKey(property)) {
        return null;
      }
      const containsValue = typeof value.value === "string" ? value.value : null;
      if (containsValue === null) {
        return null;
      }
      return {
        predicate: { type: "frontmatterContains", property, value: containsValue },
        sanitized: hasUnknownKeys(value, ["type", "property", "value"]) || property !== value.property,
      };
    }
    case "sourceUrl": {
      const property = readNonEmptyString(value.property);
      const host = readNonEmptyString(value.host);
      return property === null || isUnsafeObjectKey(property) || host === null
        ? null
        : {
          predicate: { type: "sourceUrl", property, host },
          sanitized: hasUnknownKeys(value, ["type", "property", "host"])
            || property !== value.property
            || host !== value.host,
        };
    }
    case "fileAge": {
      const field = value.field === "ctime" || value.field === "mtime" ? value.field : null;
      if (field === null) {
        return null;
      }
      const olderThanDays = readOptionalPositiveNumber(value.olderThanDays);
      const newerThanDays = readOptionalPositiveNumber(value.newerThanDays);
      if ((value.olderThanDays !== undefined && olderThanDays === undefined)
        || (value.newerThanDays !== undefined && newerThanDays === undefined)) {
        return null;
      }
      return {
        predicate: {
          type: "fileAge",
          field,
          ...(olderThanDays !== undefined ? { olderThanDays } : {}),
          ...(newerThanDays !== undefined ? { newerThanDays } : {}),
        },
        sanitized: hasUnknownKeys(value, ["type", "field", "olderThanDays", "newerThanDays"]),
      };
    }
    case "bodyH1": {
      const pattern = readNonEmptyString(value.pattern);
      if (pattern === null) {
        return null;
      }
      try {
        compileRuleRegex(pattern, allowLookbehinds);
      } catch {
        return null;
      }
      return {
        predicate: { type: "bodyH1", pattern },
        sanitized: hasUnknownKeys(value, ["type", "pattern"]) || pattern !== value.pattern,
      };
    }
    case "contentContains": {
      const text = typeof value.text === "string" ? value.text : null;
      if (text === null) {
        return null;
      }
      return {
        predicate: { type: "contentContains", text },
        sanitized: hasUnknownKeys(value, ["type", "text"]),
      };
    }
    case "all":
      return readPredicateArray(value.predicates, "all", hasUnknownKeys(value, ["type", "predicates"]), allowLookbehinds);
    case "any":
      return readPredicateArray(value.predicates, "any", hasUnknownKeys(value, ["type", "predicates"]), allowLookbehinds);
    case "not": {
      const result = readPredicate(value.predicate, allowLookbehinds);
      return result === null
        ? null
        : {
          predicate: { type: "not", predicate: result.predicate },
          sanitized: result.sanitized || hasUnknownKeys(value, ["type", "predicate"]),
        };
    }
    case "frontmatterRegex": {
      const property = readNonEmptyString(value.property);
      const pattern = readNonEmptyString(value.pattern);
      if (property === null || isUnsafeObjectKey(property) || pattern === null) {
        return null;
      }
      try {
        compileRuleRegex(pattern, allowLookbehinds);
      } catch {
        return null;
      }
      return {
        predicate: { type: "frontmatterRegex", property, pattern },
        sanitized: hasUnknownKeys(value, ["type", "property", "pattern"])
          || property !== value.property
          || pattern !== value.pattern,
      };
    }
    case "frontmatterDateAge": {
      const property = readNonEmptyString(value.property);
      if (property === null || isUnsafeObjectKey(property)) {
        return null;
      }
      const olderThanDays = readOptionalPositiveNumber(value.olderThanDays);
      const newerThanDays = readOptionalPositiveNumber(value.newerThanDays);
      if ((value.olderThanDays !== undefined && olderThanDays === undefined)
        || (value.newerThanDays !== undefined && newerThanDays === undefined)) {
        return null;
      }
      return {
        predicate: {
          type: "frontmatterDateAge",
          property,
          ...(olderThanDays !== undefined ? { olderThanDays } : {}),
          ...(newerThanDays !== undefined ? { newerThanDays } : {}),
        },
        sanitized: hasUnknownKeys(value, ["type", "property", "olderThanDays", "newerThanDays"])
          || property !== value.property,
      };
    }
    case "wordCount": {
      const moreThan = readOptionalPositiveNumber(value.moreThan);
      const lessThan = readOptionalPositiveNumber(value.lessThan);
      if ((value.moreThan !== undefined && moreThan === undefined)
        || (value.lessThan !== undefined && lessThan === undefined)) {
        return null;
      }
      return {
        predicate: {
          type: "wordCount",
          ...(moreThan !== undefined ? { moreThan } : {}),
          ...(lessThan !== undefined ? { lessThan } : {}),
        },
        sanitized: hasUnknownKeys(value, ["type", "moreThan", "lessThan"]),
      };
    }
    case "tagPrefix": {
      const prefix = readTag(value.prefix);
      return prefix === null
        ? null
        : {
          predicate: { type: "tagPrefix", prefix: prefix.value },
          sanitized: hasUnknownKeys(value, ["type", "prefix"]) || prefix.sanitized,
        };
    }
    case "contentRegex": {
      const pattern = readNonEmptyString(value.pattern);
      if (pattern === null) {
        return null;
      }
      try {
        compileRuleRegex(pattern, allowLookbehinds);
      } catch {
        return null;
      }
      return {
        predicate: { type: "contentRegex", pattern },
        sanitized: hasUnknownKeys(value, ["type", "pattern"]) || pattern !== value.pattern,
      };
    }
    default:
      return null;
  }
}

function readOptionalPositiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPredicateArray(value: unknown, type: "all" | "any", sanitized: boolean, allowLookbehinds = false): PredicateReadResult | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const predicates: RulePredicate[] = [];
  for (const item of value) {
    const result = readPredicate(item, allowLookbehinds);
    if (result === null) {
      return null;
    }
    predicates.push(result.predicate);
    if (result.sanitized) {
      sanitized = true;
    }
  }

  return { predicate: { type, predicates }, sanitized };
}

interface ActionSetReadResult {
  readonly actionSet: RuleActionSet;
  readonly sanitized: boolean;
}

function readActionSet(value: unknown): ActionSetReadResult | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of Object.keys(value)) {
    if (!KNOWN_ACTION_KEYS.has(key)) {
      return null;
    }
  }

  const moveTo = value.moveTo;
  if (moveTo !== undefined && (typeof moveTo !== "string" || !isSafeMoveDestination(moveTo))) {
    return null;
  }

  const moveToKind = value.moveToKind;
  if (moveToKind !== undefined && (moveTo === undefined || (moveToKind !== "auto" && moveToKind !== "folder" && moveToKind !== "file"))) return null;

  const renameTo = value.renameTo;
  if (renameTo !== undefined && typeof renameTo !== "string") {
    return null;
  }

  const addTags = value.addTags === undefined ? undefined : readTagArray(value.addTags);
  if (value.addTags !== undefined && addTags === null) {
    return null;
  }

  const removeTags = value.removeTags === undefined ? undefined : readTagArray(value.removeTags);
  if (value.removeTags !== undefined && removeTags === null) {
    return null;
  }

  const replaceTags = value.replaceTags === undefined ? undefined : readTagArray(value.replaceTags);
  if (value.replaceTags !== undefined && replaceTags === null) {
    return null;
  }

  const setPropertiesValue = value.setProperties;
  let setProperties: Readonly<Record<string, FrontmatterValue>> | undefined;
  if (setPropertiesValue !== undefined) {
    const readSetProperties = readFrontmatterRecord(setPropertiesValue);
    if (readSetProperties === null) {
      return null;
    }
    setProperties = readSetProperties;
  }

  const deleteProperties = value.deleteProperties;
  let safeDeleteProperties: readonly string[] | undefined;
  if (deleteProperties !== undefined) {
    if (!isStringArray(deleteProperties) || deleteProperties.some(isUnsafeObjectKey)) {
      return null;
    }
    safeDeleteProperties = deleteProperties;
  }

  const initPropertiesValue = value.initProperties;
  let initProperties: Readonly<Record<string, FrontmatterValue>> | undefined;
  if (initPropertiesValue !== undefined) {
    const readInitProperties = readFrontmatterRecord(initPropertiesValue);
    if (readInitProperties === null) {
      return null;
    }
    initProperties = readInitProperties;
  }

  const appendToPropertyValue = value.appendToProperty;
  let appendToProperty: Readonly<Record<string, string>> | undefined;
  if (appendToPropertyValue !== undefined) {
    const readAppendToProperty = readStringRecord(appendToPropertyValue);
    if (readAppendToProperty === null) {
      return null;
    }
    appendToProperty = readAppendToProperty;
  }

  return {
    actionSet: {
      ...(moveTo === undefined ? {} : { moveTo }),
      ...(moveToKind === undefined ? {} : { moveToKind }),
      ...(renameTo === undefined ? {} : { renameTo }),
      ...(addTags == null ? {} : { addTags: addTags.values }),
      ...(removeTags == null ? {} : { removeTags: removeTags.values }),
      ...(replaceTags == null ? {} : { replaceTags: replaceTags.values }),
      ...(setProperties === undefined ? {} : { setProperties }),
      ...(safeDeleteProperties === undefined ? {} : { deleteProperties: [...safeDeleteProperties] }),
      ...(initProperties === undefined ? {} : { initProperties }),
      ...(appendToProperty === undefined ? {} : { appendToProperty }),
    },
    sanitized: (addTags?.sanitized ?? false)
      || (removeTags?.sanitized ?? false)
      || (replaceTags?.sanitized ?? false),
  };
}

const KNOWN_ACTION_KEYS = new Set(["moveTo", "moveToKind", "renameTo", "addTags", "removeTags", "replaceTags", "setProperties", "deleteProperties", "initProperties", "appendToProperty"]);

function cloneRule(rule: Rule): Rule {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    order: rule.order,
    when: clonePredicate(rule.when),
    then: cloneActionSet(rule.then),
    ...(rule.fixtures === undefined ? {} : { fixtures: readRuleFixtures(rule.fixtures) ?? [] }),
    ...(rule.regexLookbehind === true ? { regexLookbehind: true } : {}),
    ...(rule.stopOnMatch === undefined || rule.stopOnMatch === false ? {} : { stopOnMatch: rule.stopOnMatch }),
    ...(rule.runOn === undefined ? {} : { runOn: rule.runOn }),
    ...(rule.dryRun === undefined || rule.dryRun === false ? {} : { dryRun: rule.dryRun }),
  };
}

function clonePredicate(predicate: RulePredicate): RulePredicate {
  switch (predicate.type) {
    case "tag":
      return { type: "tag", tag: predicate.tag };
    case "pathGlob":
      return { type: "pathGlob", glob: predicate.glob };
    case "basename":
      return { type: "basename", pattern: predicate.pattern };
    case "frontmatterValue":
      return { type: "frontmatterValue", property: predicate.property, value: predicate.value };
    case "frontmatterExists":
      return { type: "frontmatterExists", property: predicate.property };
    case "frontmatterMissing":
      return { type: "frontmatterMissing", property: predicate.property };
    case "frontmatterContains":
      return { type: "frontmatterContains", property: predicate.property, value: predicate.value };
    case "sourceUrl":
      return { type: "sourceUrl", property: predicate.property, host: predicate.host };
    case "fileAge":
      return {
        type: "fileAge",
        field: predicate.field,
        ...(predicate.olderThanDays !== undefined ? { olderThanDays: predicate.olderThanDays } : {}),
        ...(predicate.newerThanDays !== undefined ? { newerThanDays: predicate.newerThanDays } : {}),
      };
    case "bodyH1":
      return { type: "bodyH1", pattern: predicate.pattern };
    case "contentContains":
      return { type: "contentContains", text: predicate.text };
    case "frontmatterRegex":
      return { type: "frontmatterRegex", property: predicate.property, pattern: predicate.pattern };
    case "frontmatterDateAge":
      return {
        type: "frontmatterDateAge",
        property: predicate.property,
        ...(predicate.olderThanDays !== undefined ? { olderThanDays: predicate.olderThanDays } : {}),
        ...(predicate.newerThanDays !== undefined ? { newerThanDays: predicate.newerThanDays } : {}),
      };
    case "wordCount":
      return {
        type: "wordCount",
        ...(predicate.moreThan !== undefined ? { moreThan: predicate.moreThan } : {}),
        ...(predicate.lessThan !== undefined ? { lessThan: predicate.lessThan } : {}),
      };
    case "tagPrefix":
      return { type: "tagPrefix", prefix: predicate.prefix };
    case "contentRegex":
      return { type: "contentRegex", pattern: predicate.pattern };
    case "all":
      return { type: "all", predicates: predicate.predicates.map(clonePredicate) };
    case "any":
      return { type: "any", predicates: predicate.predicates.map(clonePredicate) };
    case "not":
      return { type: "not", predicate: clonePredicate(predicate.predicate) };
  }
}

function cloneActionSet(actionSet: RuleActionSet): RuleActionSet {
  return {
    ...(actionSet.moveTo === undefined ? {} : { moveTo: actionSet.moveTo }),
    ...(actionSet.moveToKind === undefined ? {} : { moveToKind: actionSet.moveToKind }),
    ...(actionSet.renameTo === undefined ? {} : { renameTo: actionSet.renameTo }),
    ...(actionSet.addTags === undefined ? {} : { addTags: [...actionSet.addTags] }),
    ...(actionSet.removeTags === undefined ? {} : { removeTags: [...actionSet.removeTags] }),
    ...(actionSet.replaceTags === undefined ? {} : { replaceTags: [...actionSet.replaceTags] }),
    ...(actionSet.setProperties === undefined ? {} : { setProperties: cloneFrontmatterRecord(actionSet.setProperties) }),
    ...(actionSet.deleteProperties === undefined ? {} : { deleteProperties: [...actionSet.deleteProperties] }),
    ...(actionSet.initProperties === undefined ? {} : { initProperties: cloneFrontmatterRecord(actionSet.initProperties) }),
    ...(actionSet.appendToProperty === undefined ? {} : { appendToProperty: { ...actionSet.appendToProperty } }),
  };
}

function readFrontmatterRecord(value: unknown): Readonly<Record<string, FrontmatterValue>> | null {
  if (!isRecord(value)) {
    return null;
  }

  const result = Object.create(null) as Record<string, FrontmatterValue>;
  for (const key of Object.keys(value)) {
    if (isUnsafeObjectKey(key)) {
      return null;
    }
    const item = value[key];
    const frontmatterValue = readFrontmatterValue(item);
    if (frontmatterValue === null && item !== null) {
      return null;
    }
    result[key] = frontmatterValue;
  }
  return result;
}

function readFrontmatterValue(value: unknown): FrontmatterValue | null {
  if (isJsonScalar(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const items: (string | number | boolean | null)[] = [];
    for (const item of value as unknown[]) {
      if (!isJsonScalar(item)) {
        return null;
      }
      items.push(item);
    }
    return items;
  }

  if (isRecord(value)) {
    const result = Object.create(null) as Record<string, string | number | boolean | null>;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (!isJsonScalar(item)) {
        return null;
      }
      if (isUnsafeObjectKey(key)) {
        return null;
      }
      result[key] = item;
    }
    return result;
  }

  return null;
}

function cloneMtimeMap(value: MtimeMap): MtimeMap {
  const result = Object.create(null) as Record<string, number>;
  for (const path of Object.keys(value)) {
    result[path] = value[path] ?? 0;
  }
  return result;
}

function cloneRuleStatsMap(value: RuleStatsMap): RuleStatsMap {
  const result = Object.create(null) as RuleStatsMap;
  for (const id of Object.keys(value)) {
    const stats = value[id];
    if (stats !== undefined) {
      result[id] = { matchCount: stats.matchCount, lastMatchAt: stats.lastMatchAt };
    }
  }
  return result;
}

function readRuleStatsMap(value: unknown, fallback: RuleStatsMap): RuleStatsResult {
  if (value === undefined) {
    return { ruleStats: cloneRuleStatsMap(fallback), sanitized: false };
  }

  if (!isRecord(value)) {
    return { ruleStats: cloneRuleStatsMap(fallback), sanitized: true };
  }

  const ruleStats = Object.create(null) as RuleStatsMap;
  let sanitized = false;
  for (const id of Object.keys(value)) {
    const entry = value[id];
    if (isUnsafeObjectKey(id)) {
      sanitized = true;
      continue;
    }
    if (
      isRecord(entry)
      && typeof entry.matchCount === "number"
      && Number.isFinite(entry.matchCount)
      && entry.matchCount >= 0
      && typeof entry.lastMatchAt === "number"
      && Number.isFinite(entry.lastMatchAt)
      && entry.lastMatchAt >= 0
    ) {
      ruleStats[id] = { matchCount: entry.matchCount, lastMatchAt: entry.lastMatchAt };
    } else {
      sanitized = true;
    }
  }

  return { ruleStats, sanitized };
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) {
    return null;
  }
  const result = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item !== "string") {
      return null;
    }
    if (isUnsafeObjectKey(key)) {
      return null;
    }
    result[key] = item;
  }
  return result;
}

function cloneUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof structuredClone === "function") {
    return structuredClone<Record<string, unknown>>(value);
  }
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isRecord(parsed) ? parsed : Object.create(null) as Record<string, unknown>;
}

function cloneFrontmatterRecord(value: Readonly<Record<string, FrontmatterValue>>): Readonly<Record<string, FrontmatterValue>> {
  const result = Object.create(null) as Record<string, FrontmatterValue>;
  for (const key of Object.keys(value)) {
    result[key] = cloneFrontmatterValue(value[key]);
  }
  return result;
}

function cloneFrontmatterValue(value: FrontmatterValue): FrontmatterValue {
  if (Array.isArray(value)) {
    return [...value] as FrontmatterValue;
  }

  if (isRecord(value)) {
    const result = Object.create(null) as Record<string, string | number | boolean | null>;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (isJsonScalar(item)) {
        result[key] = item;
      }
    }
    return result;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: Record<string, unknown>, knownKeys: readonly string[]): boolean {
  return Object.keys(value).some((key) => !knownKeys.includes(key));
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSafeMoveDestination(value: string): boolean {
  return !value.trim().replace(/\\/g, "/").split("/").some((segment) => segment === "..");
}

function isDecisionOutcome(value: unknown): value is ReconciliationDecisionOutcome {
  return value === "changed"
    || value === "unchanged"
    || value === "dry-run"
    || value === "skipped"
    || value === "cycle-detected"
    || value === "max-iterations-exceeded"
    || value === "error"
    || value === "undone";
}

function isMutationKindArray(value: unknown): value is PlannedMutation["kind"][] {
  return Array.isArray(value) && value.every((item) => item === "move" || item === "rename" || item === "frontmatter");
}
