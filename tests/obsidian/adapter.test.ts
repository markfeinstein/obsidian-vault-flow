import { describe, expect, it, vi } from "vitest";
import { reconcileFileState } from "../../src/engine";
import type { App } from "obsidian";
import { TExternalFile, TFile, TFolder } from "obsidian";
import type { NoteState, ReconciliationConverged } from "../../src/engine";
import { applyReconciliationResult, isProcessableFile, noteStateFromObsidian } from "../../src/obsidian/adapter";

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path;
  file.extension = path.split("/").at(-1)?.split(".").at(-1) ?? "md";
  file.stat = { ctime: 1, mtime: 1, size: 0 };
  return file;
}

function makeState(overrides: Partial<NoteState> = {}): NoteState {
  return {
    path: "Inbox/note.md",
    basename: "note",
    extension: "md",
    frontmatter: {},
    tags: [],
    ...overrides,
  };
}

function makeResult(desired: NoteState): ReconciliationConverged {
  return {
    status: "converged",
    desired,
    mutations: [{ kind: "move", ruleIds: ["move"] }],
    appliedRuleIds: ["move"],
    iterations: 1,
    changed: true,
    dryRunRuleIds: [],
  };
}

function makeApp() {
  const processFrontMatter = vi.fn(async (_file: TFile, callback?: (frontmatter: Record<string, unknown>) => void) => {
    callback?.({});
  });
  const renameFile = vi.fn(async () => {});
  const createFolder = vi.fn(async (path: string) => ({ path, children: [], name: path, parent: null }) as unknown as TFolder);
  const app = {
    fileManager: {
      processFrontMatter,
      renameFile,
    },
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
      createFolder,
    },
  } as unknown as App;

  return { app, processFrontMatter, renameFile, createFolder };
}

function makeFrontmatterAndPathResult(path: string, frontmatter: NoteState["frontmatter"]): ReconciliationConverged {
  return {
    ...makeResult(makeState({ path, frontmatter })),
    mutations: [
      { kind: "move", ruleIds: ["move"] },
      { kind: "frontmatter", ruleIds: ["frontmatter"] },
    ],
  };
}

describe("file processability", () => {
  it("rejects Markdown files opened from outside the vault", () => {
    const file = new TExternalFile();
    file.path = "/tmp/note.md";
    file.extension = "md";
    expect(isProcessableFile(file)).toBe(false);
  });
});

