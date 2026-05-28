import type { CliData } from "obsidian";
import type { RuleRunOn } from "../engine";
import type { ReconciliationDecision } from "./diagnostics";
import { diagnosticSummary } from "./transaction-history";
import { frontmatterDiff } from "./frontmatter-diff";
import type { DryRunPreviewPlan } from "./dry-run-preview";
import type { ReconciliationQueueSnapshot } from "./queue";

const MAX_CLI_DIAGNOSTICS = 200;
const OUTCOMES = new Set([
  "changed", "unchanged", "dry-run", "skipped", "cycle-detected",
  "max-iterations-exceeded", "error", "undone",
]);

export interface CliStatusInput {
  readonly dryRun: boolean;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly settingsReadOnly: boolean;
  readonly settingsRevision: number;
  readonly queue: ReconciliationQueueSnapshot;
  readonly latestDecision: ReconciliationDecision | null;
}

export function formatCliStatus(input: CliStatusInput): string {
  return cliJson({
    status: "ok",
    dryRun: input.dryRun,
    paused: input.paused,
    pauseReason: input.pauseReason,
    settingsReadOnly: input.settingsReadOnly,
    settingsRevision: input.settingsRevision,
    queue: input.queue,
    latestDecision: input.latestDecision === null ? null : cliDecisionSummary(input.latestDecision),
  });
}

export function formatCliDiagnostics(decisions: readonly ReconciliationDecision[], params: CliData): string {
  const limit = parseLimit(params.limit);
  if (limit === null) return cliError(`limit must be an integer from 1 to ${MAX_CLI_DIAGNOSTICS}.`);
  const requestedOutcome = typeof params.outcome === "string" ? params.outcome.trim() : "all";
  if (requestedOutcome !== "all" && !OUTCOMES.has(requestedOutcome)) {
    return cliError(`outcome must be all or one of: ${[...OUTCOMES].join(", ")}.`);
  }
  const filtered = requestedOutcome === "all"
    ? decisions
    : decisions.filter((decision) => decision.outcome === requestedOutcome);
  return cliJson({
    status: "ok",
    outcome: requestedOutcome,
    count: Math.min(limit, filtered.length),
    totalMatching: filtered.length,
    decisions: filtered.slice(-limit).map(cliDecisionSummary),
  });
}

export function parseCliTrigger(value: CliData[string] | undefined): RuleRunOn | null {
  if (value === undefined) return "manual";
  return value === "manual" || value === "live" || value === "sweep" ? value : null;
}

export function formatCliPlan(plan: DryRunPreviewPlan, trigger: RuleRunOn): string {
  const result = plan.result;
  return cliJson({
    status: "ok",
    trigger,
    path: plan.current.path,
    outcome: plan.preview.outcome,
    desiredPath: plan.preview.desiredPath ?? plan.current.path,
    mutationKinds: plan.preview.mutationKinds,
    appliedRuleIds: plan.preview.appliedRuleIds,
    involvedRuleIds: plan.preview.involvedRuleIds,
    iterations: plan.preview.iterations,
    message: plan.preview.message,
    propertyChanges: result === null
      ? []
      : frontmatterDiff(plan.current, result.desired).map((change) => change.property),
  });
}

export function cliError(message: string): string {
  return cliJson({ status: "error", message });
}

function cliDecisionSummary(decision: ReconciliationDecision): Omit<ReconciliationDecision, "beforeFrontmatter" | "afterFrontmatter" | "afterIdentity"> {
  const { afterIdentity: _identity, ...summary } = diagnosticSummary(decision);
  return summary;
}

function parseLimit(value: CliData[string] | undefined): number | null {
  if (value === undefined) return 20;
  if (value === "true" || !/^\d+$/u.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_CLI_DIAGNOSTICS ? limit : null;
}

function cliJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
