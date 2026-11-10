import { describe, expect, it, vi } from "vitest";
import { RE2Set } from "re2js";
import type { NoteState, Rule, RuleEvaluationTrace, RulePredicate } from "../../src/engine";
import { reconcileFileState } from "../../src/engine/reconcile";
import { compileRuleRegex } from "../../src/engine/rule-regex";
import { draftFromRule, updateRuleById } from "../../src/obsidian/rule-editor-model";
import { DEFAULT_SETTINGS, sanitizeRules, sanitizeVaultFlowSettings } from "../../src/obsidian/settings";
import { formatRuleExport, parseRuleImport } from "../../src/obsidian/rule-io";

const state: NoteState = { path: "Inbox/note.md", basename: "note", extension: "md", frontmatter: {}, tags: [], bodyContent: "prefixWORD\nother words", stat: { ctime: 1, mtime: 2 } };
function rule(id: string, when: RulePredicate, then: Rule["then"] = { setProperties: { [id]: true } }): Rule {
  return { id, name: id, enabled: true, priority: Number(id) || 0, order: Number(id) || 0, when, then };
}
function run(rules: readonly Rule[], useRegexSet: boolean, file = state, traces?: RuleEvaluationTrace[]) {
  return reconcileFileState({ file, rules, options: { maxIterations: 10, useRegexSet, ...(traces === undefined ? {} : { onRuleEvaluated: (trace) => { traces.push(trace); } }) } });
}

describe("opt-in captureless lookbehind", () => {
  it("keeps strict RE2 semantics by default and isolates flag-specific compiled caches", () => {
    const pattern = "(?<=prefix)(word)";
    expect(() => compileRuleRegex(pattern)).toThrow();
    expect(compileRuleRegex(pattern, true).test("prefixWORD")).toBe(true);
    expect(compileRuleRegex(pattern, true).captures("prefixWORD")).toEqual(["WORD"]);
    expect(() => compileRuleRegex(pattern)).toThrow();
    expect(compileRuleRegex("(?<!prefix)word", true).test("otherword")).toBe(true);
  });
  it.each(["(?<=(capture))word", "(?=word)word", "(word)\\1"])("still rejects unsupported or capturing lookarounds: %s", (pattern) => {
    expect(() => compileRuleRegex(pattern, true)).toThrow();
  });
  it("keeps identical predicate objects isolated between strict and lookbehind-enabled rules", () => {
    const when: RulePredicate = { type: "contentRegex", pattern: "(?<=prefix)word" };
    expect(run([rule("strict", when), { ...rule("enabled", when), regexLookbehind: true }], false)).toMatchObject({ desired: { frontmatter: { enabled: true } } });
  });
  it("preserves the explicit opt-in through editing, settings and import/export", () => {
    const configured = { ...rule("lookbehind", { type: "contentRegex", pattern: "(?<=prefix)word" }), regexLookbehind: true };
    expect(sanitizeRules([configured])).toEqual({ rules: [configured], sanitized: false });
    expect(sanitizeVaultFlowSettings({ rules: [configured] }).regexErrors).toBeUndefined();
    expect(sanitizeVaultFlowSettings({ rules: [{ ...configured, regexLookbehind: undefined }] }).regexErrors).toEqual(["lookbehind"]);
    const draft = draftFromRule(configured); if (draft === null) throw new Error("No draft");
    expect(updateRuleById([configured], configured.id, draft)).toMatchObject({ status: "ok", rules: [{ regexLookbehind: true }] });
    expect(parseRuleImport(formatRuleExport([configured], "test"))).toMatchObject({ status: "success", rules: [configured] });
  });
});

