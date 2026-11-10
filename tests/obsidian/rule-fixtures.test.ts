import { describe, expect, it } from "vitest";
import type { Rule } from "../../src/engine";
import { readRuleFixtures, runRuleFixtures, type RuleFixture } from "../../src/engine/rule-fixtures";
import { DEFAULT_SETTINGS, sanitizeRules, sanitizeVaultFlowSettings, SETTINGS_SCHEMA_VERSION } from "../../src/obsidian/settings";
import { draftFromRule, updateRuleById } from "../../src/obsidian/rule-editor-model";
import { formatRuleExport, parseRuleImport } from "../../src/obsidian/rule-io";
import { semanticRuleChanges } from "../../src/obsidian/rule-semantic-diff";

const fixture: RuleFixture = { name: "File is moved and cleaned", note: { path: "Inbox/note.md", frontmatter: { legacy: "old" } },
  expected: { path: "Archive/note.md", frontmatter: { reviewed: true }, absentProperties: ["legacy"], changed: true, status: "converged" } };
const rule: Rule = { id: "test", name: "Test", enabled: false, priority: 1, order: 1, when: { type: "pathGlob", glob: "**" },
  then: { moveTo: "Archive/", setProperties: { reviewed: true }, deleteProperties: ["legacy"] }, fixtures: [fixture] };

describe("synthetic rule fixtures", () => {
  it("runs deterministic pure-engine assertions even for a disabled rule", () => {
    expect(runRuleFixtures(rule)).toEqual([{ name: fixture.name, passed: true, failures: [] }]);
  });
  it("reports mismatched paths and properties", () => {
    const results = runRuleFixtures({ ...rule, then: { setProperties: { reviewed: false } } });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.failures).toHaveLength(3);
  });
  it("uses the fixture clock and trigger context", () => {
    expect(runRuleFixtures({ ...rule, runOn: "sweep", when: { type: "fileAge", field: "mtime", olderThanDays: 1 },
      fixtures: [{ ...fixture, now: 3 * 86400000, triggerContext: "sweep" }] })[0]?.passed).toBe(true);
  });
  it("combines frontmatter and inline tags in fixture inputs", () => {
    expect(runRuleFixtures({ ...rule, when: { type: "tag", tag: "fixture" }, fixtures: [{ ...fixture, note: { ...fixture.note, frontmatter: { tags: ["fixture"], legacy: "old" } } }] })[0]?.passed).toBe(true);
  });
  it("supports body input and does not discard an explicit string assertion", () => {
    const input: RuleFixture = { name: "Body", note: { path: "note.md", body: "trigger" }, expected: { frontmatter: { value: "true" } } };
    expect(runRuleFixtures({ ...rule, when: { type: "contentContains", text: "trigger" }, then: { setProperties: { value: "true" } }, fixtures: [input] })[0]?.passed).toBe(true);
  });
  it.each([
    [{ ...fixture, unknown: true }], [{ ...fixture, note: { path: "../note.md" } }],
    [{ ...fixture, expected: {} }], [{ ...fixture, expected: { changed: "yes" } }],
    [{ ...fixture, expected: { status: "invalid" } }], [{ ...fixture, expected: { unknown: true } }],
    Array.from({ length: 21 }, () => fixture), [{ ...fixture, note: { path: "note.md", body: "x".repeat(200001) } }],
  ].map((invalid) => ({ invalid })))("rejects malformed or oversized fixtures", ({ invalid }) => {
    expect(readRuleFixtures(invalid)).toBeNull();
  });
  it("preserves fixtures through settings, visual edits, imports and exports", () => {
    expect(sanitizeRules([rule])).toEqual({ rules: [rule], sanitized: false });
    const draft = draftFromRule(rule);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const updated = updateRuleById([rule], rule.id, { ...draft, name: "New name" });
    expect(updated).toMatchObject({ status: "ok", rules: [{ fixtures: [fixture] }] });
    const imported = parseRuleImport(formatRuleExport([rule], "test"));
    expect(imported).toMatchObject({ status: "success", rules: [rule] });
    const defaults = { ...DEFAULT_SETTINGS, rules: [rule] };
    const cloned = sanitizeVaultFlowSettings(undefined, defaults).settings.rules[0]?.fixtures;
    expect(cloned).toEqual([fixture]);
    expect(cloned).not.toBe(rule.fixtures);
  });
  it("migrates old settings without changing existing rules", () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(4);
    expect(sanitizeVaultFlowSettings({ settingsVersion: 3, rules: [rule] })).toMatchObject({ sanitized: true, settings: { rules: [rule] } });
  });
});

describe("semantic save previews", () => {
  it("shows condition/action/execution/fixture changes but ignores naming and object-key ordering", () => {
    expect(semanticRuleChanges(rule, { ...rule, name: "Renamed" })).toEqual([]);
    const changes = semanticRuleChanges(rule, { ...rule, priority: 3, then: { moveTo: "Other/" }, fixtures: [] });
    expect(changes.map((change) => change.section)).toEqual(["actions", "execution", "fixtures"]);
  });
  it("describes a newly created rule", () => {
    expect(semanticRuleChanges(null, rule).map((change) => change.section)).toEqual(["conditions", "actions", "execution", "fixtures"]);
  });
});
