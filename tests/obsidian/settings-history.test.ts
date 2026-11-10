import { describe, expect, it, vi } from "vitest";
import { ConfirmationModal, type App, type PluginManifest } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import { DEFAULT_SETTINGS, settingsDataForSave } from "../../src/obsidian/settings";
import { SettingsRevisionHistory, SETTINGS_HISTORY_KEY, MAX_SETTINGS_HISTORY_BYTES, MAX_SETTINGS_REVISIONS, MAX_SETTINGS_REVISION_BYTES } from "../../src/obsidian/settings-history";
import { SettingsHistoryModal, type SettingsRestoreRequest } from "../../src/obsidian/settings-history-modal";
import { TestElement } from "../helpers/dom";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";

function store() {
  const values = new Map<string, unknown>();
  const app = { loadLocalStorage: vi.fn((key: string) => values.get(key) ?? null), saveLocalStorage: vi.fn((key: string, value: unknown) => { values.set(key, structuredClone(value)); }) };
  return { values, app };
}
function host() {
  const { values, app: storage } = store();
  const writes = vi.fn();
  const app = { ...storage, fileManager: { processFrontMatter: writes, renameFile: writes } } as unknown as App;
  const plugin = new VaultFlowPlugin(app, {} as PluginManifest);
  plugin.settings = { ...DEFAULT_SETTINGS, sweepOnStartup: false, trackedMtimes: { "note.md": 42 } };
  const history = new SettingsRevisionHistory(storage, () => 1);
  history.capture(plugin.settings, "startup");
  const internal = plugin as unknown as { loaded: boolean; settingsHistory: SettingsRevisionHistory; prepareSettingsRestore(id: string): SettingsRestoreRequest };
  internal.loaded = true; internal.settingsHistory = history;
  const save = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
  const load = vi.spyOn(plugin, "loadData").mockImplementation(async () => settingsDataForSave(plugin.settings));
  return { plugin, internal, history, storage, values, writes, save, load };
}

