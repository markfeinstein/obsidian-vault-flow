import { describe, expect, it } from "vitest";
import { reconcileFileState, type Rule, type NoteState, type RulePredicate } from "../../src/engine";

const note: NoteState = { path: "Note-title.md", basename: "Note-title", extension: "md", frontmatter: {}, tags: [], bodyContent: "Body-title" };
function rename(when: RulePredicate) {
  const rule: Rule = { id: "r", name: "r", enabled: true, priority: 0, order: 0, stopOnMatch: true, when, then: { renameTo: "{1}" } };
  return reconcileFileState({ file: note, rules: [rule], options: { maxIterations: 10 } });
}

describe("capture provenance", () => {
  it.each(["basename", "contentRegex"] as const)("ignores %s captures in a failed all branch", (type) => {
    expect(rename({ type: "any", predicates: [
      { type: "all", predicates: [{ type: "contentContains", text: "absent" }, { type, pattern: "^(.*)$" }] },
      { type, pattern: type === "basename" ? "^Note-(.*)$" : "^Body-(.*)$" },
    ] })).toMatchObject({ status: "converged", desired: { basename: "title" } });
  });

  it("does not export captures from a failing negation", () => {
    expect(rename({ type: "any", predicates: [
      { type: "not", predicate: { type: "basename", pattern: "^(.*)$" } },
      { type: "basename", pattern: "^Note-(.*)$" },
    ] })).toMatchObject({ desired: { basename: "title" } });
  });

  it("does not borrow captures from an unchosen later any branch", () => {
    expect(rename({ type: "any", predicates: [
      { type: "pathGlob", glob: "**" }, { type: "basename", pattern: "^Note-(.*)$" },
    ] })).toMatchObject({ desired: { basename: "Note-title" }, changed: false });
  });

  it("uses captures from successful children of all", () => {
    expect(rename({ type: "all", predicates: [
      { type: "contentContains", text: "Body" }, { type: "basename", pattern: "^Note-(.*)$" },
    ] })).toMatchObject({ desired: { basename: "title" } });
  });
});
