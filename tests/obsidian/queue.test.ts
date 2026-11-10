import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconciliationQueue } from "../../src/obsidian/queue";
import type { App, CachedMetadata } from "obsidian";
import { TFile } from "obsidian";

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path;
  file.extension = path.split("/").at(-1)?.split(".").at(-1) ?? "md";
  file.stat = { ctime: 1, mtime: 1, size: 0 };
  return file;
}

function makeApp(options: {
  readonly cachedRead?: (file: TFile) => Promise<string>;
  readonly getFileCache?: (file: TFile) => CachedMetadata | null;
  readonly processFrontMatter?: (file: TFile, processor: (frontmatter: Record<string, unknown>) => void) => Promise<void>;
  readonly renameFile?: (file: TFile, path: string) => Promise<void>;
} = {}): App {
  return {
    metadataCache: { getFileCache: options.getFileCache ?? (() => ({})) },
    fileManager: {
      processFrontMatter: options.processFrontMatter ?? (async () => {}),
      renameFile: options.renameFile ?? (async (file: TFile, path: string) => { file.path = path; }),
    },
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
      createFolder: async () => ({ children: [], name: "", parent: null, path: "" }),
      cachedRead: options.cachedRead ?? (async () => ""),
    },
    workspace: {},
  } as unknown as App;
}

