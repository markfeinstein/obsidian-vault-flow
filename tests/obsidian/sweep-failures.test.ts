import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, type App, type PluginManifest } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import { JOURNAL_STORAGE_KEY } from "../../src/obsidian/transaction-journal";

const DAY = 86_400_000;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function harness(failure: "before" | "after") {
  vi.useFakeTimers();
  vi.setSystemTime(DAY / 2);
  vi.spyOn(window.crypto.subtle, "digest").mockResolvedValue(new Uint8Array(32).buffer);
  const file = Object.assign(new TFile(), { path: "Inbox/note.md", basename: "note", extension: "md", stat: { ctime: 1, mtime: 1, size: 4 } });
  const frontmatter: Record<string, unknown> = {};
  const storage = new Map<string, unknown>();
  let fail = true;
  const processFrontMatter = vi.fn(async (_file: TFile, callback: (value: Record<string, unknown>) => void) => {
    if (fail && failure === "before") throw new Error("Transient preparation failure");
    callback(frontmatter);
    if (fail) throw new Error("Unknown write outcome");
  });
  const app = {
    loadLocalStorage: (key: string) => storage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
    metadataCache: { getFileCache: () => ({ frontmatter }), on: vi.fn() },
    vault: { getMarkdownFiles: () => [file], getFileByPath: () => file, read: async () => "body", on: vi.fn(), configDir: ".obsidian" },
    fileManager: { processFrontMatter },
    workspace: { layoutReady: true, on: vi.fn(), onLayoutReady: (callback: () => void) => { callback(); }, getActiveFile: () => null },
  } as unknown as App;
  const plugin = new VaultFlowPlugin(app, {} as PluginManifest);
  vi.spyOn(plugin, "loadData").mockResolvedValue({ settingsVersion: 3, debounceMs: 10, dryRun: false, sweepOnStartup: false, periodicSweepEnabled: false,
    rules: [{ id: "age", name: "Age", enabled: true, priority: 0, order: 0, runOn: "sweep", when: { type: "fileAge", field: "ctime", olderThanDays: 1 }, then: { setProperties: { review: true } } }] });
  await plugin.onload();
  const sweep = async (at: number): Promise<void> => {
    vi.setSystemTime(at);
    await (plugin as unknown as { runMtimeSweep(): Promise<void> }).runMtimeSweep();
    await vi.advanceTimersByTimeAsync(10);
  };
  return { plugin, sweep, frontmatter, processFrontMatter, storage, allowWrites: () => { fail = false; } };
}

describe("failed sweep windows", () => {
  it("retries a due unchanged note after a safe failure, then advances only its successful window", async () => {
    const h = await harness("before");
    try {
      await h.sweep(DAY / 2);
      await h.sweep(DAY * 2);
      expect(h.processFrontMatter).toHaveBeenCalledTimes(1);
      expect(h.plugin.getSettings().recentDecisions.map((decision) => decision.outcome)).toEqual(["unchanged", "error"]);
      h.allowWrites();
      await h.sweep(DAY * 3);
      expect(h.frontmatter.review).toBe(true);
      expect(h.processFrontMatter).toHaveBeenCalledTimes(2);
      await h.sweep(DAY * 4);
      expect(h.processFrontMatter).toHaveBeenCalledTimes(2);
      expect(h.plugin.getSettings().recentDecisions.at(-1)?.outcome).toBe("changed");
    } finally { h.plugin.onunload(); }
  });

  it("pauses and retains recovery data instead of automatically retrying an uncertain mutation", async () => {
    const h = await harness("after");
    try {
      await h.sweep(DAY / 2);
      await h.sweep(DAY * 2);
      expect(h.plugin.isAutomationPaused()).toBe(true);
      expect(h.storage.get(JOURNAL_STORAGE_KEY)).toMatchObject({ entries: [expect.objectContaining({ status: "started" })] });
      h.allowWrites();
      await h.sweep(DAY * 3);
      expect(h.processFrontMatter).toHaveBeenCalledTimes(1);
    } finally { h.plugin.onunload(); }
  });
});
