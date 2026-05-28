export interface BatchRowReceipt {
  readonly path: string;
  readonly outcome: "applied" | "skipped" | "failed";
  readonly afterPath?: string;
  readonly transactionId?: string;
  readonly message?: string;
}

export interface BatchReceipt {
  readonly batchId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly status: "completed" | "cancelled" | "stopped";
  readonly total: number;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
  readonly unprocessed: number;
  readonly rows: readonly BatchRowReceipt[];
  readonly truncated: boolean;
}

export const MAX_BATCH_RECEIPT_ROWS = 2_000;
const MAX_BATCH_HISTORY_BYTES = 262_144;

/** Separate, device-local receipts: never retain note contents or frontmatter. */
export function sanitizeBatchHistory(value: unknown, now = Date.now()): readonly BatchReceipt[] {
  if (!Array.isArray(value)) return [];
  const retained: BatchReceipt[] = [];
  let bytes = 2;
  for (const item of value.slice(-20).reverse() as unknown[]) {
    if (!isRecord(item) || typeof item.batchId !== "string"
      || !["completed", "cancelled", "stopped"].includes(String(item.status))
      || ![item.startedAt, item.finishedAt, item.total, item.applied, item.skipped, item.failed, item.unprocessed].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
      || typeof item.finishedAt !== "number" || item.finishedAt < now - 7 * 86_400_000
      || !Array.isArray(item.rows) || typeof item.truncated !== "boolean") continue;
    const rows: BatchRowReceipt[] = [];
    for (const row of item.rows.slice(0, MAX_BATCH_RECEIPT_ROWS) as unknown[]) {
      if (!isRecord(row) || typeof row.path !== "string" || !["applied", "skipped", "failed"].includes(String(row.outcome))
        || [row.afterPath, row.transactionId, row.message].some((field) => field !== undefined && typeof field !== "string")) continue;
      rows.push({ path: row.path, outcome: row.outcome as BatchRowReceipt["outcome"],
        ...(typeof row.afterPath === "string" ? { afterPath: row.afterPath } : {}),
        ...(typeof row.transactionId === "string" ? { transactionId: row.transactionId } : {}),
        ...(typeof row.message === "string" ? { message: row.message } : {}),
      });
    }
    const receipt: BatchReceipt = { batchId: item.batchId, startedAt: Number(item.startedAt), finishedAt: item.finishedAt,
      status: item.status as BatchReceipt["status"], total: Number(item.total), applied: Number(item.applied),
      skipped: Number(item.skipped), failed: Number(item.failed), unprocessed: Number(item.unprocessed), rows,
      truncated: item.truncated || rows.length < item.rows.length };
    if (receipt.applied + receipt.skipped + receipt.failed + receipt.unprocessed !== receipt.total) continue;
    const size = new TextEncoder().encode(JSON.stringify(receipt)).byteLength + 1;
    if (bytes + size > MAX_BATCH_HISTORY_BYTES) continue;
    retained.push(receipt);
    bytes += size;
  }
  return retained.reverse();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
