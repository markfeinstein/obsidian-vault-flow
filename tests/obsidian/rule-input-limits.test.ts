import { describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import { reconcileFileState, type Rule } from "../../src/engine";
import { MAX_RULE_COUNT, MAX_RULE_INPUT_DEPTH, MAX_RULE_INPUT_NODES, MAX_RULESET_INPUT_NODES, ruleInputLimitError } from "../../src/engine/rule-limits";
import { parseRuleImport } from "../../src/obsidian/rule-io";
import { sanitizeRules, sanitizeVaultFlowSettings } from "../../src/obsidian/settings";

const rule: Rule = { id: "r", name: "Rule", enabled: true, priority: 0, order: 0, when: { type: "tag", tag: "x" }, then: { addTags: ["done"] } };
function nestedJson(depth: number): string {
  return '[{"id":"deep","name":"Deep","enabled":true,"priority":0,"order":0,"when":'
    + '{"type":"not","predicate":'.repeat(depth) + '{"type":"tag","tag":"x"}' + "}".repeat(depth) + ',"then":{"addTags":["done"]}}]';
}

describe("rule input complexity limits", () => {
  it("turns a valid 216 KB deeply nested import into an actionable error, not a stack overflow", () => {
    const text = nestedJson(8_000);
    expect(text.length).toBeLessThan(1_000_000);
    expect(parseRuleImport(text)).toEqual({ status: "error", error: `Rule 1 exceeds the maximum nesting depth of ${MAX_RULE_INPUT_DEPTH}.` });
    const rules: unknown = JSON.parse(text);
    expect(sanitizeRules(rules)).toEqual({ rules: [], sanitized: true });
    expect(sanitizeVaultFlowSettings({ rules }).ruleErrors).toEqual([`Rule 1 exceeds the maximum nesting depth of ${MAX_RULE_INPUT_DEPTH}.`]);
  });

  it("checks unknown fields before import reports recursively format them", () => {
    let extra: unknown = "leaf";
    for (let i = 0; i < MAX_RULE_INPUT_DEPTH + 1; i += 1) extra = { child: extra };
    expect(parseRuleImport(JSON.stringify([{ ...rule, extra }])).status).toBe("error");
  });

  it("bounds breadth, total work and rule count independently", () => {
    expect(ruleInputLimitError(Array.from({ length: MAX_RULE_COUNT + 1 }, () => rule))).toContain("at most");
    expect(ruleInputLimitError([{ ...rule, extra: Array.from({ length: MAX_RULE_INPUT_NODES }, () => 1) }])).toContain("input nodes");
    const many = Array.from({ length: Math.ceil(MAX_RULESET_INPUT_NODES / 4_000) }, (_, index) => ({ ...rule, id: String(index), extra: Array.from({ length: 4_000 }, () => 1) }));
    expect(ruleInputLimitError(many)).toContain("ruleset exceeds");
  });

  it("bounds pending frontier allocation and stops enumerating oversized objects", () => {
    let arrayReads = 0;
    const child = new Proxy(Array.from({ length: 4_250 }, () => null), { get(target, key) {
      if (typeof key === "string" && /^\d+$/u.test(key)) arrayReads += 1;
      return Reflect.get(target, key) as unknown;
    } });
    const extra = { child, ...Object.fromEntries(Array.from({ length: 4_250 }, (_, i) => [`sibling${i}`, null])) };
    expect(ruleInputLimitError([{ ...rule, extra }])).toContain("input nodes");
    expect(arrayReads).toBe(0);
    let objectReads = 0;
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) Object.defineProperty(wide, `key${i}`, { enumerable: true, get() { objectReads += 1; return null; } });
    expect(ruleInputLimitError([{ ...rule, extra: wide }])).toContain("input nodes");
    expect(objectReads).toBeLessThanOrEqual(MAX_RULE_INPUT_NODES);
  });

  it("accepts ordinary nested predicates and shared subtrees but rejects ancestor cycles", () => {
    const shared = { type: "tag" as const, tag: "x" };
    expect(sanitizeRules([{ ...rule, when: { type: "all", predicates: [shared, { type: "not", predicate: shared }] } }]).rules).toHaveLength(1);
    expect(parseRuleImport(nestedJson(MAX_RULE_INPUT_DEPTH - 3)).status).toBe("success");
    const cycle: Record<string, unknown> = { type: "not" }; cycle.predicate = cycle;
    expect(ruleInputLimitError([{ ...rule, when: cycle }])).toContain("circular");
    expect(sanitizeRules([{ ...rule, when: cycle }]).rules).toEqual([]);
  });

  it("guards direct engine callers before recursive predicate evaluation", () => {
    const rules = JSON.parse(nestedJson(8_000)) as Rule[];
    expect(() => reconcileFileState({ file: { path: "note.md", basename: "note", extension: "md", tags: [], frontmatter: {} }, rules, options: { maxIterations: 10 } })).toThrow("maximum nesting depth");
  });

  it("preserves oversized settings on load and external reload instead of saving a weakened ruleset", async () => {
    const rules: unknown = JSON.parse(nestedJson(8_000));
    const raw = { rules, dryRun: false };
    const app = { loadLocalStorage: () => null, saveLocalStorage: vi.fn(), metadataCache: { on: vi.fn() }, vault: { on: vi.fn() }, workspace: { on: vi.fn(), onLayoutReady: vi.fn() } } as unknown as App;
    const plugin = new VaultFlowPlugin(app, {} as PluginManifest);
    vi.spyOn(plugin, "loadData").mockResolvedValue(raw);
    const save = vi.spyOn(plugin, "saveData");
    await plugin.onload();
    try {
      expect((plugin as unknown as { settingsReadOnly: boolean }).settingsReadOnly).toBe(true);
      await plugin.onExternalSettingsChange();
      await plugin.updateSettings({ dryRun: false });
      expect(save).not.toHaveBeenCalled();
      expect(raw.rules).toBe(rules);
    } finally { plugin.onunload(); }
  });
});
