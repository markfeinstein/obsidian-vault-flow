import { describe, expect, it, vi } from "vitest";
import type { App, SettingDefinitionItem, SettingDefinitionList } from "obsidian";
import type { Rule } from "../../src/engine";
import { VaultFlowSettingTab, type VaultFlowSettingsPlugin } from "../../src/obsidian/settings-tab";
import { DEFAULT_SETTINGS, type VaultFlowSettings } from "../../src/obsidian/settings";

function rule(id: string, priority: number): Rule {
  return {
    id,
    name: id,
    enabled: true,
    priority,
    order: priority,
    when: { type: "tag", tag: id },
    then: { moveTo: `${id}/` },
  };
}

function makeHarness(rules: readonly Rule[] = []) {
  let settings: VaultFlowSettings = { ...DEFAULT_SETTINGS, rules };
  const updateSettings = vi.fn(async (changes: Partial<VaultFlowSettings>) => {
    settings = { ...settings, ...changes };
  });
  const host = {
    getSettings: () => settings,
    updateSettings,
  } as unknown as VaultFlowSettingsPlugin;
  const app = { vault: { getAllFolders: () => [] } } as unknown as App;
  return { tab: new VaultFlowSettingTab(app, host), updateSettings, getSettings: () => settings };
}

function findList(items: readonly SettingDefinitionItem[], heading: string): SettingDefinitionList | null {
  for (const item of items) {
    if ("type" in item && item.type === "list" && item.heading === heading) return item as SettingDefinitionList;
    if ("type" in item && (item.type === "group" || item.type === "page")) {
      const nested = findList(item.items ?? [], heading);
      if (nested !== null) return nested;
    }
  }
  return null;
}

describe("VaultFlowSettingTab declarative settings", () => {
  it("keeps pause device-session-local while persisting configurable write limits", async () => {
    let paused = false;
    const updateSettings = vi.fn(async () => {});
    const host = { getSettings: () => DEFAULT_SETTINGS, updateSettings,
      isAutomationPaused: () => paused, setAutomationPaused: (value: boolean) => { paused = value; } } as unknown as VaultFlowSettingsPlugin;
    const tab = new VaultFlowSettingTab({} as App, host);
    expect(tab.getControlValue("automationPaused")).toBe(false);
    await tab.setControlValue("automationPaused", true);
    expect(tab.getControlValue("automationPaused")).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();
    await tab.setControlValue("maxWritesPerMinute", 10);
    await tab.setControlValue("maxBatchWrites", 20);
    expect(updateSettings).toHaveBeenNthCalledWith(1, { maxWritesPerMinute: 10 });
    expect(updateSettings).toHaveBeenNthCalledWith(2, { maxBatchWrites: 20 });
  });

  it("surfaces repetition warnings in searchable rule definitions", () => {
    const { tab } = makeHarness([{ ...rule("append", 0), then: { appendToProperty: { log: "entry" } } }]);
    const list = findList(tab.getSettingDefinitions(), "Rules");
    const item = list?.items?.[0];
    expect(item !== undefined && "desc" in item ? item.desc : "").toContain("Warning:");
  });

  it("organizes settings into native searchable pages", () => {
    const { tab } = makeHarness();
    const definitions = tab.getSettingDefinitions();
    expect(definitions.map((definition) => "name" in definition ? definition.name : "")).toEqual([
      "Automation",
      "Scope and safety",
      "Rules",
      "Advanced",
    ]);
  });

  it("returns searchable rule definitions in execution order", () => {
    const { tab } = makeHarness([rule("later", 10), rule("first", 0)]);
    const definitions = tab.getSettingDefinitions();
    const rules = findList(definitions, "Rules");

    expect(rules).not.toBeNull();
    if (rules === null) return;

    expect(rules.search).toBeDefined();
    expect(rules.items?.map((item) => "name" in item ? item.name : "")).toEqual(["first", "later"]);
    expect(rules.onReorder).toBeTypeOf("function");
    expect(rules.onDelete).toBeTypeOf("function");
  });

  it("keeps immutable IDs through duplicate names, renames, and reordering", async () => {
    const first = { ...rule("first-id", 0), name: "Same name" };
    const second = { ...rule("second-id", 1), name: "Same name" };
    const { tab, updateSettings } = makeHarness([first, second]);
    const original = findList(tab.getSettingDefinitions(), "Rules");
    expect(original?.items?.map((item) => "id" in item ? item.id : undefined)).toEqual(["first-id", "second-id"]);
    await updateSettings({ rules: [{ ...second, name: "Renamed", priority: 0 }, { ...first, priority: 1 }] });
    const updated = findList(tab.getSettingDefinitions(), "Rules");
    expect(updated?.items?.map((item) => "id" in item ? item.id : undefined)).toEqual(["second-id", "first-id"]);
    expect(updated?.items?.map((item) => "name" in item ? item.name : "")).toEqual(["Renamed", "Same name"]);
  });

  it("uses stable folder-row IDs independent of list position", async () => {
    const { tab, updateSettings } = makeHarness();
    await updateSettings({ monitoredFolders: ["Inbox", "Projects"] });
    const before = findList(tab.getSettingDefinitions(), "Monitored folders");
    await updateSettings({ monitoredFolders: ["Projects", "Inbox"] });
    const after = findList(tab.getSettingDefinitions(), "Monitored folders");
    expect(before?.items?.map((item) => "id" in item ? item.id : undefined)).toEqual(["monitored-folder:Inbox", "monitored-folder:Projects"]);
    expect(after?.items?.map((item) => "id" in item ? item.id : undefined)).toEqual(["monitored-folder:Projects", "monitored-folder:Inbox"]);
  });

  it("persists derived textarea controls without rebuilding the complete tab", async () => {
    const { tab, updateSettings, getSettings } = makeHarness();
    const refreshDomState = vi.spyOn(tab, "refreshDomState");
    const update = vi.spyOn(tab, "update");

    await tab.setControlValue("exclusionPatternsText", "Templates/**\nArchive/**");

    expect(updateSettings).toHaveBeenCalledWith({ exclusionPatterns: ["Templates/**", "Archive/**"] });
    expect(getSettings().exclusionPatterns).toEqual(["Templates/**", "Archive/**"]);
    expect(refreshDomState).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
});
