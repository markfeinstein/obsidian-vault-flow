import { describe, expect, it, vi } from "vitest";
import { TFile, type App, type PluginManifest } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import { reconcileFileState } from "../../src/engine";
import { applyReconciliationResult, noteStateFromObsidian } from "../../src/obsidian/adapter";
import { captureNoteIdentity } from "../../src/obsidian/note-identity";
import { JOURNAL_STORAGE_KEY, TransactionJournal, type JournalEntry, type PendingNoteMutation } from "../../src/obsidian/transaction-journal";

const pending: PendingNoteMutation = { transactionId: "tx", timestamp: Date.now(), beforePath: "note.md", afterPath: "note.md",
  beforeFrontmatter: { status: "old" }, afterFrontmatter: { status: "new" }, ruleIds: ["test"], iterations: 1, mutationKinds: ["frontmatter"] };
function storage() {
  const data = new Map<string, unknown>();
  return { data, loadLocalStorage: (key: string): unknown => data.get(key) ?? null,
    saveLocalStorage: vi.fn((key: string, value: unknown) => { data.set(key, JSON.parse(JSON.stringify(value)) as unknown); }) };
}
function note(): TFile {
  const file = new TFile(); Object.assign(file, { path: "note.md", basename: "note", extension: "md", stat: { ctime: 1, mtime: 2, size: 4 } }); return file;
}

describe("write-ahead journal persistence", () => {
  it("retains interrupted snapshots across reloads without automatic age pruning", () => {
    const store = storage(); const journal = new TransactionJournal(store);
    journal.begin({ ...pending, timestamp: 0 });
    expect(new TransactionJournal(store).entries()).toMatchObject([{ status: "started", timestamp: 0, beforeFrontmatter: { status: "old" } }]);
  });
  it("marks completed writes, preserving actual snapshots and verified identity", () => {
    const store = storage(); const journal = new TransactionJournal(store);
    journal.begin(pending); journal.complete({ transactionId: "tx", beforePath: "note.md", afterPath: "note.md",
      beforeFrontmatter: { actual: "before" }, afterFrontmatter: { actual: "after" }, afterIdentity: { ctime: 1, mtime: 2, size: 4, sha256: "a".repeat(64) } });
    expect(new TransactionJournal(store).entries()).toMatchObject([{ status: "completed", beforeFrontmatter: { actual: "before" }, afterFrontmatter: { actual: "after" }, transaction: { afterIdentity: { sha256: "a".repeat(64) } } }]);
    journal.acknowledge("tx");
    expect(new TransactionJournal(store).entries()).toEqual([]);
  });
  it("blocks overlapping unresolved writes", () => {
    const journal = new TransactionJournal(storage()); journal.begin(pending);
    expect(() => journal.begin({ ...pending, transactionId: "other" })).toThrow("overlaps");
  });
  it("does not overwrite a journal modified by a different plugin instance", () => {
    const store = storage(); const first = new TransactionJournal(store); const stale = new TransactionJournal(store);
    first.begin(pending);
    expect(() => stale.begin({ ...pending, transactionId: "other", beforePath: "other.md", afterPath: "other.md" })).toThrow("another plugin instance");
    expect(new TransactionJournal(store).entries()).toMatchObject([{ transactionId: "tx" }]);
    expect(stale.entries()).toEqual([]);
  });
  it("does not publish a durable state when saving fails", () => {
    const store = storage(); const journal = new TransactionJournal(store);
    store.saveLocalStorage.mockImplementation(() => { throw new Error("quota"); });
    expect(() => journal.begin(pending)).toThrow("quota");
    expect(journal.entries()).toEqual([]);
    expect(store.data.size).toBe(0);
  });
  it("blocks oversized new writes rather than evicting unresolved recovery records", () => {
    const journal = new TransactionJournal(storage()); journal.begin(pending);
    expect(() => journal.begin({ ...pending, transactionId: "big", beforePath: "big.md", afterPath: "big.md", beforeFrontmatter: { large: "x".repeat(1_048_576) } })).toThrow("1 MiB");
    expect(journal.entries()).toHaveLength(1);
  });
  it.each([{ version: 2, entries: [] }, { version: 1, entries: [{ ...pending, status: "bad" }] }, { version: 1, entries: [{ ...pending, beforePath: "../note.md", status: "started" }] }])("fails closed on corrupt or unsupported journal data", (invalid) => {
    const store = storage(); store.data.set(JOURNAL_STORAGE_KEY, invalid);
    const journal = new TransactionJournal(store);
    expect(journal.blockedReason).not.toBeNull();
    expect(() => journal.begin(pending)).toThrow();
    expect(store.saveLocalStorage).not.toHaveBeenCalled();
  });
});