describe("bounded settings revisions", () => {
  it("deduplicates snapshots, excludes runtime state, survives restart, and retains 20 revisions", () => {
    const { app, values } = store();
    const history = new SettingsRevisionHistory(app, () => 1);
    const settings = { ...DEFAULT_SETTINGS, trackedMtimes: { "secret-note.md": 1 }, ruleStats: { secret: { matchCount: 2, lastMatchAt: 1 } } };
    history.capture(settings, "startup"); history.capture(settings, "startup");
    expect(history.entries()).toHaveLength(1);
    expect(history.entries()[0].data).not.toContain("secret-note");
    expect(history.entries()[0].data).not.toContain("ruleStats");
    for (let i = 1; i <= 30; i++) history.capture({ ...settings, debounceMs: i }, "edit");
    expect(history.entries()).toHaveLength(MAX_SETTINGS_REVISIONS);
    const reloaded = new SettingsRevisionHistory(app);
    expect(reloaded.entries()).toEqual(history.entries());
    expect(reloaded.candidate(reloaded.entries()[0].id).debounceMs).toBe(11);
    expect(values.has(SETTINGS_HISTORY_KEY)).toBe(true);
  });

  it("bounds the UTF-8 envelope, including multibyte rule values", () => {
    const { app, values } = store();
    const history = new SettingsRevisionHistory(app);
    for (let i = 0; i < 10; i++) history.capture({ ...DEFAULT_SETTINGS, disableFrontmatterKey: `revision-${i}-${"🦉".repeat(80_000)}` }, "edit");
    expect(history.entries().length).toBeLessThan(10);
    expect(new TextEncoder().encode(JSON.stringify(values.get(SETTINGS_HISTORY_KEY))).byteLength).toBeLessThanOrEqual(MAX_SETTINGS_HISTORY_BYTES);
    const count = history.entries().length;
    expect(() => history.capture({ ...DEFAULT_SETTINGS, disableFrontmatterKey: "x".repeat(MAX_SETTINGS_REVISION_BYTES) }, "edit")).toThrow(/512 KiB/u);
    expect(history.entries()).toHaveLength(count);
  });

  it("preserves corrupt or unknown storage and keeps memory unchanged after a failed save", () => {
    const { app, values } = store();
    values.set(SETTINGS_HISTORY_KEY, { version: 2, revisions: [] });
    const blocked = new SettingsRevisionHistory(app);
    expect(blocked.blockedReason).not.toBeNull();
    expect(() => blocked.capture(DEFAULT_SETTINGS, "edit")).toThrow();
    expect(app.saveLocalStorage).not.toHaveBeenCalled();
    values.delete(SETTINGS_HISTORY_KEY);
    const history = new SettingsRevisionHistory(app);
    history.capture(DEFAULT_SETTINGS, "startup");
    app.saveLocalStorage.mockImplementation(() => { throw new Error("Local storage unavailable"); });
    expect(() => history.capture({ ...DEFAULT_SETTINGS, debounceMs: 1 }, "edit")).toThrow(/unavailable/u);
    expect(history.entries()).toHaveLength(1);
  });

  it("refuses invalid or lossy snapshots before restoring, including deeply nested JSON", () => {
    const { app, values } = store();
    const nested = `${'{"type":"not","predicate":'.repeat(8_000)}{"type":"pathGlob","glob":"**"}${"}".repeat(8_000)}`;
    for (const data of ["null", '{"settingsVersion":999}', `{"settingsVersion":4,"rules":[{"when":${nested}}]}`]) {
      values.set(SETTINGS_HISTORY_KEY, { version: 1, revisions: [{ id: "invalid", timestamp: 1, source: "startup", data }] });
      const history = new SettingsRevisionHistory(app);
      expect(() => history.candidate("invalid")).toThrow(/losslessly/u);
      expect(app.saveLocalStorage).not.toHaveBeenCalled();
    }
  });
});

