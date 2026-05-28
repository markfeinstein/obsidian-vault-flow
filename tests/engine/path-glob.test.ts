import { describe, expect, it } from "vitest";
import { compilePathGlob, MAX_GLOB_PATTERN_LENGTH } from "../../src/engine/path-glob";
import { sanitizeVaultFlowSettings, sanitizeRules } from "../../src/obsidian/settings";
import { reconcileFileState, type Rule } from "../../src/engine";
import { evaluateFileEligibility, globMatchesPath } from "../../src/obsidian/eligibility";
import { TFile } from "obsidian";

const note = {
  path: "Inbox/example.md", basename: "example", extension: "md", frontmatter: {}, tags: [],
};

describe("cached path globs", () => {
  it("matches adversarial wildcard patterns without backtracking", () => {
    const matcher = compilePathGlob("*a".repeat(24) + "b");
    expect(matcher.test("a".repeat(80) + ".md")).toBe(false);
    expect(matcher.test("a".repeat(80) + "b")).toBe(true);
    expect(globMatchesPath("*a".repeat(24) + "b", "a".repeat(80) + ".md")).toBe(false);
  });

  it("rejects oversized patterns without discarding saved safety exclusions", () => {
    const oversized = "x".repeat(MAX_GLOB_PATTERN_LENGTH + 1);
    expect(() => compilePathGlob(oversized)).toThrow("at most");
    const rule: Rule = {
      id: "long", name: "Long", enabled: true, priority: 0, order: 0,
      when: { type: "pathGlob", glob: oversized }, then: { moveTo: "Archive" },
    };
    expect(sanitizeRules([rule]).rules).toHaveLength(0);
    expect(sanitizeVaultFlowSettings({ rules: [rule] }).regexErrors).toEqual(["long"]);
    expect(sanitizeVaultFlowSettings({ exclusionPatterns: [oversized] }).regexErrors)
      .toEqual(["exclusion pattern 1"]);
  });

  it.each([
    ["Inbox/*", "Inbox/example.md", true],
    ["Inbox/*", "Inbox/nested/example.md", false],
    ["Inbox/**", "Inbox/nested/example.md", true],
    ["**/example.md", "example.md", true],
    ["**/example.md", "Inbox/nested/example.md", true],
    ["Inbox/?.md", "Inbox/x.md", true],
    ["Inbox/?.md", "Inbox/xy.md", false],
    ["Inbox/(a+b)[1].md", "Inbox/(a+b)[1].md", true],
    ["inbox/*.MD", "Inbox/example.md", true],
  ])("preserves %s matching %s", (glob, path, expected) => {
    expect(compilePathGlob(glob).test(path)).toBe(expected);
  });

  it("reuses patterns, but not different flags or changed glob values", () => {
    const glob = compilePathGlob("Cache/**");
    expect(compilePathGlob("Cache/**")).toBe(glob);
    expect(compilePathGlob("Cache/**", "iu")).not.toBe(glob);
    expect(compilePathGlob("Changed/**")).not.toBe(glob);
  });

  it("bounds cache retention across settings revisions", () => {
    const original = compilePathGlob("OldRevision/**");
    for (let index = 0; index < 520; index += 1) compilePathGlob(`Revision${index}/**`);
    expect(compilePathGlob("OldRevision/**")).not.toBe(original);
  });

  it("retains folder-descendant exclusion and whitespace normalization", () => {
    expect(globMatchesPath(" Archive ", "Archive/nested/note.md")).toBe(true);
    expect(globMatchesPath(" Archive ", "Archives/note.md")).toBe(false);
    expect(globMatchesPath("", "note.md")).toBe(false);
  });

  it("does not reuse stale exclusion settings", () => {
    const file = Object.assign(new TFile(), note);
    const cache = { frontmatter: {} };
    const settings = { monitoredFolders: [], exclusionPatterns: ["Inbox/**"], disableFrontmatterKey: "disabled" };
    expect(evaluateFileEligibility(file, cache, settings).eligible).toBe(false);
    expect(evaluateFileEligibility(file, cache, { ...settings, exclusionPatterns: ["Archive/**"] }).eligible).toBe(true);
  });

  it("preserves extensionless rule matching when rules change", () => {
    const rule: Rule = {
      id: "glob", name: "Glob", enabled: true, priority: 0, order: 0,
      when: { type: "pathGlob", glob: "Inbox/example" }, then: { setProperties: { matched: true } },
    };
    const first = reconcileFileState({ file: note, rules: [rule], options: { maxIterations: 10 } });
    const changed = reconcileFileState({ file: note, rules: [{ ...rule, when: { type: "pathGlob", glob: "Archive/**" } }], options: { maxIterations: 10 } });
    expect(first.status === "converged" && first.changed).toBe(true);
    expect(changed.status === "converged" && changed.changed).toBe(false);
  });
});
