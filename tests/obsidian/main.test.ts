import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import { TFile } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";

interface UndoCapablePlugin {
  loaded: boolean;
  settingsReadOnly: boolean;
  undoLastMoveOrRename(decision?: ReconciliationDecision): Promise<void>;
}

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path;
  file.extension = path.split("/").at(-1)?.split(".").at(-1) ?? "md";
  file.stat = { ctime: 1, mtime: 1, size: 0 };
  return file;
}

const manifest: PluginManifest = {
  id: "vault-flow",
  name: "Vault Flow",
  author: "Mark",
  version: "0.1.0",
  minAppVersion: "1.14.4",
  description: "Test manifest",
};

function makePlugin(app: App): UndoCapablePlugin {
  if (!("read" in app.vault)) Object.assign(app.vault, { read: async () => "" });
  const plugin = new VaultFlowPlugin(app, manifest) as unknown as UndoCapablePlugin;
  plugin.loaded = true;
  return plugin;
}

function makeUndoDecision(): ReconciliationDecision {
  return {
    timestamp: 1,
    path: "Inbox/note.md",
    desiredPath: "Done/note.md",
    outcome: "changed",
    appliedRuleIds: ["move"],
    involvedRuleIds: [],
    mutationKinds: ["move", "frontmatter"],
    iterations: 1,
    beforeFrontmatter: { status: "before" },
    afterFrontmatter: { status: "after" },
    afterIdentity: { ctime: 1, mtime: 1, size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  };
}

describe("VaultFlowPlugin regex compatibility", () => {
  it("preserves malformed scope settings and disables writes on load and external reload", async () => {
    const raw = { dryRun: false, monitoredFolders: 42 };
    const app = {
      loadLocalStorage: () => null, saveLocalStorage: vi.fn(),
      metadataCache: { on: vi.fn() }, vault: { on: vi.fn() },
      workspace: { on: vi.fn(), onLayoutReady: vi.fn() },
    } as unknown as App;
    const plugin = new VaultFlowPlugin(app, manifest);
    vi.spyOn(plugin, "loadData").mockResolvedValue(raw);
    const save = vi.spyOn(plugin, "saveData");
    await plugin.onload();
    expect((plugin as unknown as UndoCapablePlugin).settingsReadOnly).toBe(true);
    expect(save).not.toHaveBeenCalled();
    await plugin.onExternalSettingsChange();
    await plugin.updateSettings({ monitoredFolders: [] });
    expect((plugin as unknown as UndoCapablePlugin).settingsReadOnly).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(raw.monitoredFolders).toBe(42);
    const queue = (plugin as unknown as { queue: { resumeDeferred(): void } }).queue;
    const resume = vi.spyOn(queue, "resumeDeferred");
    vi.spyOn(plugin, "loadData").mockResolvedValue({ monitoredFolders: ["Inbox"] });
    await plugin.onExternalSettingsChange();
    expect((plugin as unknown as UndoCapablePlugin).settingsReadOnly).toBe(false);
    expect(resume).toHaveBeenCalledOnce();
    plugin.onunload();
  });

  it("preserves stored settings and disables automation on an incompatible regex upgrade", async () => {
    const raw = { rules: [{
      id: "lookahead", name: "Lookahead", enabled: true, priority: 0, order: 0,
      when: { type: "contentRegex", pattern: "(?=foo)foo" }, then: { moveTo: "Archive" },
    }] };
    const app = {
      loadLocalStorage: () => null, saveLocalStorage: vi.fn(),
      metadataCache: { on: vi.fn() }, vault: { on: vi.fn() },
      workspace: { on: vi.fn(), onLayoutReady: vi.fn() },
    } as unknown as App;
    const plugin = new VaultFlowPlugin(app, manifest);
    vi.spyOn(plugin, "loadData").mockResolvedValue(raw);
    const save = vi.spyOn(plugin, "saveData");
    const hoverSource = vi.spyOn(plugin, "registerHoverLinkSource");
    await plugin.onload();
    expect(hoverSource).toHaveBeenCalledWith("vault-flow-plan", { display: "Vault Flow", defaultMod: true });
    expect((plugin as unknown as { cliHandlers: Array<{ command: string }> }).cliHandlers.map(({ command }) => command)).toEqual([
      "vault-flow:plan-many",
      "vault-flow:test-rule",
      "vault-flow:status",
      "vault-flow:diagnostics",
      "vault-flow:plan",
    ]);
    expect((plugin as unknown as UndoCapablePlugin).settingsReadOnly).toBe(true);
    expect(save).not.toHaveBeenCalled();
    await plugin.updateSettings({ dryRun: false });
    expect(save).not.toHaveBeenCalled();
    expect(raw.rules[0]?.when.pattern).toBe("(?=foo)foo");
    plugin.onunload();
  });
});

describe("VaultFlowPlugin undo", () => {
  it.each(["replacement", "body edit"])("rejects a %s at the destination of a path-only transaction", async (change) => {
    const file = makeFile("Done/note.md");
    if (change === "replacement") file.stat.ctime = 999;
    const renameFile = vi.fn(async () => {});
    const app = { vault: {
      getFileByPath: () => file, getAbstractFileByPath: () => null,
      read: async () => change === "body edit" ? "new body" : "",
    }, fileManager: { renameFile } } as unknown as App;
    const plugin = makePlugin(app);
    await plugin.undoLastMoveOrRename({ ...makeUndoDecision(), mutationKinds: ["move"], beforeFrontmatter: undefined, afterFrontmatter: undefined });
    expect(renameFile).not.toHaveBeenCalled();
  });

  it("refuses a legacy path-only transaction without an identity", async () => {
    const renameFile = vi.fn();
    const app = { vault: {}, fileManager: { renameFile } } as unknown as App;
    await makePlugin(app).undoLastMoveOrRename({ ...makeUndoDecision(), afterIdentity: undefined, mutationKinds: ["move"] });
    expect(renameFile).not.toHaveBeenCalled();
  });

  it("does not mutate while newer-schema settings are read-only", async () => {
    const movedFile = makeFile("Done/note.md");
    const processFrontMatter = vi.fn(async () => {});
    const renameFile = vi.fn(async () => {});
    const app = {
      fileManager: { processFrontMatter, renameFile },
      vault: {
        getFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
        getAbstractFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
      },
    } as unknown as App;
    const plugin = makePlugin(app);
    plugin.settingsReadOnly = true;

    await plugin.undoLastMoveOrRename(makeUndoDecision());

    expect(renameFile).not.toHaveBeenCalled();
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it("does not restore frontmatter when the original path is occupied", async () => {
    const movedFile = makeFile("Done/note.md");
    const occupyingFile = makeFile("Inbox/note.md");
    const processFrontMatter = vi.fn(async (_file: TFile, callback?: (frontmatter: Record<string, unknown>) => void) => {
      callback?.({});
    });
    const renameFile = vi.fn(async () => {});
    const app = {
      fileManager: {
        processFrontMatter,
        renameFile,
      },
      vault: {
        getFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
        getAbstractFileByPath: (path: string) => {
          if (path === movedFile.path) return movedFile;
          if (path === occupyingFile.path) return occupyingFile;
          return null;
        },
      },
    } as unknown as App;
    const plugin = makePlugin(app);

    await plugin.undoLastMoveOrRename(makeUndoDecision());

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
  });

  it("restores a complete frontmatter snapshot after validating the transaction baseline", async () => {
    const movedFile = makeFile("Done/note.md");
    const frontmatter: Record<string, unknown> = {
      status: "after",
      nested: { values: [3] },
    };
    Object.defineProperty(frontmatter, "__proto__", { configurable: true, enumerable: true, value: "after-proto", writable: true });
    const beforeFrontmatter: Record<string, unknown> = { status: "before", nested: { values: [1, 2] } };
    Object.defineProperty(beforeFrontmatter, "__proto__", { configurable: true, enumerable: true, value: "before-proto", writable: true });
    const decision = { ...makeUndoDecision(), transactionId: "tx-1", beforeFrontmatter, afterFrontmatter: structuredClone(frontmatter) };
    const processFrontMatter = vi.fn(async (_file: TFile, callback?: (value: Record<string, unknown>) => void) => {
      callback?.(frontmatter);
    });
    const renameFile = vi.fn(async (file: TFile, path: string) => { file.path = path; });
    const app = {
      fileManager: { processFrontMatter, renameFile },
      vault: {
        getFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
        getAbstractFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
      },
      workspace: { getLeavesOfType: () => [] },
      saveLocalStorage: vi.fn(),
    } as unknown as App;
    const plugin = makePlugin(app);

    await plugin.undoLastMoveOrRename(decision);

    expect(movedFile.path).toBe("Inbox/note.md");
    expect(frontmatter).toEqual(beforeFrontmatter);
    expect(Object.getOwnPropertyDescriptor(frontmatter, "__proto__")?.value).toBe("before-proto");
    expect(Object.getPrototypeOf(frontmatter)).toBe(Object.prototype);
  });

  it("rolls a path undo back when newer frontmatter is detected", async () => {
    const movedFile = makeFile("Done/note.md");
    const frontmatter: Record<string, unknown> = { status: "newer edit" };
    const processFrontMatter = vi.fn(async (_file: TFile, callback?: (value: Record<string, unknown>) => void) => {
      callback?.(frontmatter);
    });
    const renameFile = vi.fn(async (file: TFile, path: string) => { file.path = path; });
    const app = {
      fileManager: { processFrontMatter, renameFile },
      vault: {
        getFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
        getAbstractFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
      },
      workspace: { getLeavesOfType: () => [] },
      saveLocalStorage: vi.fn(),
    } as unknown as App;
    const plugin = makePlugin(app);

    await plugin.undoLastMoveOrRename({ ...makeUndoDecision(), transactionId: "tx-1" });

    expect(renameFile).toHaveBeenNthCalledWith(1, movedFile, "Inbox/note.md");
    expect(renameFile).toHaveBeenNthCalledWith(2, movedFile, "Done/note.md");
    expect(frontmatter).toEqual({ status: "newer edit" });
  });

  it("does not restore frontmatter before a failing undo rename", async () => {
    const movedFile = makeFile("Done/note.md");
    const processFrontMatter = vi.fn(async (_file: TFile, callback?: (frontmatter: Record<string, unknown>) => void) => {
      callback?.({});
    });
    const renameFile = vi.fn(async () => {
      throw new Error("rename failed");
    });
    const app = {
      fileManager: {
        processFrontMatter,
        renameFile,
      },
      vault: {
        getFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
        getAbstractFileByPath: (path: string) => path === movedFile.path ? movedFile : null,
      },
    } as unknown as App;
    const plugin = makePlugin(app);

    await plugin.undoLastMoveOrRename(makeUndoDecision());

    expect(renameFile).toHaveBeenCalledWith(movedFile, "Inbox/note.md");
    expect(processFrontMatter).not.toHaveBeenCalled();
  });
});