describe("opt-in body-only RE2Set", () => {
  it("is disabled by default and sanitizes its settings flag", () => {
    expect(DEFAULT_SETTINGS.useRegexSet).toBe(false);
    expect(sanitizeVaultFlowSettings({ useRegexSet: true }).settings.useRegexSet).toBe(true);
    expect(sanitizeVaultFlowSettings({ useRegexSet: "true" })).toMatchObject({ sanitized: true, settings: { useRegexSet: false } });
  });
  it.each(["prefixWORD\nother words", "nothing", "emoji 😀 word", "WoRd\n", ""])("has identical outcomes, captures, and traces for body %j", (bodyContent) => {
    const rules: Rule[] = [
      rule("1", { type: "pathGlob", glob: "Inbox/**" }, { moveTo: "Archive/" }),
      rule("2", { type: "all", predicates: [{ type: "pathGlob", glob: "Archive/**" }, { type: "contentRegex", pattern: "(word)" }] }, { renameTo: "{1}", setProperties: { matched: true } }),
      rule("3", { type: "not", predicate: { type: "contentRegex", pattern: "never" } }),
      { ...rule("4", { type: "contentRegex", pattern: "(?<=prefix)word" }), regexLookbehind: true },
      rule("5", { type: "any", predicates: [{ type: "frontmatterValue", property: "matched", value: true }, { type: "contentRegex", pattern: "😀" }] }),
    ];
    const ordinary: RuleEvaluationTrace[] = [], batched: RuleEvaluationTrace[] = [];
    expect(run(rules, true, { ...state, bodyContent }, batched)).toEqual(run(rules, false, { ...state, bodyContent }, ordinary));
    expect(batched).toEqual(ordinary);
  });
  it("falls back if set compilation fails", () => {
    const rules = [rule("1", { type: "contentRegex", pattern: "word" }), rule("2", { type: "contentRegex", pattern: "other" })];
    const expected = run(rules, false);
    const compile = vi.spyOn(RE2Set.prototype, "compile").mockImplementationOnce(() => { throw new Error("bounded set unavailable"); });
    try { expect(run(rules, true)).toEqual(expected); expect(compile).toHaveBeenCalledOnce(); }
    finally { compile.mockRestore(); }
  });
  it("falls back rather than building an oversized set", () => {
    const rules = Array.from({ length: 129 }, (_, i) => rule(String(i), { type: "contentRegex", pattern: "never" + i }));
    const compile = vi.spyOn(RE2Set.prototype, "compile");
    try { expect(run(rules, true)).toEqual(run(rules, false)); expect(compile).not.toHaveBeenCalled(); }
    finally { compile.mockRestore(); }
  });
  it.each(["{ 1 }", "{\t1\n}", "{0001}"])("preserves supported numeric capture whitespace and leading zeros: %j", (template) => {
    const rules = [rule("1", { type: "contentRegex", pattern: "(word)" }, { renameTo: template })];
    expect(run(rules, false)).toMatchObject({ desired: { path: "Inbox/WORD.md" } });
    expect(run(rules, true)).toMatchObject({ desired: { path: "Inbox/WORD.md" } });
  });
  it("upgrades a cached body result when a later rule sharing the predicate needs captures", () => {
    const when: RulePredicate = { type: "contentRegex", pattern: "(sharedCapture)" };
    const regex = compileRuleRegex(when.pattern), captures = vi.spyOn(regex, "captures");
    try {
      expect(run([rule("1", when), rule("2", when, { renameTo: "{1}" })], false, { ...state, bodyContent: "sharedCapture" })).toMatchObject({ desired: { path: "Inbox/sharedCapture.md" } });
      expect(captures).toHaveBeenCalledOnce();
    } finally { captures.mockRestore(); }
  });
  it("does not extract captures unless a template or trace requires them", () => {
    const pattern = "(captureSentinel)", regex = compileRuleRegex(pattern);
    const captures = vi.spyOn(regex, "captures");
    try {
      const rules = [rule("1", { type: "contentRegex", pattern })];
      run(rules, false, { ...state, bodyContent: "captureSentinel" });
      expect(captures).not.toHaveBeenCalled();
      run([{ ...rules[0], then: { renameTo: "{1}" } }], false, { ...state, bodyContent: "captureSentinel" });
      expect(captures).toHaveBeenCalled();
    } finally { captures.mockRestore(); }
  });
});
