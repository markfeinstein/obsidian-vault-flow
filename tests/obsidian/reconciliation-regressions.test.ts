import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, type App, type CachedMetadata, type PluginManifest } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import { reconcileFileState, type Rule } from "../../src/engine";
import { applyReconciliationResult, noteStateFromObsidian } from "../../src/obsidian/adapter";
import { ReconciliationQueue } from "../../src/obsidian/queue";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";

function file(): TFile {
  const value = new TFile();
  Object.assign(value, { path: "Inbox/note.md", basename: "note", extension: "md", stat: { ctime: 1, mtime: 1, size: 0 } });
  return value;
}
const rule: Rule = { id: "test", name: "Test", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "trigger" }, then: { setProperties: { review: true } } };
afterEach(() => { vi.useRealTimers(); });

describe("reconciliation regressions", () => {
  it("stops after three pre-apply read failures, with retry backoff", async () => {
    vi.useFakeTimers();
    const target = file(); let reads = 0;
    const decisions: ReconciliationDecision[] = [];
    const app = { metadataCache: { getFileCache: () => ({}) }, vault: { cachedRead: async () => {
      if (++reads % 2 === 0) throw new Error("Pre-apply unavailable");
      return "trigger";
    } }, fileManager: {} } as unknown as App;
    const queue = new ReconciliationQueue(app, () => ({ debounceMs: 10, maxIterations: 10, dryRun: false, collisionPolicy: "skip", rules: [rule] }),
      { recordDecision: (decision) => { decisions.push(decision); } });
    queue.enqueue(target, "manual");
    await vi.advanceTimersByTimeAsync(20);
    expect(decisions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(decisions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(decisions.map((decision) => decision.outcome)).toEqual(["skipped", "skipped", "error"]);
    expect(reads).toBe(6);
    expect(queue.snapshot()).toEqual({ pendingCount: 0, runningCount: 0 });
    queue.clear();
  });

  it.each([[], null, ""])("persists deletion of empty tags: %s", async (tags) => {
    const target = file(); const frontmatter: Record<string, unknown> = { tags };
    const current = noteStateFromObsidian(target, { frontmatter });
    const result = reconcileFileState({ file: current, rules: [{ ...rule, when: { type: "pathGlob", glob: "**" }, then: { deleteProperties: ["tags"] } }], options: { maxIterations: 10 } });
    expect(result.status).toBe("converged");
    if (result.status !== "converged") return;
    const app = { vault: { read: async () => "" }, fileManager: { processFrontMatter: async (_file: TFile, callback: (value: Record<string, unknown>) => void) => { callback(frontmatter); } } } as unknown as App;
    await applyReconciliationResult(app, target, current, result);
    expect(frontmatter).not.toHaveProperty("tags");
    const next = reconcileFileState({ file: noteStateFromObsidian(target, { frontmatter }), rules: [{ ...rule, when: { type: "pathGlob", glob: "**" }, then: { deleteProperties: ["tags"] } }], options: { maxIterations: 10 } });
    expect(next).toMatchObject({ changed: false });
  });

  it("retains the startup sweep trigger until metadata arrives", async () => {
    vi.useFakeTimers();
    const target = file(); let cache: CachedMetadata | null = null;
    const events = new Map<string, (file: TFile) => void>();
    const app = {
      loadLocalStorage: () => null, saveLocalStorage: vi.fn(),
      metadataCache: { getFileCache: () => cache, on: (event: string, callback: (file: TFile) => void) => { events.set(event, callback); return {}; } },
      vault: { getMarkdownFiles: () => [target], on: vi.fn(), configDir: ".obsidian" },
      workspace: { layoutReady: true, on: vi.fn(), onLayoutReady: (callback: () => void) => { callback(); } },
    } as unknown as App;
    const plugin = new VaultFlowPlugin(app, {} as PluginManifest);
    vi.spyOn(plugin, "loadData").mockResolvedValue({ settingsVersion: 3, debounceMs: 10, dryRun: true, sweepOnStartup: true, periodicSweepEnabled: false,
      rules: [{ ...rule, runOn: "sweep", when: { type: "pathGlob", glob: "**" } }] });
    await plugin.onload();
    expect(plugin.getSettings().recentDecisions).toEqual([]);
    cache = {};
    events.get("changed")?.(target);
    await vi.advanceTimersByTimeAsync(10);
    expect(plugin.getSettings().recentDecisions).toEqual([expect.objectContaining({ outcome: "dry-run", appliedRuleIds: ["test"] })]);
    plugin.onunload();
  });
});
