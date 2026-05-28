import type { PlannedMutation, RuleId } from "../engine";
import type { NoteIdentity } from "./note-identity";

export type ReconciliationDecisionOutcome = "changed" | "unchanged" | "dry-run" | "skipped" | "cycle-detected" | "max-iterations-exceeded" | "error" | "undone";
export type DiagnosticLogOutcomeFilter = ReconciliationDecisionOutcome | "all";

export const DIAGNOSTIC_LOG_OUTCOME_FILTERS: readonly DiagnosticLogOutcomeFilter[] = [
  "all",
  "changed",
  "unchanged",
  "dry-run",
  "skipped",
  "cycle-detected",
  "max-iterations-exceeded",
  "error",
  "undone",
];

export interface ReconciliationDecision {
  readonly timestamp: number;
  readonly path: string;
  readonly outcome: ReconciliationDecisionOutcome;
  readonly appliedRuleIds: readonly RuleId[];
  readonly involvedRuleIds: readonly RuleId[];
  readonly mutationKinds: readonly PlannedMutation["kind"][];
  readonly iterations: number;
  readonly desiredPath?: string;
  readonly message?: string;
  readonly beforeFrontmatter?: Record<string, unknown>;
  readonly afterFrontmatter?: Record<string, unknown>;
  readonly dryRunRuleIds?: readonly RuleId[];
  readonly transactionId?: string;
  readonly revertsTransactionId?: string;
  readonly afterIdentity?: NoteIdentity;
  readonly batchId?: string;
}

let transactionSequence = 0;

export function createTransactionId(timestamp: number, path: string): string {
  transactionSequence += 1;
  const pathHash = [...path].reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16_777_619), 2_166_136_261) >>> 0;
  return `${timestamp.toString(36)}-${transactionSequence.toString(36)}-${pathHash.toString(36)}`;
}

export interface DiagnosticLogEntry {
  readonly title: string;
  readonly details: readonly string[];
}

export function appendDecisionLog(
  existing: readonly ReconciliationDecision[],
  decision: ReconciliationDecision,
  limit: number,
): readonly ReconciliationDecision[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return [...existing, cloneDecision(decision)].slice(-safeLimit);
}

export function latestDecisionForPath(
  decisions: readonly ReconciliationDecision[],
  path: string,
): ReconciliationDecision | null {
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    if (decisions[index].path === path || decisions[index].desiredPath === path) {
      return decisions[index];
    }
  }

  return null;
}

export function formatDecisionForNotice(decision: ReconciliationDecision | null, path: string): string {
  if (decision === null) {
    return `Vault Flow has no recent reconciliation decision for ${path}.`;
  }

  const ruleIds = decisionRuleIds(decision);
  const rules = ruleIds.length > 0 ? ` Rules: ${ruleIds.join(", ")}.` : "";
  const mutations = decision.mutationKinds.length > 0 ? ` Mutations: ${decision.mutationKinds.join(", ")}.` : "";
  const desiredPath = decision.desiredPath !== undefined && decision.desiredPath !== decision.path
    ? ` Desired path: ${decision.desiredPath}.`
    : "";
  const message = decision.message !== undefined && decision.message.length > 0 ? ` ${decision.message}` : "";
  const frontmatter = decision.beforeFrontmatter !== undefined || decision.afterFrontmatter !== undefined
    ? " Frontmatter changed."
    : "";

  return `Vault Flow last decision for ${path}: ${decision.outcome}.${rules}${mutations}${desiredPath}${frontmatter}${message}`;
}

export function formatRecentDecisionLogEntries(
  decisions: readonly ReconciliationDecision[],
  limit: number,
  outcomeFilter: DiagnosticLogOutcomeFilter = "all",
): readonly DiagnosticLogEntry[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return filterDecisionsByOutcome(decisions, outcomeFilter)
    .slice(-safeLimit)
    .reverse()
    .map(formatDecisionLogEntry);
}

export function filterDecisionsByOutcome(
  decisions: readonly ReconciliationDecision[],
  outcomeFilter: DiagnosticLogOutcomeFilter,
): readonly ReconciliationDecision[] {
  if (outcomeFilter === "all") {
    return decisions;
  }

  return decisions.filter((decision) => decision.outcome === outcomeFilter);
}

export function isDiagnosticLogOutcomeFilter(value: string): value is DiagnosticLogOutcomeFilter {
  return DIAGNOSTIC_LOG_OUTCOME_FILTERS.some((filter) => filter === value);
}

export function formatDiagnosticLogOutcomeFilterLabel(outcomeFilter: DiagnosticLogOutcomeFilter): string {
  if (outcomeFilter === "all") {
    return "All outcomes";
  }

  return outcomeFilter;
}

export function formatDecisionLogEntry(decision: ReconciliationDecision): DiagnosticLogEntry {
  const details: string[] = [`Path: ${decision.path}`];

  if (decision.desiredPath !== undefined && decision.desiredPath !== decision.path) {
    details.push(`Desired path: ${decision.desiredPath}`);
  }

  const ruleIds = decisionRuleIds(decision);
  if (ruleIds.length > 0) {
    details.push(`Rules: ${ruleIds.join(", ")}`);
  }

  if (decision.mutationKinds.length > 0) {
    details.push(`Mutations: ${decision.mutationKinds.join(", ")}`);
  }

  details.push(`Iterations: ${decision.iterations}`);

  if (decision.message !== undefined && decision.message.length > 0) {
    details.push(decision.message);
  }

  if (decision.beforeFrontmatter !== undefined || decision.afterFrontmatter !== undefined) {
    details.push("Frontmatter snapshot available");
  }

  return {
    title: `${formatTimestamp(decision.timestamp)} — ${decision.outcome}`,
    details,
  };
}

export function cloneDecision(decision: ReconciliationDecision): ReconciliationDecision {
  const cloneRecord = (value: Record<string, unknown>): Record<string, unknown> => {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  };

  return {
    timestamp: decision.timestamp,
    path: decision.path,
    outcome: decision.outcome,
    appliedRuleIds: [...decision.appliedRuleIds],
    involvedRuleIds: [...decision.involvedRuleIds],
    mutationKinds: [...decision.mutationKinds],
    iterations: decision.iterations,
    ...(decision.desiredPath === undefined ? {} : { desiredPath: decision.desiredPath }),
    ...(decision.message === undefined ? {} : { message: decision.message }),
    ...(decision.beforeFrontmatter === undefined ? {} : { beforeFrontmatter: cloneRecord(decision.beforeFrontmatter) }),
    ...(decision.afterFrontmatter === undefined ? {} : { afterFrontmatter: cloneRecord(decision.afterFrontmatter) }),
    ...(decision.dryRunRuleIds === undefined ? {} : { dryRunRuleIds: [...decision.dryRunRuleIds] }),
    ...(decision.afterIdentity === undefined ? {} : { afterIdentity: { ...decision.afterIdentity } }),
    ...(decision.batchId === undefined ? {} : { batchId: decision.batchId }),
    ...(decision.transactionId === undefined ? {} : { transactionId: decision.transactionId }),
    ...(decision.revertsTransactionId === undefined ? {} : { revertsTransactionId: decision.revertsTransactionId }),
  };
}

function decisionRuleIds(decision: ReconciliationDecision): readonly RuleId[] {
  return decision.appliedRuleIds.length > 0 ? decision.appliedRuleIds : decision.involvedRuleIds;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(timestamp);
}
