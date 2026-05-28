import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, BasesEntry, QueryController, Value } from "obsidian";
import { BooleanValue, LinkValue, NumberValue, StringValue, TFile } from "obsidian";
import { paginateBasesGroups, planBasesEntry, VaultFlowBasesView, type PlannedBasesGroup } from "../../src/obsidian/bases-view";
import { VaultPreviewModal, type VaultPreviewApplyCallbacks, type VaultPreviewEntry } from "../../src/obsidian/vault-preview-modal";
import { TestElement } from "../helpers/dom";
import { DEFAULT_SETTINGS } from "../../src/obsidian/settings";

function file(path: string): TFile {
  const value = new TFile();
  value.path = path;
  value.basename = path.split("/").at(-1)?.replace(/\.md$/u, "") ?? path;
  value.extension = "md";
  value.stat = { ctime: 1, mtime: 2, size: 0 };
  return value;
}

function app(): App {
  return {
    metadataCache: { getFileCache: () => ({ frontmatter: {}, tags: [] }) },
    vault: {
      configDir: ".obsidian",
      cachedRead: async () => "",
      getAbstractFileByPath: () => null,
    },
  } as unknown as App;
}

function entry(note: TFile, destination: Value | null): BasesEntry {
  return {
    file: note,
    getValue: () => destination,
  };
}

interface BasesViewHarness {
  app: App;
  data: { data: BasesEntry[] };
  refreshPlans(): Promise<void>;
  refreshPlansSafely(): Promise<void>;
  render(): void;
  entries: VaultPreviewEntry[];
  selectedPaths: Set<string>;
  planCache: Map<string, unknown>;
}

