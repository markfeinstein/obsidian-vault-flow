import { describe, expect, it, vi } from "vitest";
import { ConfirmationModal, TFile, type App, type PluginManifest } from "obsidian";
import { TestElement } from "../helpers/dom";
import VaultFlowPlugin from "../../src/main";
import { DEFAULT_SETTINGS, sanitizeVaultFlowRuntimeState } from "../../src/obsidian/settings";
import { planReconciliationForFile } from "../../src/obsidian/dry-run-preview";
import { VaultPreviewModal, type VaultPreviewApplyCallbacks, type VaultPreviewEntry } from "../../src/obsidian/vault-preview-modal";
import { sanitizeBatchHistory, type BatchReceipt } from "../../src/obsidian/batch-history";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";
import { WriteSafetyError } from "../../src/obsidian/write-safety";

function latch() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}

async function fixture(callbacks: VaultPreviewApplyCallbacks = {}) {
  const files = Array.from({ length: 3 }, (_, index) => Object.assign(new TFile(), {
    path: `${index}.md`, basename: String(index), extension: "md", stat: { ctime: 1, mtime: 2, size: 0 },
  }));
  const frontmatter = new Map(files.map((file) => [file.path, { status: "todo" }]));
  const app = { metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) }) },
    vault: { getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      read: async (file: TFile) => JSON.stringify(frontmatter.get(file.path)) },
    fileManager: { processFrontMatter: async (file: TFile, fn: (fm: object) => void) => { fn(frontmatter.get(file.path) ?? {}); } },
  } as unknown as App;
  const settings = { ...DEFAULT_SETTINGS, rules: [{ id: "status", name: "status", enabled: true, priority: 0, order: 0,
    when: { type: "pathGlob" as const, glob: "**" }, then: { setProperties: { status: "done" } } }] };
  const entries = await Promise.all(files.map(async (file) => {
    const preview = await planReconciliationForFile(app, file, settings);
    return { path: file.path, propertyChangeCount: 1, preview } satisfies VaultPreviewEntry;
  }));
  const receipts: BatchReceipt[] = [];
  const decisions: ReconciliationDecision[] = [];
  const modal = new VaultPreviewModal(app, entries, { recordBatch: (receipt) => { receipts.push(receipt); },
    recordDecision: (decision) => { decisions.push(decision); }, ...callbacks });
  const apply = (): Promise<void> => (modal as unknown as { applySelected(rows: readonly VaultPreviewEntry[]): Promise<void> }).applySelected(entries);
  return { app, files, frontmatter, entries, receipts, decisions, modal, apply };
}

