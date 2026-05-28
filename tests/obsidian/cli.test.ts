import { describe, expect, it } from "vitest";
import type { NoteState, ReconciliationConverged } from "../../src/engine";
import { cliError, formatCliDiagnostics, formatCliPlan, formatCliStatus, parseCliTrigger } from "../../src/obsidian/cli";
import type { DryRunPreviewPlan } from "../../src/obsidian/dry-run-preview";

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

const current: NoteState = {
  path: "Inbox/note.md",
  basename: "note",
  extension: "md",
  frontmatter: { status: "draft" },
  frontmatterKeys: ["status"],
  tags: [],
  stat: { ctime: 1, mtime: 2 },
};

const result: ReconciliationConverged = {
  status: "converged",
  desired: { ...current, path: "Archive/note.md", frontmatter: { status: "done" } },
  mutations: [
    { kind: "move", ruleIds: ["archive"] },
    { kind: "frontmatter", ruleIds: ["archive"] },
  ],
  appliedRuleIds: ["archive"],
  dryRunRuleIds: [],
  dryRunMatches: [],
  iterations: 1,
  changed: true,
};

const plan: DryRunPreviewPlan = {
  current,
  needsBodyContent: false,
  result,
  preview: {
    outcome: "changed",
    path: current.path,
    desiredPath: result.desired.path,
    appliedRuleIds: result.appliedRuleIds,
    involvedRuleIds: [],
    mutationKinds: ["move", "frontmatter"],
    iterations: 1,
    message: "Planned changes.",
  },
};

describe("Vault Flow CLI formatting", () => {
  it("returns bounded status without transaction snapshots", () => {
    const output = parse(formatCliStatus({
      dryRun: true,
      paused: false,
      pauseReason: null,
      settingsReadOnly: false,
      settingsRevision: 4,
      queue: { pendingCount: 2, runningCount: 1 },
      latestDecision: {
        timestamp: 1,
        path: "Inbox/note.md",
        outcome: "changed",
        appliedRuleIds: ["archive"],
        involvedRuleIds: [],
        mutationKinds: ["frontmatter"],
        iterations: 1,
        beforeFrontmatter: { secret: "before" },
        afterFrontmatter: { secret: "after" },
        afterIdentity: { ctime: 1, mtime: 2, size: 3, sha256: "private-content-hash" },
      },
    }));
    expect(output).toMatchObject({ status: "ok", dryRun: true, settingsRevision: 4, queue: { pendingCount: 2, runningCount: 1 } });
    expect(JSON.stringify(output)).not.toContain("secret");
    expect(JSON.stringify(output)).not.toContain("private-content-hash");
  });

  it("filters and bounds diagnostics", () => {
    const decisions = ["changed", "error", "changed"].map((outcome, index) => ({
      timestamp: index + 1,
      path: `${index}.md`,
      outcome: outcome as "changed" | "error",
      appliedRuleIds: [],
      involvedRuleIds: [],
      mutationKinds: [],
      iterations: 1,
    }));
    expect(parse(formatCliDiagnostics(decisions, { limit: "1", outcome: "changed" }))).toMatchObject({
      status: "ok", count: 1, totalMatching: 2, decisions: [{ path: "2.md" }],
    });
    expect(parse(formatCliDiagnostics(decisions, { limit: "0" }))).toMatchObject({ status: "error" });
    expect(parse(formatCliDiagnostics(decisions, { outcome: "unknown" }))).toMatchObject({ status: "error" });
  });

  it("summarizes plans without note bodies or property values", () => {
    const output = parse(formatCliPlan(plan, "manual"));
    expect(output).toMatchObject({
      status: "ok",
      trigger: "manual",
      path: "Inbox/note.md",
      desiredPath: "Archive/note.md",
      propertyChanges: ["status"],
    });
    expect(JSON.stringify(output)).not.toContain("draft");
    expect(JSON.stringify(output)).not.toContain("done");
  });

  it("validates trigger contexts and structured errors", () => {
    expect(parseCliTrigger(undefined)).toBe("manual");
    expect(parseCliTrigger("sweep")).toBe("sweep");
    expect(parseCliTrigger("always")).toBeNull();
    expect(parse(cliError("bad"))).toEqual({ status: "error", message: "bad" });
  });
});