describe("Vault Flow Bases query snapshots", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  function viewHarness(previewCallbacks: VaultPreviewApplyCallbacks = {}) {
    const root = new TestElement();
    const settings = {
      ...DEFAULT_SETTINGS,
      rules: [{
        id: "content", name: "content", enabled: true, priority: 0, order: 0,
        when: { type: "contentContains" as const, text: "match" },
        then: { moveTo: "Archive" },
      }],
    };
    const view = new VaultFlowBasesView({} as QueryController, root.asElement(), {
      getSettings: () => settings,
      getSettingsRevision: () => 1,
      previewCallbacks,
    });
    const harness = view as unknown as BasesViewHarness;
    harness.app = app();
    harness.data.data = [entry(file("Inbox/note.md"), null)];
    return { view, harness, root };
  }

  it("renders a recoverable error when planning fails", async () => {
    vi.useFakeTimers();
    const root = new TestElement();
    let fail = true;
    const view = new VaultFlowBasesView({} as QueryController, root.asElement(), {
      getSettings: () => { if (fail) throw new Error("temporary failure"); return DEFAULT_SETTINGS; },
      getSettingsRevision: () => 1, previewCallbacks: {},
    });
    const harness = view as unknown as BasesViewHarness;
    harness.app = app();
    await harness.refreshPlansSafely();
    expect(root.all("p").some((element) => element.textContent.includes("temporary failure"))).toBe(true);
    expect(harness.entries).toEqual([]);
    fail = false;
    await root.all("button").find((element) => element.textContent === "Retry")?.fire("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(root.all("button").some((element) => element.textContent === "Refresh")).toBe(true);
    view.onunload();
  });

  it("discards delayed plans when results change before the debounce fires", async () => {
    vi.useFakeTimers();
    const { view, harness, root } = viewHarness();
    let finishRead!: (content: string) => void;
    harness.app.vault.cachedRead = () => new Promise<string>((resolve) => { finishRead = resolve; });
    const pending = harness.refreshPlans();

    harness.data.data = [];
    view.onDataUpdated();
    finishRead("match");
    await pending;

    expect(harness.entries).toEqual([]);
    expect(harness.planCache.size).toBe(0);
    expect(root.all("button")).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(root.all("span").some((el) => el.textContent.includes("0 Markdown results"))).toBe(true);
    view.onunload();
  });

  it("keeps the rendered revision when an old preview button is invoked", async () => {
    vi.useFakeTimers();
    const { view, harness, root } = viewHarness();
    harness.app.vault.cachedRead = async () => "match";
    await harness.refreshPlans();
    harness.selectedPaths.add("Inbox/note.md");
    harness.render();
    const button = root.all("button").find((el) => el.textContent === "Open apply preview");
    expect(button).toBeDefined();
    const open = vi.spyOn(VaultPreviewModal.prototype, "open");

    harness.data.data = [];
    view.onDataUpdated();
    await button?.fire("click");
    expect(open).toHaveBeenCalledOnce();
    const modal = open.mock.instances[0] as { applySelected(entries: VaultPreviewEntry[]): Promise<void> };
    await expect(modal.applySelected(harness.entries)).rejects.toThrow("Base results or configuration changed");
    view.onunload();
  });

  it("replans transient metadata errors without requiring an explicit cache clear", async () => {
    const { view, harness } = viewHarness();
    const getCache = vi.spyOn(harness.app.metadataCache, "getFileCache").mockReturnValue(null);
    await harness.refreshPlans();
    expect(harness.entries[0]?.preview.preview.outcome).toBe("error");
    expect(harness.planCache.size).toBe(0);
    getCache.mockReturnValue({ frontmatter: {}, tags: [] });
    harness.app.vault.cachedRead = async () => "match";
    await harness.refreshPlans();
    expect(harness.entries[0]?.preview.preview.outcome).toBe("changed");
    view.onunload();
  });

  it.each(["lock wait", "body read"])("rejects a Base revision changed during %s before the first mutation", async (waitAt) => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { view, harness, root } = viewHarness({
      runExclusive: async (operation) => { if (waitAt === "lock wait") await blocked; return operation(); },
    });
    harness.app.vault.cachedRead = async () => "match";
    await harness.refreshPlans();
    const entries = harness.entries;
    const note = harness.data.data[0]?.file;
    Object.assign(harness.app.vault, { getFileByPath: () => note });
    const renameFile = vi.fn();
    Object.assign(harness.app, { fileManager: { renameFile } });
    harness.selectedPaths.add(note?.path ?? "");
    harness.render();
    const open = vi.spyOn(VaultPreviewModal.prototype, "open");
    await root.all("button").find((el) => el.textContent === "Open apply preview")?.fire("click");
    const modal = open.mock.instances[0] as { applySelected(entries: VaultPreviewEntry[]): Promise<void> };
    if (waitAt === "body read") harness.app.vault.cachedRead = async () => { await blocked; return "match"; };
    const applying = modal.applySelected(entries);
    harness.data.data = [];
    view.onDataUpdated();
    release();
    await applying;
    expect(renameFile).not.toHaveBeenCalled();
    view.onunload();
  });

  it("invalidates pending work on unload without repopulating its cache", async () => {
    const { view, harness } = viewHarness();
    let finishRead!: (content: string) => void;
    harness.app.vault.cachedRead = () => new Promise<string>((resolve) => { finishRead = resolve; });
    const pending = harness.refreshPlans();
    view.onunload();
    finishRead("match");
    await pending;
    expect(harness.entries).toEqual([]);
    expect(harness.planCache.size).toBe(0);
  });
});

describe("Vault Flow Bases pagination", () => {
  const previewEntry = (path: string): VaultPreviewEntry => ({ path } as VaultPreviewEntry);

  it("preserves group boundaries while bounding the rendered page", () => {
    const groups: PlannedBasesGroup[] = [
      { label: "First", entries: [previewEntry("a.md"), previewEntry("b.md")] },
      { label: "Second", entries: [previewEntry("c.md"), previewEntry("d.md"), previewEntry("e.md")] },
    ];

    expect(paginateBasesGroups(groups, 1, 2)).toEqual([
      { label: "Second", entries: [previewEntry("c.md"), previewEntry("d.md")] },
    ]);
    expect(paginateBasesGroups(groups, 2, 2)).toEqual([
      { label: "Second", entries: [previewEntry("e.md")] },
    ]);
  });
});

