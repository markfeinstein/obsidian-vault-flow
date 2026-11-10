import { describe, expect, it, vi } from "vitest";
import type { App, CachedMetadata } from "obsidian";
import { ConfirmationModal, TFile } from "obsidian";
import { TestElement } from "../helpers/dom";
import type { NoteState, ReconciliationConverged } from "../../src/engine";
import { VaultPreviewModal, type VaultPreviewEntry } from "../../src/obsidian/vault-preview-modal";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";

interface VaultPreviewApplyHarness {
  applySelected(entries: readonly VaultPreviewEntry[]): Promise<void>;
}

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path;
  file.extension = path.split("/").at(-1)?.split(".").at(-1) ?? "md";
  file.stat = { ctime: 1, mtime: 2, size: 0 };
  return file;
}

function makeState(overrides: Partial<NoteState> = {}): NoteState {
  return {
    path: "Inbox/note.md",
    basename: "note",
    extension: "md",
    frontmatter: { status: "todo" },
    tags: [],
    stat: { ctime: 1, mtime: 2 },
    ...overrides,
  };
}

function makeResult(desired: NoteState, mutations: ReconciliationConverged["mutations"] = [{ kind: "frontmatter", ruleIds: ["status"] }]): ReconciliationConverged {
  return {
    status: "converged",
    desired,
    mutations,
    appliedRuleIds: ["status"],
    iterations: 1,
    changed: true,
    dryRunRuleIds: [],
  };
}

function makeEntry(
  current: NoteState,
  result: ReconciliationConverged,
  needsBodyContent = false,
  collisionBasePath?: string,
): VaultPreviewEntry {
  return {
    path: current.path,
    propertyChangeCount: 1,
    preview: {
      current,
      needsBodyContent,
      result,
      ...(collisionBasePath === undefined ? {} : { collisionBasePath }),
      preview: {
        outcome: "changed",
        path: current.path,
        appliedRuleIds: result.appliedRuleIds,
        involvedRuleIds: [],
        mutationKinds: result.mutations.map((mutation) => mutation.kind),
        iterations: result.iterations,
        message: "Dry-run preview only; no vault changes were written.",
      },
    },
  };
}

function makeNullResultEntry(current: NoteState): VaultPreviewEntry {
  return {
    path: current.path,
    propertyChangeCount: 0,
    preview: {
      current,
      needsBodyContent: false,
      result: null,
      preview: {
        outcome: "skipped",
        path: current.path,
        appliedRuleIds: ["status"],
        involvedRuleIds: [],
        mutationKinds: ["frontmatter"],
        iterations: 1,
        message: "Skipped in preview.",
      },
    },
  };
}

function makeEntryForPath(path: string): VaultPreviewEntry {
  const current = makeState({ path, basename: path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? path });
  return makeEntry(current, makeResult(makeState({ ...current, frontmatter: { status: "done" } })));
}

function makeApp(
  file: TFile,
  cache: CachedMetadata,
  processFrontMatter: App["fileManager"]["processFrontMatter"],
  bodyContent = "",
  existingPaths: readonly string[] = [],
  renameFile: App["fileManager"]["renameFile"] = async () => {},
): App {
  return {
    metadataCache: {
      getFileCache: () => cache,
    },
    fileManager: {
      processFrontMatter,
      renameFile,
    },
    vault: {
      configDir: ".obsidian",
      cachedRead: async () => bodyContent,
      getFileByPath: (path: string) => path === file.path ? file : null,
      getAbstractFileByPath: (path: string) => {
        if (path === file.path) return file;
        if (existingPaths.includes(path)) {
          const existingFile = new TFile();
          existingFile.path = path;
          return existingFile;
        }
        return null;
      },
      createFolder: async () => ({ children: [], name: "", parent: null, path: "" }),
    },
  } as unknown as App;
}