describe("apply batch controls", () => {
  it("exposes progress and cancellation through selection and native-confirmation UI entry points", async () => {
    const f = await fixture();
    const secondStarted = latch(); const finish = latch();
    let count = 0;
    f.app.fileManager.processFrontMatter = async (file, fn) => {
      fn(f.frontmatter.get(file.path));
      if (++count === 2) { secondStarted.release(); await finish.promise; }
    };
    const root = new TestElement(); f.modal.contentEl = root.asElement(); f.modal.onOpen();
    for (const checkbox of root.all("input")) { checkbox.checked = true; await checkbox.fire("change"); }
    const confirm = vi.spyOn(ConfirmationModal.prototype, "addButton").mockImplementation(function (this: ConfirmationModal, callback) {
      const button = { setButtonText() { return this; }, setCta() { return this; }, setInitialFocus() { return this; },
        onClick(handler: () => void) { handler(); return this; } };
      callback(button as unknown as Parameters<typeof callback>[0]); return this;
    });
    try {
      const applying = root.all("button").find((el) => el.textContent === "Apply selected")?.fire("click");
      await secondStarted.promise;
      const progress = root.all("span").some((el) => el.textContent.includes("1 applied"));
      const cancel = root.all("button").find((el) => el.textContent === "Cancel remaining");
      await cancel?.fire("click");
      finish.release(); await applying;
      expect(progress).toBe(true);
      expect(cancel).toBeDefined();
      expect(f.receipts[0]).toMatchObject({ status: "cancelled", applied: 2, unprocessed: 1 });
    } finally { finish.release(); confirm.mockRestore(); }
  });

  it("finishes a transaction already writing and cancels remaining rows with a durable receipt", async () => {
    const f = await fixture();
    const started = latch(); const finish = latch();
    f.app.fileManager.processFrontMatter = async (file, fn) => {
      fn(f.frontmatter.get(file.path)); started.release(); await finish.promise;
    };
    const applying = f.apply();
    await started.promise;
    f.modal.onClose();
    finish.release();
    await applying;
    expect([...f.frontmatter.values()].map((fm) => fm.status)).toEqual(["done", "todo", "todo"]);
    expect(f.receipts[0]).toMatchObject({ status: "cancelled", total: 3, applied: 1, failed: 0, unprocessed: 2 });
    expect(f.decisions[0]?.batchId).toBe(f.receipts[0]?.batchId);
    expect(f.decisions[0]?.afterIdentity).toBeDefined();
    expect(f.receipts[0]?.rows[0]?.transactionId).toBe(f.decisions[0]?.transactionId);
    expect(sanitizeVaultFlowRuntimeState({ batches: f.receipts }).runtimeState.batches).toEqual(f.receipts);
  });

  it("honors closing while waiting for the mutation lock without writing or counting a failure", async () => {
    const lock = latch();
    const f = await fixture({ runExclusive: async (operation) => { await lock.promise; return operation(); } });
    const applying = f.apply(); f.modal.onClose(); lock.release(); await applying;
    expect([...f.frontmatter.values()].every((fm) => fm.status === "todo")).toBe(true);
    expect(f.receipts[0]).toMatchObject({ status: "cancelled", applied: 0, failed: 0, unprocessed: 3 });
  });

  it("stops the batch when the write circuit trips rather than retrying every remaining row", async () => {
    let attempts = 0;
    const f = await fixture({ onMutationStarted: () => { if (++attempts > 1) throw new WriteSafetyError("limit reached"); } });
    await f.apply();
    expect(attempts).toBe(2);
    expect(f.receipts[0]).toMatchObject({ status: "stopped", applied: 1, failed: 1, unprocessed: 1 });
    expect(f.receipts[0]?.rows[1]?.message).toContain("limit reached");
    expect(f.frontmatter.get("1.md")?.status).toBe("todo");
  });

  it("rejects an oversized selection before writing", async () => {
    const f = await fixture({ maxBatchWrites: () => 2 });
    await expect(f.apply()).rejects.toThrow("at most 2 rows");
    expect(f.receipts).toEqual([]);
    expect(f.decisions).toEqual([]);
  });
});

describe("batch receipt retention and grouped undo", () => {
  it("bounds receipts, drops malformed data, and excludes arbitrary note contents", () => {
    const receipt: BatchReceipt = { batchId: "batch", startedAt: Date.now(), finishedAt: Date.now(), total: 1,
      applied: 1, skipped: 0, failed: 0, unprocessed: 0, status: "completed", rows: [{ path: "A.md", outcome: "applied" }], truncated: false };
    const result = sanitizeBatchHistory(Array.from({ length: 25 }, () => ({ ...receipt, privateBody: "secret" })));
    expect(result).toHaveLength(20);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(sanitizeBatchHistory([{ ...receipt, total: 5 }, { ...receipt, finishedAt: 0 }, { ...receipt, total: NaN }])).toEqual([]);
  });

  it("undoes retained members in reverse order while preserving a replaced member", async () => {
    const files = Array.from({ length: 3 }, (_, index) => Object.assign(new TFile(), {
      path: `Done/${index}.md`, stat: { ctime: index === 2 ? 999 : 1, mtime: 1, size: 0 },
    }));
    const paths: string[] = [];
    const app = { vault: { getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      getAbstractFileByPath: () => null, read: async () => "" },
      fileManager: { renameFile: async (file: TFile, path: string) => { paths.push(path); file.path = path; } },
      saveLocalStorage: () => {}, workspace: { getLeavesOfType: () => [] },
    } as unknown as App;
    const plugin = new VaultFlowPlugin(app, {} as PluginManifest);
    const harness = plugin as unknown as { loaded: boolean; transactions: ReconciliationDecision[]; undoBatch(id: string): Promise<void> };
    harness.loaded = true;
    harness.transactions = files.map((_, index) => ({ timestamp: Date.now(), transactionId: String(index), batchId: "batch",
      path: `${index}.md`, desiredPath: `Done/${index}.md`, outcome: "changed", appliedRuleIds: [], involvedRuleIds: [], mutationKinds: ["move"], iterations: 1,
      afterIdentity: { ctime: 1, mtime: 1, size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    }));
    await harness.undoBatch("batch");
    expect(paths).toEqual(["1.md", "0.md"]);
    expect(files[2]?.path).toBe("Done/2.md");
    expect(harness.transactions).toHaveLength(1);
    plugin.onunload();
  });
});