describe("journal/write boundary", () => {
  it.each([false, true])("persists before property mutation and retains unknown failed outcomes (failure=%s)", async (failure) => {
    const store = storage(); const journal = new TransactionJournal(store);
    const file = note(); const frontmatter: Record<string, unknown> = { status: "old" };
    const app = { vault: { read: async () => "body" }, metadataCache: { getFileCache: () => ({ frontmatter }) },
      fileManager: { processFrontMatter: async (_file: TFile, callback: (value: unknown) => void) => {
        callback(frontmatter);
        expect(journal.entries()).toMatchObject([{ status: "started", beforeFrontmatter: { status: "old" }, afterFrontmatter: { status: "new" } }]);
        if (failure) throw new Error("write interrupted");
      } } } as unknown as App;
    const current = noteStateFromObsidian(file, { frontmatter });
    const result = reconcileFileState({ file: current, rules: [{ id: "test", name: "Test", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "**" }, then: { setProperties: { status: "new" } } }], options: { maxIterations: 10 } });
    if (result.status !== "converged") throw new Error("Expected converged");
    const write = applyReconciliationResult(app, file, current, result, () => {}, (pending) => journal.begin(pending), (transaction) => journal.complete(transaction));
    if (failure) await expect(write).rejects.toThrow("interrupted"); else await write;
    expect(new TransactionJournal(store).entries()[0]?.status).toBe(failure ? "started" : "completed");
  });
  it("does not mutate properties when the write-ahead save fails", async () => {
    const file = note(); const frontmatter: Record<string, unknown> = { status: "old" };
    const app = { vault: { read: async () => "body" }, fileManager: { processFrontMatter: async (_file: TFile, callback: (value: unknown) => void) => { callback(frontmatter); } } } as unknown as App;
    const current = noteStateFromObsidian(file, { frontmatter });
    const result = { status: "converged" as const, desired: { ...current, frontmatter: { status: "new" } }, mutations: [{ kind: "frontmatter" as const, ruleIds: ["r"] }], appliedRuleIds: ["r"], dryRunRuleIds: [], iterations: 1, changed: true };
    await expect(applyReconciliationResult(app, file, current, result, () => {}, () => { throw new Error("journal unavailable"); })).rejects.toThrow("journal unavailable");
    expect(frontmatter).toEqual({ status: "old" });
  });
});

describe("restart inspection and guarded history recovery", () => {
  it.each([false, true])("pauses on restart and never rewrites notes during recovery (newer-edit=%s)", async (changed) => {
    const store = storage(); const file = note(); let body = "body";
    const write = vi.fn(); const rename = vi.fn();
    const app = { ...store, metadataCache: { on: vi.fn() }, vault: { configDir: ".obsidian", on: vi.fn(), getFileByPath: () => file, read: async () => body },
      fileManager: { processFrontMatter: write, renameFile: rename },
      workspace: { on: vi.fn(), onLayoutReady: vi.fn(), getLeavesOfType: () => [] } } as unknown as App;
    const journal = new TransactionJournal(app); journal.begin(pending);
    journal.complete({ transactionId: "tx", beforePath: "note.md", afterPath: "note.md", afterIdentity: await captureNoteIdentity(app, file) });
    if (changed) { body = "newer note"; file.stat.mtime++; }
    const plugin = new VaultFlowPlugin(app, {} as PluginManifest);
    vi.spyOn(plugin, "loadData").mockResolvedValue({ settingsVersion: 4, dryRun: true });
    await plugin.onload();
    expect(plugin.isAutomationPaused()).toBe(true);
    const runtime = plugin as unknown as { journal: TransactionJournal; transactions: unknown[]; restoreRecoveredHistory(entry: JournalEntry): Promise<boolean> };
    const entry = runtime.journal.entries()[0]; if (entry === undefined) throw new Error("Missing pending record");
    expect(await runtime.restoreRecoveredHistory(entry)).toBe(!changed);
    expect(runtime.transactions).toHaveLength(changed ? 0 : 1);
    expect(runtime.journal.entries()).toHaveLength(changed ? 1 : 0);
    expect(plugin.isAutomationPaused()).toBe(true);
    expect(write).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
    plugin.onunload();
  });
});
