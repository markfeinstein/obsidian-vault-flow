import { describe, expect, it } from "vitest";
import { compileRuleRegex } from "../../src/engine/rule-regex";

describe("linear-time rule regexes", () => {
  it("shares compiled patterns across validation, matching, and capture extraction", () => {
    const regex = compileRuleRegex("^(Project)-(.*?)(-draft)?$");
    expect(compileRuleRegex("^(Project)-(.*?)(-draft)?$")).toBe(regex);
    expect(regex.test("project-Alpha")).toBe(true);
    expect(regex.captures("project-Alpha")).toEqual(["project", "Alpha", ""]);
    expect(regex.captures("project-Beta-draft")).toEqual(["project", "Beta", "-draft"]);
    expect(regex.captures("other")).toEqual([]);
  });

  it.each(["(?=foo)foo", "(?<=foo)bar", "(foo)\\1", "[invalid("])("rejects unsupported or invalid syntax: %s", (pattern) => {
    expect(() => compileRuleRegex(pattern)).toThrow("RE2-compatible syntax");
  });

  it("enforces length and compiled instruction limits", () => {
    expect(() => compileRuleRegex("a".repeat(513))).toThrow("512");
    expect(() => compileRuleRegex("a{1000}b{1000}c{1000}d{1000}e{1000}f{1000}g{1000}h{1000}i{1000}j{1000}k{1000}")).toThrow("too many matching instructions");
  });

  it("handles a classic catastrophic-backtracking input without native RegExp", () => {
    const regex = compileRuleRegex("^(a+)+$");
    expect(regex.test("a".repeat(100_000) + "!")).toBe(false);
    expect(regex.test("a".repeat(100_000))).toBe(true);
    expect(regex.captures("a".repeat(10_000) + "!")).toEqual([]);
  }, 2_000);

  it("translates JavaScript unicode escapes and keeps captures reusable", () => {
    const regex = compileRuleRegex("(\\u0041)(\\d+)");
    expect(regex.captures("a123")).toEqual(["a", "123"]);
    expect(regex.captures("A456")).toEqual(["A", "456"]);
  });

  it("evicts old patterns from the bounded cache", () => {
    const original = compileRuleRegex("cache-sentinel");
    for (let index = 0; index < 70; index += 1) compileRuleRegex(`cache-${index}`);
    expect(compileRuleRegex("cache-sentinel")).not.toBe(original);
  });
});
