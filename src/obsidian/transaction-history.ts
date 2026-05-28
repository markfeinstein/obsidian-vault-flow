import type { ReconciliationDecision } from "./diagnostics";

export const MAX_UNDO_TRANSACTIONS = 100;
export const MAX_UNDO_BYTES = 1_048_576;
export const UNDO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Only live undo candidates belong here; noisy diagnostic decisions cannot evict them. */
export function pruneTransactionHistory(decisions: readonly ReconciliationDecision[], now = Date.now()): readonly ReconciliationDecision[] {
  const reverted = new Set(decisions.filter((decision) => decision.outcome === "undone").map((decision) => decision.revertsTransactionId));
  const candidates = decisions.filter((decision) => decision.outcome === "changed"
    && decision.timestamp >= now - UNDO_MAX_AGE_MS
    && (decision.transactionId === undefined || !reverted.has(decision.transactionId))
    && (decision.beforeFrontmatter !== undefined || (decision.desiredPath !== undefined && decision.desiredPath !== decision.path)));
  const retained: ReconciliationDecision[] = [];
  let bytes = 2; // JSON array brackets, including UTF-8 encoding rather than UTF-16 length.
  const encoder = new TextEncoder();
  for (const decision of candidates.slice(-MAX_UNDO_TRANSACTIONS).reverse()) {
    const size = encoder.encode(JSON.stringify(decision)).byteLength + (retained.length > 0 ? 1 : 0);
    if (bytes + size > MAX_UNDO_BYTES) continue;
    retained.push(decision);
    bytes += size;
  }
  return retained.reverse();
}

export function diagnosticSummary(decision: ReconciliationDecision): ReconciliationDecision {
  const { beforeFrontmatter: _before, afterFrontmatter: _after, ...summary } = decision;
  return summary;
}