describe("Vault Flow Bases planning", () => {
  it("uses explicit folder intent for dotted names and treats computed braces literally", async () => {
    const plan = await planBasesEntry(app(), entry(file("Inbox/note.md"), new StringValue("Client.v2/{literal}")), DEFAULT_SETTINGS, "destination", "formula.destination", "Destination", 0, { destinationKind: "folder" });
    expect(plan.preview.desiredPath).toBe("Client.v2/{literal}/note.md");
  });

  it("preserves the extension in explicit file-valued link destinations", async () => {
    const plan = await planBasesEntry(app(), entry(file("Inbox/note.md"), new LinkValue("[[Archive/renamed.md|Name]]")), DEFAULT_SETTINGS, "destination", "formula.destination", "Destination", 0, { destinationKind: "file" });
    expect(plan.preview.desiredPath).toBe("Archive/renamed.md");
  });

  it("uses text formulas for literal renames", async () => {
    const plan = await planBasesEntry(app(), entry(file("Inbox/note.md"), new StringValue("{literal} title")), DEFAULT_SETTINGS, "rename", "formula.name", "Name", 0);
    expect(plan.preview.desiredPath).toBe("Inbox/{literal} title.md");
  });

  it.each([
    [new StringValue("done"), "done"],
    [new BooleanValue(false), false],
    [new NumberValue(0), 0],
  ])("preserves scalar types in formula-derived property updates", async (value, expected) => {
    const plan = await planBasesEntry(app(), entry(file("Inbox/note.md"), value), DEFAULT_SETTINGS, "property", "formula.value", "Value", 0, { propertyName: "status" });
    expect(plan.result?.desired.frontmatter.status).toBe(expected);
    expect(plan.preview.outcome).toBe("changed");
  });

  it("rejects unsafe derived properties and file destinations", async () => {
    const note = entry(file("Inbox/note.md"), new StringValue("value"));
    const property = await planBasesEntry(app(), note, DEFAULT_SETTINGS, "property", "formula.value", "Value", 0, { propertyName: "__proto__" });
    expect(property.preview.outcome).toBe("error");
    const destination = await planBasesEntry(app(), entry(file("Inbox/note.md"), new StringValue("../outside.md")), DEFAULT_SETTINGS, "destination", "formula.value", "Value", 0, { destinationKind: "file" });
    expect(destination.preview.outcome).toBe("error");
  });

  it("uses a Base formula or property value as a move destination", async () => {
    const note = file("Inbox/note.md");
    const plan = await planBasesEntry(
      app(),
      entry(note, new StringValue("Archive/")),
      DEFAULT_SETTINGS,
      "destination",
      "formula.destination",
      "Destination",
      0,
    );

    expect(plan.preview.outcome).toBe("changed");
    expect(plan.preview.desiredPath).toBe("Archive/note.md");
  });

  it("resolves wikilink destination values to path text", async () => {
    const note = file("Inbox/note.md");
    const plan = await planBasesEntry(
      app(),
      entry(note, new LinkValue("[[Archive/Projects.md#Queue|Project queue]]")),
      DEFAULT_SETTINGS,
      "destination",
      "note.destination",
      "Destination",
      0,
    );

    expect(plan.preview.outcome).toBe("changed");
    expect(plan.preview.desiredPath).toBe("Archive/Projects/note.md");
  });

  it("rejects unsupported typed destination values", async () => {
    const note = file("Inbox/note.md");
    const plan = await planBasesEntry(
      app(),
      entry(note, new NumberValue(2026)),
      DEFAULT_SETTINGS,
      "destination",
      "formula.destination",
      "Destination",
      0,
    );

    expect(plan.preview.outcome).toBe("error");
    expect(plan.preview.message).toContain("unsupported type NumberValue");
    expect(plan.result).toBeNull();
  });

  it("reports a missing destination property as a non-applyable error", async () => {
    const note = file("Inbox/note.md");
    const plan = await planBasesEntry(app(), entry(note, null), DEFAULT_SETTINGS, "destination", null, "Destination", 0);

    expect(plan.preview.outcome).toBe("error");
    expect(plan.result).toBeNull();
  });
});