describe("noteStateFromObsidian", () => {
  it("distinguishes confirmed absent frontmatter from unavailable metadata", () => {
    const file = makeFile("Inbox/note.md");
    expect(noteStateFromObsidian(file, {}).rawFrontmatter).toEqual({});
    expect(noteStateFromObsidian(file, null).rawFrontmatter).toBeUndefined();
  });

  it("treats position as ordinary user frontmatter and converges after a write", async () => {
    const file = makeFile("Inbox/note.md");
    const written: Record<string, unknown> = { position: 7 };
    const current = noteStateFromObsidian(file, { frontmatter: written });
    expect(current.frontmatter.position).toBe(7);
    expect(current.frontmatterKeys).toContain("position");
    const rules = [{ id: "position", name: "position", enabled: true, priority: 0, order: 0,
      when: { type: "pathGlob" as const, glob: "**" }, then: { setProperties: { position: 1 } } }];
    const result = reconcileFileState({ file: current, rules, options: { maxIterations: 10 } });
    if (result.status !== "converged") throw new Error(result.status);
    const { app, processFrontMatter } = makeApp();
    processFrontMatter.mockImplementation(async (_file, callback) => { callback?.(written); });
    await applyReconciliationResult(app, file, current, result);
    expect(written.position).toBe(1);
    expect(reconcileFileState({ file: noteStateFromObsidian(file, { frontmatter: written }), rules,
      options: { maxIterations: 10 } })).toMatchObject({ status: "converged", changed: false });
    const updated = noteStateFromObsidian(file, { frontmatter: written });
    await applyReconciliationResult(app, file, updated, {
      ...result, desired: { ...updated, frontmatter: {}, frontmatterKeys: [] },
    });
    expect(written).toEqual({});
  });

  it("keeps inline tags separate from frontmatter tags", () => {
    const file = makeFile("Inbox/note.md");
    const state = noteStateFromObsidian(file, {
      tags: [{ tag: "#inline", position: {} as never }],
      frontmatter: { tags: ["stored"] },
    });

    expect(state.tags).toEqual(["#inline", "#stored"]);
    expect(state.frontmatterKeys).toEqual(["tags"]);
    expect(state.frontmatterTags).toEqual(["stored"]);
    expect(state.inlineTags).toEqual(["#inline"]);
  });

  it("tracks keys for unsupported nested YAML without narrowing their values", () => {
    const file = makeFile("Inbox/note.md");
    const state = noteStateFromObsidian(file, {
      frontmatter: { nested: { child: { value: 1 } }, status: "todo" },
    });

    expect(state.frontmatter).toEqual({ status: "todo" });
    expect(state.frontmatterKeys).toEqual(["nested", "status"]);
    expect(state.rawFrontmatter).toEqual({ nested: { child: { value: 1 } }, status: "todo" });
  });

  it("retains the inline source when a tag also exists in frontmatter", () => {
    const file = makeFile("Inbox/note.md");
    const state = noteStateFromObsidian(file, {
      tags: [{ tag: "#shared", position: {} as never }],
      frontmatter: { tags: ["shared"] },
    });

    expect(state.tags).toEqual(["#shared"]);
    expect(state.frontmatterTags).toEqual(["shared"]);
    expect(state.inlineTags).toEqual(["#shared"]);
  });
});

describe("applyReconciliationResult path safety", () => {
  it("consumes a write budget only once for a combined transaction and before mutation", async () => {
    const file = makeFile("Inbox/note.md");
    const { app, renameFile, processFrontMatter } = makeApp();
    const start = vi.fn();
    await applyReconciliationResult(app, file, makeState(), makeFrontmatterAndPathResult("Done/note.md", { status: "done" }), () => {}, start);
    expect(start).toHaveBeenCalledOnce();
    renameFile.mockClear(); processFrontMatter.mockClear();
    await expect(applyReconciliationResult(app, file, makeState(), makeFrontmatterAndPathResult("Done/note.md", { status: "done" }), () => {}, () => { throw new Error("Budget exhausted"); })).rejects.toThrow("Budget exhausted");
    expect(renameFile).not.toHaveBeenCalled();
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it("rejects moves into protected vault folders", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState();
    const result = makeResult(makeState({ path: ".obsidian/plugins/note.md" }));
    const { app, processFrontMatter, renameFile, createFolder } = makeApp();

    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("protected folder");
    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });

  it("rejects moves into a custom Obsidian config folder", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState();
    const result = makeResult(makeState({ path: ".vault-config/plugins/note.md" }));
    const { app, renameFile } = makeApp();
    app.vault.configDir = ".vault-config";

    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("protected folder");
    expect(renameFile).not.toHaveBeenCalled();
  });

  it("rejects path changes that alter the note extension", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState();
    const result = makeResult(makeState({ path: "Inbox/note.txt", extension: "txt" }));
    const { app, processFrontMatter, renameFile, createFolder } = makeApp();

    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("changes file extension");
    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });

  it("rejects path changes when current file is not a supported note extension", async () => {
    const file = makeFile("Inbox/note.canvas");
    const current = makeState({ path: "Inbox/note.canvas", extension: "canvas" });
    const result = makeResult(makeState({ path: "Archive/note.canvas", extension: "canvas" }));
    const { app, processFrontMatter, renameFile, createFolder } = makeApp();

    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("Unsupported note extension");
    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });

  it("tolerates another writer creating a destination folder concurrently", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState();
    const result = makeResult(makeState({ path: "Archive/note.md" }));
    const { app, createFolder, renameFile } = makeApp();
    const racedFolder = new TFolder();
    racedFolder.path = "Archive";
    let folderExists = false;
    app.vault.getAbstractFileByPath = () => folderExists ? racedFolder : null;
    createFolder.mockImplementationOnce(async () => {
      folderExists = true;
      throw new Error("Folder already exists");
    });

    await applyReconciliationResult(app, file, current, result);

    expect(renameFile).toHaveBeenCalledWith(file, "Archive/note.md");
  });

  it("does not write frontmatter before a failing rename", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState();
    const result = makeFrontmatterAndPathResult("Done/note.md", { status: "done" });
    const { app, processFrontMatter, renameFile } = makeApp();
    renameFile.mockRejectedValueOnce(new Error("rename failed"));

    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("rename failed");

    expect(renameFile).toHaveBeenCalledWith(file, "Done/note.md");
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it("rolls back a successful rename when frontmatter writing fails", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState();
    const result = makeFrontmatterAndPathResult("Done/note.md", { status: "done" });
    const { app, processFrontMatter, renameFile } = makeApp();
    processFrontMatter.mockRejectedValueOnce(new Error("frontmatter failed"));

    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("frontmatter failed");

    expect(renameFile).toHaveBeenNthCalledWith(1, file, "Done/note.md");
    expect(renameFile).toHaveBeenNthCalledWith(2, file, "Inbox/note.md");
  });

  it("reports rollback failure when frontmatter writing fails after rename", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState();
    const result = makeFrontmatterAndPathResult("Done/note.md", { status: "done" });
    const { app, processFrontMatter, renameFile } = makeApp();
    processFrontMatter.mockRejectedValueOnce(new Error("frontmatter failed"));
    renameFile.mockResolvedValueOnce(undefined);
    renameFile.mockRejectedValueOnce(new Error("rollback failed"));

    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("rollback to Inbox/note.md failed");

    expect(renameFile).toHaveBeenNthCalledWith(1, file, "Done/note.md");
    expect(renameFile).toHaveBeenNthCalledWith(2, file, "Inbox/note.md");
  });
});

