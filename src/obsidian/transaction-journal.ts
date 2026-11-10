import type { App } from "obsidian";
import type { PlannedMutation } from "../engine";
import type { AppliedReconciliationTransaction } from "./adapter";
import { canonicalValue } from "../engine/value-utils";

export const JOURNAL_STORAGE_KEY = "vault-flow:pending-writes:v1";
export const MAX_JOURNAL_BYTES = 1_048_576;
export interface PendingNoteMutation {
  readonly transactionId: string;
  readonly timestamp: number;
  readonly beforePath: string;
  readonly afterPath: string;
  readonly beforeFrontmatter?: Record<string, unknown>;
  readonly afterFrontmatter?: Record<string, unknown>;
  readonly mutationKinds: readonly PlannedMutation["kind"][];
  readonly ruleIds: readonly string[];
  readonly iterations: number;
  readonly revertsTransactionId?: string;
  readonly operation?: "undo";
}
export interface JournalEntry extends PendingNoteMutation {
  readonly status: "started" | "completed";
  readonly transaction?: AppliedReconciliationTransaction;
}
interface JournalEnvelope { readonly version: 1; readonly entries: readonly JournalEntry[] }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Synchronous device-local write-ahead records. Never prune unresolved writes automatically. */
export class TransactionJournal {
  private records: readonly JournalEntry[] = [];
  private expectedStorage = canonicalValue(null);
  public readonly blockedReason: string | null;
  public constructor(private readonly app: Pick<App, "loadLocalStorage" | "saveLocalStorage">) {
    let reason: string | null = null;
    try {
      const stored: unknown = app.loadLocalStorage(JOURNAL_STORAGE_KEY);
      this.expectedStorage = canonicalValue(stored ?? null);
      if (stored !== null && stored !== undefined) {
        if (!record(stored) || stored.version !== 1 || !Array.isArray(stored.entries) || stored.entries.length > 40 || encodedSize(stored) > MAX_JOURNAL_BYTES
          || !stored.entries.every(validEntry) || new Set(stored.entries.map((entry: JournalEntry) => entry.transactionId)).size !== stored.entries.length) {
          reason = "The pending-write journal is unsupported or corrupt; preserve its device-local data before resetting it.";
        } else this.records = clone(stored.entries);
      }
    } catch { reason = "The pending-write journal could not be read. Writes are blocked to preserve recovery data."; }
    this.blockedReason = reason;
  }
  public entries(): readonly JournalEntry[] { return clone(this.records); }
  public begin(pending: PendingNoteMutation): void {
    if (this.blockedReason !== null) throw new Error(this.blockedReason);
    if (this.records.length >= 40) throw new Error("Pending-write journal is full. Inspect and acknowledge interrupted writes first.");
    if (this.records.some((entry) => entry.transactionId === pending.transactionId || [entry.beforePath, entry.afterPath].some((path) => path === pending.beforePath || path === pending.afterPath))) {
      throw new Error("This note overlaps an unresolved write. Inspect its pending-write journal entry first.");
    }
    const entry = { ...clone(pending), status: "started" as const };
    if (!validEntry(entry)) throw new Error("Invalid pending-write snapshot.");
    this.persist([...this.records, entry]);
  }
  public complete(transaction: AppliedReconciliationTransaction): void {
    if (transaction.transactionId === undefined || !this.records.some((entry) => entry.transactionId === transaction.transactionId)) return;
    const { beforeFrontmatter, afterFrontmatter, ...identity } = clone(transaction);
    this.persist(this.records.map((entry) => entry.transactionId === transaction.transactionId ? { ...entry, status: "completed",
      beforeFrontmatter: beforeFrontmatter ?? entry.beforeFrontmatter, afterFrontmatter: afterFrontmatter ?? entry.afterFrontmatter, transaction: identity } : entry));
  }
  public acknowledge(transactionId: string): void {
    if (this.blockedReason !== null) throw new Error(this.blockedReason);
    if (!this.records.some((entry) => entry.transactionId === transactionId)) return;
    this.persist(this.records.filter((entry) => entry.transactionId !== transactionId));
  }
  private persist(entries: readonly JournalEntry[]): void {
    const envelope: JournalEnvelope = { version: 1, entries };
    if (encodedSize(envelope) > MAX_JOURNAL_BYTES) throw new Error("Pending-write journal exceeds its 1 MiB limit. Preserve recovery data before retrying.");
    if (canonicalValue(this.app.loadLocalStorage(JOURNAL_STORAGE_KEY) ?? null) !== this.expectedStorage) throw new Error("The recovery journal changed in another plugin instance. Reload and inspect it before writing.");
    this.app.saveLocalStorage(JOURNAL_STORAGE_KEY, envelope);
    this.expectedStorage = canonicalValue(envelope);
    this.records = entries; // A failed save must not publish a false durable state.
  }
}
function encodedSize(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function safePath(path: unknown): path is string {
  return typeof path === "string" && path.toLowerCase().endsWith(".md") && !path.startsWith("/") && !path.includes("\\") && !path.includes("\u0000")
    && path.split("/").every((part) => part !== ".." && part !== "." && part.length > 0);
}
function validEntry(value: unknown): value is JournalEntry {
  if (!record(value) || typeof value.transactionId !== "string" || !value.transactionId || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)
    || !safePath(value.beforePath) || !safePath(value.afterPath) || (typeof value.status !== "string" || !["started", "completed"].includes(value.status))
    || !Array.isArray(value.ruleIds) || !value.ruleIds.every((id: unknown) => typeof id === "string")
    || !Array.isArray(value.mutationKinds) || !value.mutationKinds.every((kind: unknown) => typeof kind === "string" && ["move", "rename", "frontmatter"].includes(kind))
    || typeof value.iterations !== "number" || !Number.isFinite(value.iterations)
    || [value.beforeFrontmatter, value.afterFrontmatter].some((snapshot) => snapshot !== undefined && !record(snapshot))
    || (value.operation !== undefined && value.operation !== "undo")
    || (value.revertsTransactionId !== undefined && typeof value.revertsTransactionId !== "string")) return false;
  if (value.status === "completed") {
    const transaction = value.transaction;
    if (!record(transaction) || transaction.transactionId !== value.transactionId || transaction.beforePath !== value.beforePath || transaction.afterPath !== value.afterPath
      || [transaction.beforeFrontmatter, transaction.afterFrontmatter].some((snapshot) => snapshot !== undefined && !record(snapshot))) return false;
    if (transaction.afterIdentity !== undefined) {
      const identity = transaction.afterIdentity;
      if (!record(identity) || ![identity.ctime, identity.mtime, identity.size].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) || typeof identity.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(identity.sha256)) return false;
    }
  }
  return true;
}