describe("guarded settings restore", () => {
  it("retains external revisions and the last good configuration before incompatible reloads without rewriting settings", async () => {
    const { plugin, internal, history, load, save } = host();
    load.mockResolvedValue({ ...settingsDataForSave(plugin.settings), debounceMs: 123 });
    await plugin.onExternalSettingsChange();
    expect(history.entries().at(-1)?.source).toBe("external");
    expect(history.candidate(history.entries().at(-1)?.id ?? "").debounceMs).toBe(123);
    load.mockResolvedValue({ settingsVersion: 999, rules: [] });
    await plugin.onExternalSettingsChange();
    expect(history.candidate(history.entries().at(-1)?.id ?? "").debounceMs).toBe(123);
    expect(() => internal.prepareSettingsRestore(history.entries()[0].id)).toThrow(/compatible/u);
    expect(save).not.toHaveBeenCalled();
  });

  it("restores configuration only, preserves runtime state and remains paused without note writes", async () => {
    const { plugin, internal, history, save, writes } = host();
    const original = history.entries()[0].id;
    await plugin.updateSettings({ dryRun: false, debounceMs: 123 });
    await internal.prepareSettingsRestore(original).apply();
    expect(plugin.settings).toMatchObject({ dryRun: true, debounceMs: 500, trackedMtimes: { "note.md": 42 } });
    expect(plugin.isAutomationPaused()).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(writes).not.toHaveBeenCalled();
    expect(history.entries().at(-1)?.source).toBe("restore");
  });

  it("rejects concurrent in-memory and unobserved disk changes", async () => {
    const { plugin, internal, history, load, save } = host();
    const prepared = internal.prepareSettingsRestore(history.entries()[0].id);
    await plugin.updateSettings({ debounceMs: 123 });
    await expect(prepared.apply()).rejects.toThrow(/changed while/u);
    expect(save).toHaveBeenCalledOnce();
    const next = internal.prepareSettingsRestore(history.entries()[0].id);
    load.mockResolvedValue({ ...settingsDataForSave(plugin.settings), debounceMs: 999 });
    await expect(next.apply()).rejects.toThrow(/changed on disk/u);
    expect(save).toHaveBeenCalledOnce();
    expect(plugin.settings.debounceMs).toBe(123);
  });

  it("fails closed when the pre-restore backup cannot be retained", async () => {
    const { plugin, internal, history, storage, save } = host();
    const original = history.entries()[0].id;
    plugin.settings = { ...plugin.settings, debounceMs: 123 };
    storage.saveLocalStorage.mockImplementation(() => { throw new Error("Storage full"); });
    await expect(internal.prepareSettingsRestore(original).apply()).rejects.toThrow(/Storage full/u);
    expect(plugin.settings.debounceMs).toBe(123);
    expect(save).not.toHaveBeenCalled();
  });

  it("rolls back the in-memory configuration and stays paused after a settings write fails", async () => {
    const { plugin, internal, history, save } = host();
    const original = history.entries()[0].id;
    await plugin.updateSettings({ debounceMs: 123 });
    save.mockRejectedValue(new Error("Settings write failed"));
    await expect(internal.prepareSettingsRestore(original).apply()).rejects.toThrow(/write failed/u);
    expect(plugin.settings.debounceMs).toBe(123);
    expect(plugin.isAutomationPaused()).toBe(true);
  });

  it("preserves newer runtime decisions when a failed save rolls back configuration", async () => {
    const { plugin, save } = host();
    const event: ReconciliationDecision = { timestamp: Date.now(), path: "note.md", outcome: "unchanged", appliedRuleIds: [], involvedRuleIds: [], mutationKinds: [], iterations: 0 };
    save.mockImplementationOnce(async () => {
      await (plugin as unknown as { recordDecision(value: ReconciliationDecision): Promise<void> }).recordDecision(event);
      throw new Error("Settings write failed");
    });
    try {
      await expect(plugin.updateSettings({ debounceMs: 123 })).rejects.toThrow(/write failed/u);
      expect(plugin.settings.debounceMs).toBe(500);
      expect(plugin.settings.recentDecisions).toEqual([event]);
      expect(plugin.isAutomationPaused()).toBe(true);
    } finally { plugin.onunload(); }
  });

  it("serializes the captured configuration instead of coalescing concurrent edits into the latest state", async () => {
    const { plugin, save } = host();
    let release: (() => void) | undefined;
    save.mockImplementationOnce(async () => new Promise<void>((resolve) => { release = resolve; }));
    const first = plugin.updateSettings({ dryRun: false });
    const second = plugin.updateSettings({ debounceMs: 123 });
    await Promise.resolve();
    expect(save.mock.calls[0][0]).toMatchObject({ dryRun: false, debounceMs: 500 });
    release?.(); await Promise.all([first, second]);
    expect(save.mock.calls[1][0]).toMatchObject({ dryRun: false, debounceMs: 123 });
  });

  it("does not restore when review confirmation is canceled", async () => {
    const { app } = store();
    const history = new SettingsRevisionHistory(app); history.capture(DEFAULT_SETTINGS, "startup");
    const apply = vi.fn(async () => {});
    let closed: (() => void) | undefined;
    vi.spyOn(ConfirmationModal.prototype, "setCloseCallback").mockImplementation(function (this: ConfirmationModal, callback) { closed = callback; return this; });
    const modal = new SettingsHistoryModal({} as App, () => history.entries(), () => ({ summary: "Replace settings", apply }));
    const root = new TestElement(); modal.contentEl = root.asElement(); modal.onOpen();
    const click = root.all("button").find((button) => button.textContent === "Review restore")?.fire("click");
    closed?.(); await click;
    expect(apply).not.toHaveBeenCalled();
  });
});
