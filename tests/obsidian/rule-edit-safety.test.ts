import { describe, expect, it } from "vitest";
import type { Rule, RulePredicate } from "../../src/engine";
import { createRuleFromDraft, draftFromRule, updateRuleById } from "../../src/obsidian/rule-editor-model";
import { mergeRuleEdit } from "../../src/obsidian/rule-edits";

function rule(id = "one", when: RulePredicate = { type: "pathGlob", glob: "**" }): Rule {
  return { id, name: id, enabled: true, priority: 0, order: 0, when, then: { deleteProperties: ["due date", "old,status", "quoted\"key", "行\n名"] } };
}
function edit(original: Rule): Rule {
  const draft = draftFromRule(original);
  expect(draft).not.toBeNull();
  const result = updateRuleById([original], original.id, { ...draft!, name: "Rename only" });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error(result.error);
  return result.rules[0];
}

describe("lossless rule edits", () => {
  it.each(["true", "false", "null", "001", "123", "1e2", "", " spaced ", "\"quoted\"", true, false, null, 0, 1.5])("preserves scalar value and type: %s", (value) => {
    const original = rule("one", { type: "frontmatterValue", property: "code", value });
    const saved = edit(original);
    expect(saved.when).toEqual(original.when);
    expect(saved.then).toEqual(original.then);
  });
  it("preserves scalar types inside nested and negated conditions", () => {
    const original = rule("one", { type: "all", predicates: [{ type: "not", predicate: { type: "frontmatterValue", property: "code", value: "001" } }, { type: "tag", tag: "test" }] });
    expect(edit(original).when).toEqual(original.when);
  });
  it.each(["bad", "-5", "60days", "Infinity"])("rejects an invalid nonempty numeric bound: %s", (value) => {
    for (const when of [
      { type: "fileAge", field: "mtime", olderThanDays: 30, newerThanDays: 60 },
      { type: "frontmatterDateAge", property: "date", olderThanDays: 30, newerThanDays: 60 },
      { type: "wordCount", moreThan: 30, lessThan: 60 },
    ] as const) {
      const original = rule("one", when);
      const draft = draftFromRule(original)!;
      const node = draft.conditionNodes![0];
      if (node.kind !== "criterion") throw new Error("Expected criterion");
      const criterion = { ...node.criterion, ...(when.type === "wordCount" ? { wordCountLessThan: value } : { fileAgeNewerThanDays: value }) };
      expect(updateRuleById([original], "one", { ...draft, conditionNodes: [{ kind: "criterion", criterion }] }).status).toBe("error");
    }
  });
  it("appends without changing imported execution priorities or stored order", () => {
    const a = { ...rule("a"), priority: 20 };
    const b = { ...rule("b"), priority: 10 };
    const result = createRuleFromDraft([a, b], draftFromRule(rule("new"))!);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rules.slice(0, 2)).toEqual([a, b]);
    expect([...result.rules].sort((x, y) => x.priority - y.priority).map((r) => r.id)).toEqual(["b", "a", "new"]);
  });
});

describe("optimistic rule-level settings merge", () => {
  it("preserves unrelated synced additions, edits, and deletions", () => {
    const a = rule("a"); const b = rule("b"); const c = rule("c");
    const proposed = [{ ...a, name: "Edited" }, b];
    const current = [a, c];
    expect(mergeRuleEdit(current, [a, b], proposed)).toEqual({ status: "ok", rules: [proposed[0], c] });
  });
  it.each(["changed", "deleted", "id collision"])("rejects a concurrent conflict: %s", (kind) => {
    const a = rule("a");
    const baseline = kind === "id collision" ? [] : [a];
    const current = kind === "deleted" ? [] : [{ ...a, name: "Synced" }];
    expect(mergeRuleEdit(current, baseline, [{ ...a, name: "Editor" }]).status).toBe("error");
    expect(current[0]?.name).not.toBe("Editor");
  });
});
