import { describe, expect, it } from "vitest";
import { cloneDecision } from "../../src/obsidian/diagnostics";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";

describe("cloneDecision", () => {
  it("clones frontmatter snapshots", () => {
    const source: ReconciliationDecision = {
      timestamp: 1,
      path: "note.md",
      outcome: "changed",
      appliedRuleIds: ["rule-1"],
      involvedRuleIds: [],
      mutationKinds: ["frontmatter"],
      iterations: 1,
      beforeFrontmatter: { title: "Before" },
      afterFrontmatter: { title: "After" },
    };

    const decision = cloneDecision(source);
    (source.beforeFrontmatter as Record<string, unknown>).title = "Mutated";

    expect(decision.beforeFrontmatter).toEqual({ title: "Before" });
    expect(decision.afterFrontmatter).toEqual({ title: "After" });
  });
});
