import type { ReconciliationDecision } from "./diagnostics";
import type { ReconciliationQueueSnapshot } from "./queue";

export interface VaultFlowStatusInput {
  readonly dryRun: boolean;
  readonly paused?: boolean;
  readonly queue: ReconciliationQueueSnapshot;
  readonly latestDecision: ReconciliationDecision | null;
}

export function formatVaultFlowStatus(input: VaultFlowStatusInput): string {
  return [
    "Vault Flow",
    input.paused === true ? "PAUSED" : input.dryRun ? "dry-run" : "live",
    formatQueueStatus(input.queue),
    formatLatestDecision(input.latestDecision),
  ].join(" • ");
}

function formatQueueStatus(snapshot: ReconciliationQueueSnapshot): string {
  if (snapshot.runningCount > 0 && snapshot.pendingCount > 0) {
    return `running ${snapshot.runningCount}, pending ${snapshot.pendingCount}`;
  }

  if (snapshot.runningCount > 0) {
    return `running ${snapshot.runningCount}`;
  }

  if (snapshot.pendingCount > 0) {
    return `pending ${snapshot.pendingCount}`;
  }

  return "idle";
}

function formatLatestDecision(decision: ReconciliationDecision | null): string {
  if (decision === null) {
    return "last: none";
  }

  if (decision.outcome === "error") {
    return "last: error";
  }

  return `last: ${decision.outcome}`;
}
