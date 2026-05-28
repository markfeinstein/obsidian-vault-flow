import { describe, expect, it } from "vitest";
import { reconcileFileState, type Rule } from "../../src/engine";
import { sanitizeRules, sanitizeVaultFlowSettings, SETTINGS_SCHEMA_VERSION } from "../../src/obsidian/settings";
import { formatRuleExport, parseRuleImport } from "../../src/obsidian/rule-io";
import { createRuleFromDraft, draftFromRule } from "../../src/obsidian/rule-editor-model";

const rule: Rule = { id: "move", name: "Move", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "**" }, then: { moveTo: "Projects/Client.v2", moveToKind: "folder" }, stopOnMatch: true };
const note = { path: "Inbox/A.md", basename: "A", extension: "md", frontmatter: {}, tags: [] };

describe("explicit destination intent", () => {
  it("supports dotted folders without changing legacy inference", () => {
    const result = reconcileFileState({ file: note, rules: [rule], options: { maxIterations: 3 } });
    expect(result.status === "converged" && result.desired.path).toBe("Projects/Client.v2/A.md");
    const legacy = reconcileFileState({ file: note, rules: [{ ...rule, then: { moveTo: "Projects/Client.v2" } }], options: { maxIterations: 3 } });
    expect(legacy.status === "converged" && legacy.desired.path).toBe("Projects/Client.v2");
  });

  it("round-trips intent through validation, visual editing, and versioned exports", () => {
    expect(sanitizeRules([rule]).rules[0]?.then.moveToKind).toBe("folder");
    const draft = draftFromRule(rule)!;
    expect(draft.moveToKind).toBe("folder");
    const updated = createRuleFromDraft([], draft);
    expect(updated.status === "ok" && updated.rules[0]?.then.moveToKind).toBe("folder");
    const imported = parseRuleImport(formatRuleExport([rule], "0.1.0"));
    expect(imported.status === "success" && imported.rules[0]?.then.moveToKind).toBe("folder");
    expect(sanitizeRules([{ ...rule, then: { ...rule.then, moveToKind: ["folder"] } }]).rules).toEqual([]);
  });

  it("migrates older settings with schema three safety limits while retaining schema two rule exports", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
    const migrated = sanitizeVaultFlowSettings({ settingsVersion: 1, rules: [{ ...rule, then: { moveTo: "Archive" } }] });
    expect(migrated.incompatibleVersion).toBeUndefined();
    expect(migrated.sanitized).toBe(true);
    expect(migrated.settings.rules).toHaveLength(1);
    expect(JSON.parse(formatRuleExport([rule], "0.1.0"))).toMatchObject({ schemaVersion: 2 });
  });
});