describe("VaultPreviewModal rendering", () => {
  function renderingHarness(entries: VaultPreviewEntry[]) {
    const modal = new VaultPreviewModal({} as App, entries);
    const root = new TestElement();
    modal.contentEl = root.asElement();
    modal.onOpen();
    const button = (text: string): TestElement => {
      const found = root.all("button").find((el) => el.textContent === text);
      if (found === undefined) throw new Error(`Missing button ${text}`);
      return found;
    };
    return { modal, root, button };
  }

  it("bounds rendering and keeps selections across pages", async () => {
    const entries = Array.from({ length: 250 }, (_, index) => makeEntryForPath(`Inbox/${index}.md`));
    const { modal, root, button } = renderingHarness(entries);
    const harness = modal as unknown as { selected: Set<VaultPreviewEntry> };
    expect(root.all("input").filter((el) => el.attributes.type === "checkbox")).toHaveLength(100);
    expect(button("Previous").disabled).toBe(true);
    expect(button("Apply selected").disabled).toBe(true);
    const first = root.all("input").filter((el) => el.attributes.type === "checkbox")[0];
    expect(first?.attributes["aria-label"]).toBe("Apply planned change for Inbox/0.md");
    expect(root.all("th").every((el) => el.attributes.scope === "col")).toBe(true);
    if (first === undefined) throw new Error("Missing first checkbox");
    first.checked = true;
    await first.fire("change");
    await button("Next").fire("click");
    expect(root.all("input").filter((el) => el.attributes.type === "checkbox")).toHaveLength(100);
    const secondPageFirst = root.all("input").filter((el) => el.attributes.type === "checkbox")[0];
    if (secondPageFirst === undefined) throw new Error("Missing second-page checkbox");
    secondPageFirst.checked = true;
    await secondPageFirst.fire("change");
    await button("Next").fire("click");
    expect(root.all("input").filter((el) => el.attributes.type === "checkbox")).toHaveLength(50);
    expect(button("Next").disabled).toBe(true);
    expect(root.all("span").some((el) => el.textContent === "2 selected of 250 pending changes (all pages); 250 match filters")).toBe(true);
    await button("Previous").fire("click");
    await button("Previous").fire("click");
    expect(root.all("input").filter((el) => el.attributes.type === "checkbox")[0]?.checked).toBe(true);
    expect([...harness.selected]).toEqual([entries[0], entries[100]]);
    const returned = root.all("input").filter((el) => el.attributes.type === "checkbox")[0];
    if (returned === undefined) throw new Error("Missing returned checkbox");
    returned.checked = false;
    await returned.fire("change");
    expect([...harness.selected]).toEqual([entries[100]]);
  });

  it("selects only applyable filtered rows up to the batch limit and preserves hidden selections", async () => {
    const entries = Array.from({ length: 201 }, (_, index) => makeEntryForPath(`${index < 150 ? "Inbox" : "Archive"}/${index}.md`));
    const { modal, root, button } = renderingHarness(entries);
    const harness = modal as unknown as { selected: Set<VaultPreviewEntry> };
    await button("Select filtered (batch limit)").fire("click");
    expect(harness.selected.size).toBe(100);
    const search = root.all("input").find((el) => el.attributes.type === "search") as unknown as HTMLInputElement & TestElement;
    search.value = "Archive";
    await search.fire("input");
    expect(root.all("span").some((el) => el.textContent.includes("100 selected outside filters"))).toBe(true);
    await button("Deselect filtered").fire("click");
    expect(harness.selected.size).toBe(100);
    await button("Clear selection").fire("click");
    await button("Select filtered (batch limit)").fire("click");
    expect(harness.selected.size).toBe(51);
    expect([...harness.selected].every((entry) => entry.path.startsWith("Archive/"))).toBe(true);
  });

  it("applies exactly the selected rows, including off-page selections", async () => {
    const entries = Array.from({ length: 201 }, (_, index) => ({ ...makeEntryForPath(`Inbox/${index}.md`), selected: index === 0 || index === 200 }));
    const { modal, root, button } = renderingHarness(entries);
    const harness = modal as unknown as VaultPreviewApplyHarness;
    const apply = vi.spyOn(harness, "applySelected").mockResolvedValue();
    const confirm = vi.spyOn(ConfirmationModal.prototype, "addButton").mockImplementation(function (this: ConfirmationModal, callback) {
      // Confirm through the native confirmation-button callback contract.
      const confirmationButton = {
        setButtonText() { return this; }, setCta() { return this; }, setInitialFocus() { return this; },
        onClick(handler: () => void) { handler(); return this; },
      };
      callback(confirmationButton as unknown as Parameters<typeof callback>[0]);
      return this;
    });
    const close = vi.spyOn(modal, "close");
    await button("Apply selected").fire("click");
    expect(apply).toHaveBeenCalledWith([entries[0], entries[200]]);
    expect(root.all("input").every((el) => el.disabled)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it("does not preselect non-applyable rows", () => {
    const entry = { ...makeNullResultEntry(makeState()), selected: true };
    const { root, button } = renderingHarness([entry]);
    expect(root.all("input").filter((el) => el.attributes.type === "checkbox")[0]?.checked).toBe(false);
    expect(root.all("input").filter((el) => el.attributes.type === "checkbox")[0]?.disabled).toBe(true);
    expect(button("Apply selected").disabled).toBe(true);
  });
});

describe("VaultPreviewModal applySelected", () => {
  it("skips stale preview rows without overwriting newer frontmatter", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState();
    const result = makeResult(makeState({ frontmatter: { status: "done" } }));
    const processFrontMatter = vi.fn(async (_file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      callback({ status: "blocked" });
    });
    const decisions: ReconciliationDecision[] = [];
    const app = makeApp(file, { frontmatter: { status: "blocked" }, tags: [] }, processFrontMatter);
    const modal = new VaultPreviewModal(app, [], {
      now: () => 10,
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result)]);

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "skipped", path: "Inbox/note.md" }]);
    expect(decisions[0]?.message).toContain("changed since the preview was generated");
  });

  it("skips stale preview rows when body-derived state changed", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState({ bodyH1: "Original title", bodyContent: "original body" });
    const result = makeResult(makeState({ bodyH1: "Original title", bodyContent: "original body", frontmatter: { status: "done" } }));
    const processFrontMatter = vi.fn(async (_file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      callback({ status: "todo" });
    });
    const decisions: ReconciliationDecision[] = [];
    const app = makeApp(file, {
      frontmatter: { status: "todo" },
      tags: [],
      headings: [{
        heading: "Updated title",
        level: 1,
        position: {
          start: { line: 0, col: 0, offset: 0 },
          end: { line: 0, col: 15, offset: 15 },
        },
      }],
    }, processFrontMatter, "original body");
    const modal = new VaultPreviewModal(app, [], {
      now: () => 10,
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result, true)]);

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "skipped", path: "Inbox/note.md" }]);
  });

  it("records body read failures during preview apply as errors", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState({ bodyContent: "matching body" });
    const result = makeResult(makeState({ bodyContent: "matching body", frontmatter: { status: "done" } }));
    const processFrontMatter = vi.fn(async () => {});
    const decisions: ReconciliationDecision[] = [];
    const app = makeApp(file, { frontmatter: { status: "todo" }, tags: [] }, processFrontMatter, "");
    app.vault.cachedRead = async () => {
      throw new Error("read failed");
    };
    const modal = new VaultPreviewModal(app, [], {
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result, true)]);

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "error", path: "Inbox/note.md" }]);
    expect(decisions[0]?.message).toContain("read failed");
  });

  it("applies unchanged content-based preview rows after reloading body content", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState({ bodyContent: "matching body" });
    const result = makeResult(makeState({ bodyContent: "matching body", frontmatter: { status: "done" } }));
    const written: Record<string, unknown> = { status: "todo" };
    const processFrontMatter = vi.fn(async (_file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      callback(written);
    });
    const decisions: ReconciliationDecision[] = [];
    const app = makeApp(file, { frontmatter: { status: "todo" }, tags: [] }, processFrontMatter, "matching body");
    const modal = new VaultPreviewModal(app, [], {
      now: () => 12,
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result, true)]);

    expect(written.status).toBe("done");
    expect(decisions).toMatchObject([{ outcome: "changed", path: "Inbox/note.md" }]);
  });

  it("strips frontmatter again when revalidating content-dependent plans", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState({ bodyContent: "matching body" });
    const result = makeResult(makeState({ bodyContent: "matching body", frontmatter: { status: "done" } }));
    const written: Record<string, unknown> = { status: "todo" };
    const processFrontMatter = vi.fn(async (_file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      callback(written);
    });
    const app = makeApp(
      file,
      { frontmatter: { status: "todo" }, tags: [] },
      processFrontMatter,
      "---\nstatus: todo\n---\nmatching body",
    );
    const modal = new VaultPreviewModal(app, []) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result, true)]);

    expect(processFrontMatter).toHaveBeenCalled();
    expect(written.status).toBe("done");
  });

  it("revalidates body content for content-dependent plans when preview body was missing", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState({ bodyContent: undefined });
    const result = makeResult(makeState({ bodyContent: undefined, frontmatter: { status: "done" } }));
    const processFrontMatter = vi.fn(async () => {});
    const decisions: ReconciliationDecision[] = [];
    const app = makeApp(file, { frontmatter: { status: "todo" }, tags: [] }, processFrontMatter, "new body");
    const modal = new VaultPreviewModal(app, [], {
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result, true)]);

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "skipped", path: "Inbox/note.md" }]);
    expect(decisions[0]?.message).toContain("changed since the preview was generated");
  });

  it("re-resolves preview path collisions at apply time", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState();
    const result = makeResult(
      makeState({ path: "Done/note.md" }),
      [{ kind: "move", ruleIds: ["move"] }],
    );
    const processFrontMatter = vi.fn(async () => {});
    const renameFile = vi.fn(async () => {});
    const decisions: ReconciliationDecision[] = [];
    const app = makeApp(file, { frontmatter: { status: "todo" }, tags: [] }, processFrontMatter, "", ["Done/note.md"], renameFile);
    const modal = new VaultPreviewModal(app, [], {
      collisionPolicy: () => "rename-with-suffix",
      now: () => 13,
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result)]);

    expect(renameFile).toHaveBeenCalledWith(file, "Done/note 1.md");
    expect(decisions).toMatchObject([{ outcome: "changed", desiredPath: "Done/note 1.md" }]);
  });

  it("resolves a changed suffix from the original collision target", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState();
    const result = makeResult(
      makeState({ path: "Done/note 1.md", basename: "note 1" }),
      [{ kind: "move", ruleIds: ["move"] }],
    );
    const renameFile = vi.fn(async () => {});
    const app = makeApp(
      file,
      { frontmatter: { status: "todo" }, tags: [] },
      async () => {},
      "",
      ["Done/note.md", "Done/note 1.md"],
      renameFile,
    );
    const modal = new VaultPreviewModal(app, [], {
      collisionPolicy: () => "rename-with-suffix",
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result, false, "Done/note.md")]);

    expect(renameFile).toHaveBeenCalledWith(file, "Done/note 2.md");
  });

  it("does not treat tag-order-only changes as stale", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState({
      frontmatter: { tags: ["a", "b"] },
      rawFrontmatter: { tags: ["a", "b"] },
      tags: ["a", "b"],
    });
    const result = makeResult(makeState({ frontmatter: { tags: ["a", "b"], status: "done" }, tags: ["a", "b"] }));
    const written: Record<string, unknown> = { tags: ["b", "a"] };
    const processFrontMatter = vi.fn(async (_file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      callback(written);
    });
    const app = makeApp(file, { frontmatter: { tags: ["b", "a"] }, tags: [] }, processFrontMatter);
    const modal = new VaultPreviewModal(app, []) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result)]);

    expect(processFrontMatter).toHaveBeenCalled();
    expect(written.status).toBe("done");
  });

  it("records applied preview rows for diagnostics and undo", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState();
    const result = makeResult(makeState({ frontmatter: { status: "done" } }));
    const written: Record<string, unknown> = { status: "todo" };
    const processFrontMatter = vi.fn(async (_file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      callback(written);
    });
    const decisions: ReconciliationDecision[] = [];
    const app = makeApp(file, { frontmatter: { status: "todo" }, tags: [] }, processFrontMatter);
    const modal = new VaultPreviewModal(app, [], {
      now: () => 11,
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result)]);

    expect(written.status).toBe("done");
    expect(decisions).toMatchObject([{
      timestamp: 11,
      outcome: "changed",
      path: "Inbox/note.md",
      appliedRuleIds: ["status"],
      mutationKinds: ["frontmatter"],
      beforeFrontmatter: { status: "todo" },
      afterFrontmatter: { status: "done" },
    }]);
  });

  it("runs a one-time batch preflight before applying any rows", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState();
    const result = makeResult(makeState({ frontmatter: { status: "done" } }));
    const processFrontMatter = vi.fn(async () => {});
    const app = makeApp(file, { frontmatter: { status: "todo" }, tags: [] }, processFrontMatter);
    const preflightApply = vi.fn(() => { throw new Error("Base results changed"); });
    const modal = new VaultPreviewModal(app, [], { preflightApply }) as unknown as VaultPreviewApplyHarness;

    await expect(modal.applySelected([makeEntry(previewCurrent, result)])).rejects.toThrow("Base results changed");

    expect(preflightApply).toHaveBeenCalledOnce();
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it("rechecks apply permission immediately before writing", async () => {
    const file = makeFile("Inbox/note.md");
    const previewCurrent = makeState();
    const result = makeResult(makeState({ frontmatter: { status: "done" } }));
    const processFrontMatter = vi.fn(async () => {});
    const decisions: ReconciliationDecision[] = [];
    let permissionChecks = 0;
    const app = makeApp(file, { frontmatter: { status: "todo" }, tags: [] }, processFrontMatter);
    const modal = new VaultPreviewModal(app, [], {
      assertCanApply: () => {
        permissionChecks += 1;
        if (permissionChecks > 1) throw new Error("automation disabled");
      },
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeEntry(previewCurrent, result)]);

    expect(permissionChecks).toBe(2);
    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "error", path: "Inbox/note.md" }]);
    expect(decisions[0]?.message).toContain("automation disabled");
  });

  it("records selected null-result preview rows as skipped", async () => {
    const file = makeFile("Inbox/note.md");
    const decisions: ReconciliationDecision[] = [];
    const processFrontMatter = vi.fn(async () => {});
    const app = makeApp(file, { frontmatter: { status: "todo" }, tags: [] }, processFrontMatter);
    const modal = new VaultPreviewModal(app, [], {
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([makeNullResultEntry(makeState())]);

    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(decisions).toMatchObject([{ outcome: "skipped", path: "Inbox/note.md" }]);
    expect(decisions[0]?.message).toContain("no applyable reconciliation result");
  });

  it("records row errors and continues applying later preview rows", async () => {
    const firstFile = makeFile("Inbox/first.md");
    const secondFile = makeFile("Inbox/second.md");
    const thirdFile = makeFile("Inbox/third.md");
    const files = new Map([
      [firstFile.path, firstFile],
      [secondFile.path, secondFile],
      [thirdFile.path, thirdFile],
    ]);
    const writtenByPath = new Map<string, Record<string, unknown>>([
      [firstFile.path, { status: "todo" }],
      [secondFile.path, { status: "todo" }],
      [thirdFile.path, { status: "todo" }],
    ]);
    const processFrontMatter = vi.fn(async (file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      if (file.path === secondFile.path) {
        throw new Error("write failed");
      }
      const frontmatter = writtenByPath.get(file.path);
      if (frontmatter !== undefined) {
        callback(frontmatter);
      }
    });
    const decisions: ReconciliationDecision[] = [];
    const app = {
      metadataCache: {
        getFileCache: () => ({ frontmatter: { status: "todo" }, tags: [] }),
      },
      fileManager: {
        processFrontMatter,
        renameFile: async () => {},
      },
      vault: {
        configDir: ".obsidian",
        cachedRead: async () => "",
        getFileByPath: (path: string) => files.get(path) ?? null,
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        createFolder: async () => ({ children: [], name: "", parent: null, path: "" }),
      },
    } as unknown as App;
    const modal = new VaultPreviewModal(app, [], {
      recordDecision: (decision) => { decisions.push(decision); },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([
      makeEntryForPath(firstFile.path),
      makeEntryForPath(secondFile.path),
      makeEntryForPath(thirdFile.path),
    ]);

    expect(writtenByPath.get(firstFile.path)?.status).toBe("done");
    expect(writtenByPath.get(thirdFile.path)?.status).toBe("done");
    expect(decisions.map((decision) => decision.outcome)).toEqual(["changed", "error", "changed"]);
    expect(decisions[1]?.message).toContain("write failed");
  });

  it("continues applying rows when decision recording fails", async () => {
    const firstFile = makeFile("Inbox/first.md");
    const secondFile = makeFile("Inbox/second.md");
    const files = new Map([
      [firstFile.path, firstFile],
      [secondFile.path, secondFile],
    ]);
    const writtenByPath = new Map<string, Record<string, unknown>>([
      [firstFile.path, { status: "todo" }],
      [secondFile.path, { status: "todo" }],
    ]);
    const processFrontMatter = vi.fn(async (file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      const frontmatter = writtenByPath.get(file.path);
      if (frontmatter !== undefined) {
        callback(frontmatter);
      }
    });
    const app = {
      metadataCache: {
        getFileCache: () => ({ frontmatter: { status: "todo" }, tags: [] }),
      },
      fileManager: {
        processFrontMatter,
        renameFile: async () => {},
      },
      vault: {
        configDir: ".obsidian",
        cachedRead: async () => "",
        getFileByPath: (path: string) => files.get(path) ?? null,
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        createFolder: async () => ({ children: [], name: "", parent: null, path: "" }),
      },
    } as unknown as App;
    const modal = new VaultPreviewModal(app, [], {
      recordDecision: () => {
        throw new Error("diagnostics failed");
      },
    }) as unknown as VaultPreviewApplyHarness;

    await modal.applySelected([
      makeEntryForPath(firstFile.path),
      makeEntryForPath(secondFile.path),
    ]);

    expect(writtenByPath.get(firstFile.path)?.status).toBe("done");
    expect(writtenByPath.get(secondFile.path)?.status).toBe("done");
  });
});
