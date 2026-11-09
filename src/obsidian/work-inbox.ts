import type { RuleRunOn } from "../engine";
import type { ReconciliationDecision, WorkIssueKind } from "./diagnostics";
import type { JournalEntry } from "./transaction-journal";

export const MAX_WORK_INBOX_ITEMS = 500;
export interface WorkInboxItem {
  readonly key: string;
  readonly path: string;
  readonly timestamp: number;
  readonly kind: WorkIssueKind;
  readonly message: string;
  readonly triggerContexts: readonly RuleRunOn[];
  readonly recovery: boolean;
}

/** A bounded view of unresolved recent work, not another persistent job queue.
 * Structured issue kinds are presentation only: no message or stored diagnostic
 * ever authorizes replay of a mutation. Replanning always opens a fresh preview.
 */
export function buildWorkInbox(decisions: readonly ReconciliationDecision[], journal: readonly JournalEntry[], waitingForMetadata: readonly string[] = []): readonly WorkInboxItem[] {
  const items: WorkInboxItem[] = [];
  const recoveryPaths = new Set<string>();
  const included = new Set<string>();
  for (const entry of journal.slice(-40).reverse()) {
    recoveryPaths.add(entry.beforePath); recoveryPaths.add(entry.afterPath);
    included.add(entry.afterPath);
    items.push({ key: entry.transactionId, path: entry.afterPath, timestamp: entry.timestamp, kind: "mutation", recovery: true,
      triggerContexts: ["manual"], message: `${entry.status} pending-write snapshot: ${entry.beforePath} → ${entry.afterPath}. Inspect recovery; no automatic retry or rollback.` });
  }
  const seen = new Map<string, Set<RuleRunOn>>();
  for (const decision of decisions.slice(-2_000).reverse()) {
    if (items.length >= MAX_WORK_INBOX_ITEMS) break;
    const contexts = decision.triggerContexts ?? ["manual"];
    const covered = seen.get(decision.path) ?? new Set<RuleRunOn>();
    const uncovered = contexts.filter((context) => !covered.has(context));
    for (const context of contexts) covered.add(context);
    seen.set(decision.path, covered);
    const failed = decision.issueKind !== undefined || ["error", "cycle-detected", "max-iterations-exceeded"].includes(decision.outcome);
    if (!failed) {
      if (decision.desiredPath !== undefined) {
        const destination = seen.get(decision.desiredPath) ?? new Set<RuleRunOn>();
        for (const context of contexts) destination.add(context);
        seen.set(decision.desiredPath, destination);
      }
      continue;
    }
    if (uncovered.length === 0 || recoveryPaths.has(decision.path)) continue;
    included.add(decision.path);
    items.push({ key: `${decision.timestamp}:${decision.path}:${uncovered.join(",")}`, path: decision.path, timestamp: decision.timestamp,
      kind: decision.issueKind ?? "planning", message: decision.message ?? decision.outcome, recovery: false,
      triggerContexts: uncovered });
  }
  for (const path of waitingForMetadata) {
    if (items.length >= MAX_WORK_INBOX_ITEMS) break;
    if (included.has(path) || recoveryPaths.has(path)) continue;
    included.add(path);
    items.push({ key: `metadata:${path}`, path, timestamp: 0, kind: "metadata", recovery: false,
      triggerContexts: ["sweep"], message: "Waiting for Obsidian metadata before the pending sweep can evaluate this note." });
  }
  return items;
}