describe("applyReconciliationResult frontmatter safety", () => {
  it("rejects concurrently added frontmatter when the planned note had none", async () => {
    const file = makeFile("Inbox/note.md");
    const current = noteStateFromObsidian(file, {});
    const written = { status: "newer user edit" };
    const { app, processFrontMatter } = makeApp();
    processFrontMatter.mockImplementationOnce(async (_file, callback) => { callback?.(written); });
    const result: ReconciliationConverged = {
      ...makeResult({ ...current, frontmatter: { status: "planned" } }),
      mutations: [{ kind: "frontmatter", ruleIds: ["status"] }],
    };
    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("changed after reconciliation");
    expect(written.status).toBe("newer user edit");
  });

  it("ignores unsafe desired frontmatter keys when writing", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState();
    const desiredFrontmatter = Object.create(null) as Record<string, string>;
    desiredFrontmatter.safe = "ok";
    desiredFrontmatter["constructor"] = "polluted";
    const result: ReconciliationConverged = {
      ...makeResult(makeState({ frontmatter: desiredFrontmatter })),
      mutations: [{ kind: "frontmatter", ruleIds: ["frontmatter"] }],
    };
    const { app, processFrontMatter, renameFile } = makeApp();
    const written: Record<string, unknown> = {};
    processFrontMatter.mockImplementationOnce(async (_file, callback?: (frontmatter: Record<string, unknown>) => void) => {
      callback?.(written);
    });

    await applyReconciliationResult(app, file, current, result);

    expect(written.safe).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(written, "constructor")).toBe(false);
    expect(renameFile).not.toHaveBeenCalled();
  });

  it("deletes frontmatter tags when desired state removes all tags", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState({ frontmatter: { tags: ["wip"] }, tags: ["wip"] });
    const result: ReconciliationConverged = {
      ...makeResult(makeState({ frontmatter: {}, tags: [] })),
      mutations: [{ kind: "frontmatter", ruleIds: ["tags"] }],
    };
    const { app, processFrontMatter, renameFile } = makeApp();
    const written: Record<string, unknown> = { tags: ["wip"] };
    processFrontMatter.mockImplementationOnce(async (_file, callback?: (frontmatter: Record<string, unknown>) => void) => {
      callback?.(written);
    });

    await applyReconciliationResult(app, file, current, result);

    expect(Object.prototype.hasOwnProperty.call(written, "tags")).toBe(false);
    expect(renameFile).not.toHaveBeenCalled();
  });

  it("rejects a write when complete frontmatter changed after planning", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState({
      frontmatter: {},
      frontmatterKeys: ["nested"],
      rawFrontmatter: { nested: { child: 1 } },
    });
    const result: ReconciliationConverged = {
      ...makeResult(makeState({ frontmatter: {}, frontmatterKeys: [] })),
      mutations: [{ kind: "frontmatter", ruleIds: ["delete-nested"] }],
    };
    const { app, processFrontMatter } = makeApp();
    const written: Record<string, unknown> = { nested: { child: 2 } };
    processFrontMatter.mockImplementationOnce(async (_file, callback?: (frontmatter: Record<string, unknown>) => void) => {
      callback?.(written);
    });

    await expect(applyReconciliationResult(app, file, current, result)).rejects.toThrow("changed after reconciliation was planned");

    expect(written).toEqual({ nested: { child: 2 } });
  });

  it("deletes an explicitly removed unsupported nested YAML property", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState({ frontmatter: {}, frontmatterKeys: ["nested"] });
    const result: ReconciliationConverged = {
      ...makeResult(makeState({ frontmatter: {}, frontmatterKeys: [] })),
      mutations: [{ kind: "frontmatter", ruleIds: ["delete-nested"] }],
    };
    const { app, processFrontMatter } = makeApp();
    const written: Record<string, unknown> = { nested: { child: { value: 1 } }, untouched: true };
    processFrontMatter.mockImplementationOnce(async (_file, callback?: (frontmatter: Record<string, unknown>) => void) => {
      callback?.(written);
    });

    await applyReconciliationResult(app, file, current, result);

    expect(written).toEqual({ untouched: true });
  });

  it("captures complete snapshots and only writes properties changed by the plan", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState({ frontmatter: { status: "todo", untouched: "old cache" } });
    const result: ReconciliationConverged = {
      ...makeResult(makeState({ frontmatter: { status: "done", untouched: "old cache" } })),
      mutations: [{ kind: "frontmatter", ruleIds: ["frontmatter"] }],
    };
    const { app, processFrontMatter } = makeApp();
    const written: Record<string, unknown> = {
      status: "todo",
      untouched: "newer value",
      nested: { values: [1, 2] },
    };
    processFrontMatter.mockImplementationOnce(async (_file, callback?: (frontmatter: Record<string, unknown>) => void) => {
      callback?.(written);
    });

    const transaction = await applyReconciliationResult(app, file, current, result);

    expect(written).toEqual({ status: "done", untouched: "newer value", nested: { values: [1, 2] } });
    expect(transaction.beforeFrontmatter).toEqual({ status: "todo", untouched: "newer value", nested: { values: [1, 2] } });
    expect(transaction.afterFrontmatter).toEqual({ status: "done", untouched: "newer value", nested: { values: [1, 2] } });
  });

  it("does not write semantically equal frontmatter with different key order", async () => {
    const file = makeFile("Inbox/note.md");
    const current = makeState({ frontmatter: { b: "two", a: "one" } });
    const result: ReconciliationConverged = {
      ...makeResult(makeState({ frontmatter: { a: "one", b: "two" } })),
      mutations: [{ kind: "frontmatter", ruleIds: ["frontmatter"] }],
    };
    const { app, processFrontMatter, renameFile } = makeApp();

    await applyReconciliationResult(app, file, current, result);

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
  });
});