async function settleAsyncQueue(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("ReconciliationQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces bulk population snapshots and yields before all files are enqueued", async () => {
    vi.useFakeTimers();
    const onSnapshotChange = vi.fn();
    const queue = new ReconciliationQueue(makeApp(), () => ({ debounceMs: 60_000, maxIterations: 10,
      dryRun: true, collisionPolicy: "skip", rules: [] }), { onSnapshotChange });
    const populating = queue.enqueueMany(Array.from({ length: 1000 }, (_, index) => makeFile(`${index}.md`)), "manual");
    expect(queue.snapshot().pendingCount).toBe(200);
    expect(onSnapshotChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    await populating;
    expect(queue.snapshot().pendingCount).toBe(1000);
    expect(onSnapshotChange).toHaveBeenCalledTimes(1);
    expect(onSnapshotChange).toHaveBeenLastCalledWith({ pendingCount: 1000, runningCount: 0 });
    queue.clear();
    expect(queue.snapshot()).toEqual({ pendingCount: 0, runningCount: 0 });
  });

  it("does not resume bulk enqueue after disposal", async () => {
    vi.useFakeTimers();
    const queue = new ReconciliationQueue(makeApp(), () => ({ debounceMs: 60_000, maxIterations: 10,
      dryRun: true, collisionPolicy: "skip", rules: [] }));
    const populating = queue.enqueueMany(Array.from({ length: 500 }, (_, index) => makeFile(`${index}.md`)), "manual");
    queue.clear();
    await vi.advanceTimersByTimeAsync(1);
    await populating;
    expect(queue.snapshot().pendingCount).toBe(0);
  });

  it("keeps deferred live active-file writes pending until they can run", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: unknown[] = [];
    const renameFile = vi.fn(async (renamedFile: TFile, path: string) => { renamedFile.path = path; });
    let isActive = true;
    const queue = new ReconciliationQueue(
      makeApp({ renameFile }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{ id: "move", name: "Move", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: "Done/" }, stopOnMatch: true }],
      }),
      {
        recordDecision: async (decision) => { decisions.push(decision); },
        shouldDeferLiveWrite: () => isActive,
      },
    );

    queue.enqueue(file, "live");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();
    expect(decisions).toHaveLength(1);
    expect(queue.snapshot().pendingCount).toBe(1);
    expect(renameFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await settleAsyncQueue();
    expect(decisions).toHaveLength(1);

    isActive = false;
    queue.resumeDeferred();
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();
    expect(queue.snapshot().pendingCount).toBe(0);
    expect(renameFile).toHaveBeenCalledWith(file, "Done/note.md");
    expect(file.path).toBe("Done/note.md");
  });

  it("allows manual reconciliation to proceed for the active file", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const renameFile = vi.fn(async (renamedFile: TFile, path: string) => { renamedFile.path = path; });
    const queue = new ReconciliationQueue(
      makeApp({ renameFile }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{ id: "move", name: "Move", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: "Done/" }, stopOnMatch: true }],
      }),
      { shouldDeferLiveWrite: () => true },
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(queue.snapshot().pendingCount).toBe(0);
    expect(renameFile).toHaveBeenCalledWith(file, "Done/note.md");
  });

  it("does not drop manual reconciliation queued while a live active-file write is deferred", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: unknown[] = [];
    const renameFile = vi.fn(async (renamedFile: TFile, path: string) => { renamedFile.path = path; });
    const queue = new ReconciliationQueue(
      makeApp({ renameFile }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{ id: "move", name: "Move", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: "Done/" }, stopOnMatch: true }],
      }),
      {
        recordDecision: async (decision) => { decisions.push(decision); },
        shouldDeferLiveWrite: () => true,
      },
    );

    queue.enqueue(file, "live");
    await vi.advanceTimersByTimeAsync(10);
    queue.enqueue(file, "manual");
    await settleAsyncQueue();

    expect(decisions).toHaveLength(1);
    expect(queue.snapshot().pendingCount).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(queue.snapshot().pendingCount).toBe(0);
    expect(renameFile).toHaveBeenCalledWith(file, "Done/note.md");
  });

  it("reports unsafe destinations as errors even in global dry-run mode", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: Array<{ outcome: string; message?: string }> = [];
    const renameFile = vi.fn(async () => {});
    const queue = new ReconciliationQueue(
      makeApp({ renameFile }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: true,
        collisionPolicy: "skip",
        rules: [{ id: "unsafe", name: "Unsafe", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: ".obsidian/note.md" }, stopOnMatch: true }],
      }),
      { recordDecision: async (decision) => { decisions.push(decision); } },
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(renameFile).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "error" }]);
    expect(decisions[0]?.message).toContain("protected folder");
  });

  it("records matching per-rule dry-run plans", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: Array<{ outcome: string; dryRunRuleIds?: readonly string[]; desiredPath?: string }> = [];
    const renameFile = vi.fn(async () => {});
    const queue = new ReconciliationQueue(
      makeApp({ renameFile }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{ id: "dry", name: "Dry", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: "Done/" }, dryRun: true }],
      }),
      { recordDecision: async (decision) => { decisions.push(decision); } },
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(renameFile).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "dry-run", dryRunRuleIds: ["dry"], desiredPath: "Done/note.md" }]);
  });

  it("retains multiple trigger contexts until reconciliation", () => {
    const queue = new ReconciliationQueue(
      makeApp(),
      () => ({ debounceMs: 10, maxIterations: 1, dryRun: true, collisionPolicy: "skip", rules: [{ id: "r", name: "r", enabled: true, priority: 0, order: 0, when: { type: "tag", tag: "x" }, then: { moveTo: "A/" }, runOn: "manual" }] }),
    );

    const file = makeFile("Inbox/note.md");
    queue.enqueue(file, "live");
    queue.enqueue(file, "manual");
    expect(queue.snapshot().pendingCount).toBe(1);
  });

  it("skips and requeues when frontmatter changes after planning", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: Array<{ outcome?: string; message?: string }> = [];
    let frontmatter: Record<string, unknown> = { status: "todo" };
    let cacheReads = 0;
    const processFrontMatter = vi.fn(async (_file: TFile, processor: (frontmatter: Record<string, unknown>) => void) => {
      processor(frontmatter);
    });
    const queue = new ReconciliationQueue(
      makeApp({
        getFileCache: () => {
          cacheReads += 1;
          if (cacheReads === 2) {
            frontmatter = { status: "blocked" };
          }
          return { frontmatter };
        },
        processFrontMatter,
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{ id: "status", name: "Status", enabled: true, priority: 0, order: 0, when: { type: "frontmatterValue", property: "status", value: "todo" }, then: { setProperties: { status: "done" } }, stopOnMatch: true }],
      }),
      { recordDecision: async (decision) => { decisions.push(decision); } },
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(queue.snapshot().pendingCount).toBe(1);
    const latestDecision = decisions[decisions.length - 1];
    expect(latestDecision).toMatchObject({ outcome: "skipped" });
    expect(latestDecision?.message).toContain("changed after reconciliation was planned");
  });

  it("skips and requeues when an unsupported nested YAML value changes after planning", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    let cacheReads = 0;
    const processFrontMatter = vi.fn(async () => {});
    const queue = new ReconciliationQueue(
      makeApp({
        getFileCache: () => {
          cacheReads += 1;
          return { frontmatter: { nested: { value: cacheReads === 1 ? 1 : 2 } } };
        },
        processFrontMatter,
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{ id: "delete-nested", name: "Delete nested", enabled: true, priority: 0, order: 0, when: { type: "frontmatterExists", property: "nested" }, then: { deleteProperties: ["nested"] }, stopOnMatch: true }],
      }),
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(queue.snapshot().pendingCount).toBe(1);
  });

  it("requeues without planning when content reads fail", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: Array<{ outcome?: string; message?: string }> = [];
    const processFrontMatter = vi.fn(async () => {});
    const queue = new ReconciliationQueue(
      makeApp({
        cachedRead: async () => {
          throw new Error("read failed");
        },
        getFileCache: () => ({ frontmatter: { status: "todo" } }),
        processFrontMatter,
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [
          { id: "body-marker", name: "Body marker", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "trigger text" }, then: { addTags: ["triggered"] } },
          { id: "status", name: "Status", enabled: true, priority: 1, order: 1, when: { type: "frontmatterValue", property: "status", value: "todo" }, then: { setProperties: { status: "done" } }, stopOnMatch: true },
        ],
      }),
      { recordDecision: async (decision) => { decisions.push(decision); } },
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(queue.snapshot().pendingCount).toBe(1);
    const latestDecision = decisions[decisions.length - 1];
    expect(latestDecision).toMatchObject({ outcome: "skipped" });
    expect(latestDecision?.message).toContain("Content read failed");
  });

  it("stops requeueing after repeated content read failures", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: Array<{ outcome?: string; message?: string }> = [];
    const onReconciled = vi.fn(async () => {});
    const queue = new ReconciliationQueue(
      makeApp({
        cachedRead: async () => {
          throw new Error("read failed");
        },
        getFileCache: () => ({ frontmatter: { status: "todo" } }),
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [
          { id: "body-marker", name: "Body marker", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "trigger text" }, then: { addTags: ["triggered"] } },
        ],
      }),
      {
        onReconciled,
        recordDecision: async (decision) => { decisions.push(decision); },
      },
    );

    queue.enqueue(file, "manual");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(10 * 2 ** attempt);
      await settleAsyncQueue();
    }

    expect(queue.snapshot().pendingCount).toBe(0);
    expect(onReconciled).not.toHaveBeenCalled();
    expect(decisions.map((decision) => decision.outcome)).toEqual(["skipped", "skipped", "error"]);
    expect(decisions[2]?.message).toContain("reconciliation stopped");
  });

  it("clears content read failure counters when a path is cancelled", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: Array<{ outcome?: string }> = [];
    const queue = new ReconciliationQueue(
      makeApp({
        cachedRead: async () => {
          throw new Error("read failed");
        },
        getFileCache: () => ({ frontmatter: { status: "todo" } }),
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [
          { id: "body-marker", name: "Body marker", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "trigger text" }, then: { addTags: ["triggered"] } },
        ],
      }),
      { recordDecision: async (decision) => { decisions.push(decision); } },
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();
    queue.cancel(file.path);
    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(decisions.map((decision) => decision.outcome)).toEqual(["skipped", "skipped"]);
    expect(queue.snapshot().pendingCount).toBe(1);
  });

  it("limits concurrent planning work", async () => {
    vi.useFakeTimers();
    const files = [makeFile("Inbox/a.md"), makeFile("Inbox/b.md"), makeFile("Inbox/c.md")];
    const resolvers: Array<(value: string) => void> = [];
    const cachedRead = vi.fn(async () => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const queue = new ReconciliationQueue(
      makeApp({ cachedRead }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        maxConcurrent: 2,
        dryRun: true,
        collisionPolicy: "skip",
        rules: [{ id: "body", name: "Body", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "x" }, then: { addTags: ["x"] } }],
      }),
    );

    for (const file of files) queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();
    expect(cachedRead).toHaveBeenCalledTimes(2);

    resolvers[0]?.("x");
    resolvers[1]?.("x");
    await settleAsyncQueue();
    await settleAsyncQueue();
    expect(cachedRead).toHaveBeenCalledTimes(3);

    resolvers[2]?.("x");
    await settleAsyncQueue();
  });

  it("does not requeue work after the queue is cleared", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    let resolveRead!: (value: string) => void;
    const queue = new ReconciliationQueue(
      makeApp({ cachedRead: async () => new Promise<string>((resolve) => { resolveRead = resolve; }) }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{ id: "body", name: "Body", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "x" }, then: { addTags: ["x"] } }],
      }),
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();
    queue.clear();
    resolveRead("x");
    await settleAsyncQueue();
    await vi.runAllTimersAsync();

    expect(queue.snapshot()).toEqual({ pendingCount: 0, runningCount: 0 });
  });

  it("rechecks file eligibility inside the mutation lock", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: Array<{ outcome?: string; message?: string }> = [];
    const renameFile = vi.fn(async () => {});
    let disabled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = new ReconciliationQueue(
      makeApp({
        renameFile,
        getFileCache: () => ({ frontmatter: disabled ? { "vault-flow-disable": true } : {} }),
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{ id: "move", name: "Move", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: "Done/" }, stopOnMatch: true }],
      }),
      {
        recordDecision: async (decision) => { decisions.push(decision); },
        runExclusive: async (operation) => { await gate; return operation(); },
      },
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();
    disabled = true;
    release();
    await settleAsyncQueue();

    expect(renameFile).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "skipped" }]);
    expect(decisions[0]?.message).toContain("vault-flow-disable");
  });

  it("does not plan or write while automation is disabled", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const getFileCache = vi.fn(() => ({ frontmatter: {} }));
    let enabled = false;
    const renameFile = vi.fn(async () => {});
    const queue = new ReconciliationQueue(
      makeApp({ getFileCache, renameFile }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        automationEnabled: enabled,
        rules: [{ id: "move", name: "Move", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: "Done/" }, stopOnMatch: true }],
      }),
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(getFileCache).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
    expect(queue.snapshot()).toEqual({ pendingCount: 1, runningCount: 0 });
    queue.resumeDeferred();
    await vi.advanceTimersByTimeAsync(10);
    expect(getFileCache).not.toHaveBeenCalled();
    enabled = true;
    queue.resumeDeferred();
    await vi.advanceTimersByTimeAsync(10);
    expect(renameFile).toHaveBeenCalledOnce();
    queue.clear();
  });

  it("rechecks automation state after asynchronous apply validation", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    let resolveSecondRead!: (value: string) => void;
    let readCount = 0;
    let automationEnabled = true;
    let revision = 1;
    const processFrontMatter = vi.fn(async () => {});
    const queue = new ReconciliationQueue(
      makeApp({
        cachedRead: async () => {
          readCount += 1;
          if (readCount === 1) return "trigger text";
          return new Promise<string>((resolve) => { resolveSecondRead = resolve; });
        },
        getFileCache: () => ({ frontmatter: { status: "todo" } }),
        processFrontMatter,
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        automationEnabled,
        revision,
        rules: [{ id: "body", name: "Body", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "trigger text" }, then: { setProperties: { status: "done" } }, stopOnMatch: true }],
      }),
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();
    expect(readCount).toBe(2);

    automationEnabled = false;
    revision = 2;
    resolveSecondRead("trigger text");
    await settleAsyncQueue();
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(queue.snapshot()).toEqual({ pendingCount: 1, runningCount: 0 });
    queue.clear();
  });

  it("uses body-only content consistently during planning and apply revalidation", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const processFrontMatter = vi.fn(async (_file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      callback({ status: "todo" });
    });
    const queue = new ReconciliationQueue(
      makeApp({
        cachedRead: async () => "---\nstatus: todo\n---\ntrigger text",
        getFileCache: () => ({ frontmatter: { status: "todo" } }),
        processFrontMatter,
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [{
          id: "body-marker",
          name: "Body marker",
          enabled: true,
          priority: 0,
          order: 0,
          when: { type: "contentContains", text: "trigger text" },
          then: { setProperties: { status: "done" } },
          stopOnMatch: true,
        }],
      }),
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(processFrontMatter).toHaveBeenCalledOnce();
    expect(queue.snapshot()).toEqual({ pendingCount: 0, runningCount: 0 });
  });

  it("revalidates body content before applying content-dependent plans", async () => {
    vi.useFakeTimers();
    const file = makeFile("Inbox/note.md");
    const decisions: Array<{ outcome?: string; message?: string }> = [];
    let readCount = 0;
    const processFrontMatter = vi.fn(async () => {});
    const queue = new ReconciliationQueue(
      makeApp({
        cachedRead: async () => {
          readCount += 1;
          return readCount === 1 ? "trigger text" : "updated body without trigger text";
        },
        getFileCache: () => ({ frontmatter: { status: "todo" } }),
        processFrontMatter,
      }),
      () => ({
        debounceMs: 10,
        maxIterations: 2,
        dryRun: false,
        collisionPolicy: "skip",
        rules: [
          { id: "body-marker", name: "Body marker", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "trigger text" }, then: { addTags: ["triggered"] } },
          { id: "status", name: "Status", enabled: true, priority: 1, order: 1, when: { type: "frontmatterValue", property: "status", value: "todo" }, then: { setProperties: { status: "done" } }, stopOnMatch: true },
        ],
      }),
      { recordDecision: async (decision) => { decisions.push(decision); } },
    );

    queue.enqueue(file, "manual");
    await vi.advanceTimersByTimeAsync(10);
    await settleAsyncQueue();

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(readCount).toBe(2);
    expect(queue.snapshot().pendingCount).toBe(1);
    const latestDecision = decisions[decisions.length - 1];
    expect(latestDecision).toMatchObject({ outcome: "skipped" });
    expect(latestDecision?.message).toContain("changed after reconciliation was planned");
  });
});
