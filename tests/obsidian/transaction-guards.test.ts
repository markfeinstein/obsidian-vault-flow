import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, type App } from "obsidian";
import type { Rule } from "../../src/engine";
import { ReconciliationQueue } from "../../src/obsidian/queue";
import { MutationCoordinator } from "../../src/obsidian/mutation-coordinator";
import { applyReconciliationResult, noteStateFromObsidian } from "../../src/obsidian/adapter";

const rule: Rule = {
  id: "move", name: "Move", enabled: true, priority: 0, order: 0,
  when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: "Done/", setProperties: { status: "done" } }, stopOnMatch: true,
};

function harness() {
  const file = Object.assign(new TFile(), {
    path: "Inbox/note.md", basename: "note", extension: "md", stat: { ctime: 1, mtime: 1, size: 0 },
  });
  const frontmatter: Record<string, unknown> = {};
  const renameFile = vi.fn(async (_file: TFile, path: string) => { file.path = path; });
  const processFrontMatter = vi.fn(async (_file: TFile, callback: (value: Record<string, unknown>) => void) => { callback(frontmatter); });
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter }) },
    vault: { configDir: ".obsidian", getAbstractFileByPath: () => null, createFolder: vi.fn(async () => {}), cachedRead: async () => "" },
    fileManager: { renameFile, processFrontMatter },
  } as unknown as App;
  return { file, app, renameFile, processFrontMatter, frontmatter };
}

describe("transaction mutation boundaries", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["live", "manual", "sweep"] as const)("reports the evaluated trigger and revision: %s", async (trigger) => {
    vi.useFakeTimers();
    const h = harness();
    const onReconciled = vi.fn();
    const queue = new ReconciliationQueue(h.app, () => ({ revision: 3, debounceMs: 1, maxIterations: 3, dryRun: true, collisionPolicy: "skip", rules: [] }), { onReconciled });
    queue.enqueue(h.file, trigger);
    await vi.advanceTimersByTimeAsync(1);
    expect(onReconciled).toHaveBeenCalledWith(h.file, { triggerContexts: [trigger], revision: 3 });
    queue.clear();
  });

  it("defers a live note that becomes active while waiting for the lock", async () => {
    vi.useFakeTimers();
    const h = harness();
    const coordinator = new MutationCoordinator();
    let release!: () => void;
    const hold = coordinator.runExclusive(async () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    let active = false;
    const queue = new ReconciliationQueue(h.app, () => ({ debounceMs: 1, maxIterations: 3, dryRun: false, collisionPolicy: "skip", rules: [rule] }), {
      shouldDeferLiveWrite: () => active,
      runExclusive: (operation) => coordinator.runExclusive(operation),
    });
    queue.enqueue(h.file, "live");
    await vi.advanceTimersByTimeAsync(1);
    active = true;
    release();
    await hold;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.renameFile).not.toHaveBeenCalled();
    expect(queue.snapshot().pendingCount).toBe(1);
    active = false;
    queue.resumeDeferred();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.renameFile).toHaveBeenCalledOnce();
    queue.clear();
  });

  it.each(["unload", "revision", "active", "edited"] as const)("stops before rename after folder preparation: %s", async (reason) => {
    vi.useFakeTimers();
    const h = harness();
    let release!: () => void;
    const createFolder = vi.fn(async () => new Promise<never>((resolve) => { release = () => resolve(undefined as never); }));
    h.app.vault.createFolder = createFolder;
    let revision = 1;
    let active = false;
    const queue = new ReconciliationQueue(h.app, () => ({ revision, debounceMs: 1, maxIterations: 3, dryRun: false, collisionPolicy: "skip", rules: [rule] }), {
      shouldDeferLiveWrite: () => active,
    });
    queue.enqueue(h.file, "live");
    await vi.advanceTimersByTimeAsync(1);
    expect(createFolder).toHaveBeenCalled();
    if (reason === "unload") queue.clear();
    if (reason === "revision") revision += 1;
    if (reason === "active") active = true;
    if (reason === "edited") h.file.stat.mtime += 1;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.renameFile).not.toHaveBeenCalled();
    expect(h.processFrontMatter).not.toHaveBeenCalled();
    queue.clear();
  });

  it("checks frontmatter-only permission inside the asynchronous processor", async () => {
    const h = harness();
    let allowed = true;
    h.app.fileManager.processFrontMatter = async (_file, callback) => {
      allowed = false;
      callback(h.frontmatter);
    };
    const current = noteStateFromObsidian(h.file, { frontmatter: {} });
    await expect(applyReconciliationResult(h.app, h.file, current, {
      status: "converged", changed: true, desired: { ...current, frontmatter: { status: "done" } },
      mutations: [{ kind: "frontmatter", ruleIds: ["r"] }], appliedRuleIds: ["r"], dryRunRuleIds: [], iterations: 1,
    }, () => { if (!allowed) throw new Error("disabled"); })).rejects.toThrow("disabled");
    expect(h.frontmatter).toEqual({});
  });

  it("completes an already-started move and property transaction on disable", async () => {
    const h = harness();
    let allowed = true;
    h.app.fileManager.renameFile = async (_file, path) => { h.file.path = path; allowed = false; };
    const current = noteStateFromObsidian(h.file, { frontmatter: {} });
    const transaction = await applyReconciliationResult(h.app, h.file, current, {
      status: "converged", changed: true, desired: { ...current, path: "Done/note.md", frontmatter: { status: "done" } },
      mutations: [{ kind: "move", ruleIds: ["r"] }, { kind: "frontmatter", ruleIds: ["r"] }],
      appliedRuleIds: ["r"], dryRunRuleIds: [], iterations: 1,
    }, () => { if (!allowed) throw new Error("disabled"); });
    expect(h.frontmatter.status).toBe("done");
    expect(transaction.afterPath).toBe("Done/note.md");
    expect(transaction.afterFrontmatter).toEqual({ status: "done" });
  });
});
