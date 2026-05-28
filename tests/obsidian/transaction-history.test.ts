import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, type App, type PluginManifest } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";
import { diagnosticSummary, MAX_UNDO_BYTES, MAX_UNDO_TRANSACTIONS, pruneTransactionHistory } from "../../src/obsidian/transaction-history";
import { DEFAULT_SETTINGS, sanitizeVaultFlowRuntimeState, type VaultFlowSettings } from "../../src/obsidian/settings";

function transaction(id = "tx"): ReconciliationDecision {
  return { timestamp: Date.now(), path: "A.md", desiredPath: "Done/A.md", outcome: "changed", appliedRuleIds: ["r"], involvedRuleIds: [], mutationKinds: ["move", "frontmatter"], iterations: 1, transactionId: id, beforeFrontmatter: { status: "before" }, afterFrontmatter: { status: "after" } };
}
interface RuntimePlugin {
  loaded: boolean; settingsReadOnly: boolean; settings: VaultFlowSettings; transactions: readonly ReconciliationDecision[];
  runtimeSaveFailed: boolean;
  recordDecision(decision: ReconciliationDecision): Promise<void>;
  saveRuntimeStateNow(): void;
  trackSweepMtime(file: TFile): void;
  flushTrackedMtimeCache(): void;
  onload(): Promise<void>;
  onunload(): void;
}
function plugin(app: Partial<App> = {}): RuntimePlugin {
  return new VaultFlowPlugin({ saveLocalStorage: () => {}, workspace: { getLeavesOfType: () => [] }, ...app } as App, {} as PluginManifest) as unknown as RuntimePlugin;
}

describe("independent transaction retention", () => {
  afterEach(() => vi.useRealTimers());

  it("loads the journal without exposing snapshots through plugin settings", async () => {
    const original = transaction();
    const p = plugin({
      loadLocalStorage: () => ({ trackedMtimes: {}, ruleStats: {}, recentDecisions: [original], transactions: [original] }),
      metadataCache: { on: vi.fn() } as unknown as App["metadataCache"],
      vault: { on: vi.fn() } as unknown as App["vault"],
      workspace: { on: vi.fn(), onLayoutReady: vi.fn() } as unknown as App["workspace"],
    });
    await p.onload();
    expect(p.transactions).toEqual([original]);
    expect("transactions" in p.settings).toBe(false);
    expect(p.settings.recentDecisions[0]?.beforeFrontmatter).toBeUndefined();
    p.onunload();
  });

  it("retains undo candidates through 2,000 unchanged diagnostics", async () => {
    const p = plugin();
    await p.recordDecision(transaction());
    for (let index = 0; index < 2_000; index += 1) {
      await p.recordDecision({ ...diagnosticSummary(transaction()), outcome: "unchanged", transactionId: undefined });
    }
    expect(p.settings.recentDecisions).toHaveLength(2_000);
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0]?.beforeFrontmatter).toEqual({ status: "before" });
    expect(p.settings.recentDecisions.every((decision) => decision.beforeFrontmatter === undefined)).toBe(true);
  });

  it("bounds count and UTF-8 serialized bytes, and removes undone transactions", () => {
    const transactions = Array.from({ length: MAX_UNDO_TRANSACTIONS + 20 }, (_, index) => transaction(String(index)));
    expect(pruneTransactionHistory(transactions)).toHaveLength(MAX_UNDO_TRANSACTIONS);
    const large = Array.from({ length: 20 }, (_, index) => ({ ...transaction(String(index)), beforeFrontmatter: { text: "😀".repeat(25_000) } }));
    const retained = pruneTransactionHistory(large);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(large.length);
    expect(new TextEncoder().encode(JSON.stringify(retained)).byteLength).toBeLessThanOrEqual(MAX_UNDO_BYTES);
    expect(pruneTransactionHistory([transaction(), { ...transaction(), outcome: "undone", revertsTransactionId: "tx" }])).toEqual([]);
  });

  it("migrates legacy snapshots and reloads the independent journal", () => {
    const original = transaction();
    const legacy = { trackedMtimes: {}, ruleStats: {}, recentDecisions: [original] };
    const migrated = sanitizeVaultFlowRuntimeState(legacy);
    expect(migrated.runtimeState.transactions).toEqual([original]);
    const stored = { ...migrated.runtimeState, recentDecisions: [] };
    expect(sanitizeVaultFlowRuntimeState(stored).runtimeState.transactions).toEqual(migrated.runtimeState.transactions);
  });

  it("reports persistence failure state without blocking reconciliation", () => {
    const saveLocalStorage = vi.fn<() => void>(() => { throw new Error("quota"); });
    const p = plugin({ saveLocalStorage });
    expect(() => p.saveRuntimeStateNow()).not.toThrow();
    expect(p.runtimeSaveFailed).toBe(true);
    p.saveRuntimeStateNow();
    expect(saveLocalStorage).toHaveBeenCalledTimes(2);
    saveLocalStorage.mockImplementation(() => {});
    p.saveRuntimeStateNow();
    expect(p.runtimeSaveFailed).toBe(false);
    p.settingsReadOnly = true;
    p.saveRuntimeStateNow();
    expect(saveLocalStorage).toHaveBeenCalledTimes(3);
  });

  it("batches mtime snapshots and diagnostics refreshes", async () => {
    vi.useFakeTimers();
    const getLeavesOfType = vi.fn(() => []);
    const p = plugin({ workspace: { getLeavesOfType } as unknown as App["workspace"] });
    p.loaded = true;
    p.settings = { ...DEFAULT_SETTINGS, trackedMtimes: {} };
    const initial = p.settings.trackedMtimes;
    for (let index = 0; index < 500; index += 1) {
      p.trackSweepMtime(Object.assign(new TFile(), { path: `${index}.md`, stat: { mtime: index } }));
    }
    expect(p.settings.trackedMtimes).toBe(initial);
    p.flushTrackedMtimeCache();
    expect(Object.keys(p.settings.trackedMtimes)).toHaveLength(500);
    for (let index = 0; index < 50; index += 1) await p.recordDecision({ ...transaction(), outcome: "unchanged" });
    expect(getLeavesOfType).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);
    expect(getLeavesOfType).toHaveBeenCalledTimes(1);
    p.onunload();
  });
});
