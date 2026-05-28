import { describe, expect, it, vi } from "vitest";
import { TFile, type App } from "obsidian";
import { reconcileFileState, type RuleEvaluationTrace, type Rule, type NoteState } from "../../src/engine";
import { RuleDebuggerModal } from "../../src/obsidian/rule-debugger-modal";
import { ruleConvergenceWarnings } from "../../src/obsidian/rule-warnings";
import { DEFAULT_SETTINGS } from "../../src/obsidian/settings";
import { parseRuleImport } from "../../src/obsidian/rule-io";
import { TestElement } from "../helpers/dom";

const note: NoteState = { path: "Note-title.md", basename: "Note-title", extension: "md", tags: [], frontmatter: {}, bodyContent: "body" };
const base: Rule = { id: "r", name: "Rule", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "**" }, then: { setProperties: { status: "done" } } };

describe("current-rule debugging", () => {
  it("uses identical reconciliation semantics with tracing and identifies short-circuited capture sources", () => {
    const traces: RuleEvaluationTrace[] = [];
    const rule: Rule = { ...base, stopOnMatch: true, when: { type: "any", predicates: [
      { type: "all", predicates: [{ type: "contentContains", text: "absent" }, { type: "basename", pattern: "^(.*)$" }] },
      { type: "basename", pattern: "^Note-(.*)$" }, { type: "contentContains", text: "body" },
    ] }, then: { renameTo: "{1}" } };
    const input = { file: note, rules: [rule], options: { maxIterations: 10, now: 1 } };
    expect(reconcileFileState({ ...input, options: { ...input.options, onRuleEvaluated: (trace) => { traces.push(trace); } } })).toEqual(reconcileFileState(input));
    expect(traces[0]?.predicate.captures).toEqual(["title"]);
    expect(traces[0]?.predicate.children).toHaveLength(2);
    expect(traces[0]?.predicate.children?.[0]?.children).toHaveLength(1);
    expect(traces[0]?.before.path).toBe("Note-title.md");
    expect(traces[0]?.after.path).toBe("title.md");
  });

  it("explains missing template values and retains hypothetical dry-run transitions", () => {
    const traces: RuleEvaluationTrace[] = [];
    reconcileFileState({ file: note, rules: [
      { ...base, id: "missing", then: { renameTo: "{missing}" } },
      { ...base, id: "dry", dryRun: true, then: { renameTo: "preview" } },
    ], options: { maxIterations: 10, onRuleEvaluated: (trace) => { traces.push(trace); } } });
    expect(traces[0]?.messages.join(" ")).toContain("{missing} is missing");
    expect(traces[1]).toMatchObject({ outcome: "dry-run", before: { basename: "Note-title" }, after: { basename: "preview" } });
    expect(note.basename).toBe("Note-title");
  });

  it("renders fresh current-note evaluation with lazy predicate details, not a previous decision", async () => {
    const file = Object.assign(new TFile(), { path: note.path, basename: note.basename, extension: "md", stat: { ctime: 1, mtime: 2, size: 0 } });
    const write = vi.fn();
    const app = { metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
      fileManager: { processFrontMatter: write, renameFile: write }, vault: { cachedRead: async () => "body" } } as unknown as App;
    const modal = new RuleDebuggerModal(app, file, { ...DEFAULT_SETTINGS, rules: [
      base, { ...base, id: "live", runOn: "live" }, { ...base, id: "off", enabled: false },
    ] });
    const root = new TestElement(); Object.assign(modal, { contentEl: root.asElement() });
    await (modal as unknown as { refresh(context: string): Promise<void> }).refresh("manual");
    expect(root.all("p").some((el) => el.textContent.includes("Changes planned"))).toBe(true);
    expect(root.all("p").some((el) => el.textContent.includes("different trigger"))).toBe(true);
    expect(root.all("p").some((el) => el.textContent.includes("disabled"))).toBe(true);
    expect(root.all("li")).toHaveLength(0);
    const detail = root.all("details")[0];
    if (detail === undefined) throw new Error("Missing trace details");
    detail.open = true; await detail.fire("toggle");
    expect(root.all("li").length).toBeGreaterThan(0);
    expect(write).not.toHaveBeenCalled();
    modal.onClose();
  });

  it("discards a late debugger result after the modal closes", async () => {
    const file = Object.assign(new TFile(), { path: note.path, basename: note.basename, extension: "md" });
    let release!: (body: string) => void;
    const app = { metadataCache: { getFileCache: () => ({}) }, vault: { cachedRead: () => new Promise<string>((resolve) => { release = resolve; }) } } as unknown as App;
    const modal = new RuleDebuggerModal(app, file, { ...DEFAULT_SETTINGS, rules: [{ ...base, when: { type: "contentContains", text: "body" } }] });
    const root = new TestElement(); Object.assign(modal, { contentEl: root.asElement() });
    const refreshing = (modal as unknown as { refresh(context: string): Promise<void> }).refresh("manual");
    modal.onClose(); release("body"); await refreshing;
    expect(root.children).toHaveLength(0);
  });
});

describe("rule repetition warnings", () => {
  it("warns about unconditional appends, including later live runs despite stopOnMatch", () => {
    const append = { ...base, then: { appendToProperty: { log: "entry" } } };
    expect(ruleConvergenceWarnings(append)).toHaveLength(2);
    expect(ruleConvergenceWarnings({ ...append, stopOnMatch: true })).toHaveLength(1);
    expect(ruleConvergenceWarnings({ ...append, stopOnMatch: true, runOn: "manual" })).toEqual([]);
    const imported = parseRuleImport(JSON.stringify([append]));
    if (imported.status !== "success") throw new Error(imported.error);
    expect(imported.details.issues.some((issue) => issue.kind === "repetition-warning")).toBe(true);
    expect(imported.rules[0]?.then).toEqual(append.then);
  });

  it("warns about recursive path/name templates without flagging escaped literals or no-ops", () => {
    expect(ruleConvergenceWarnings({ ...base, then: { renameTo: "prefix-{basename}" } })).toHaveLength(1);
    expect(ruleConvergenceWarnings({ ...base, then: { moveTo: "{folder}/Archive" } })).toHaveLength(1);
    expect(ruleConvergenceWarnings({ ...base, then: { renameTo: "{{basename}}" } })).toEqual([]);
    expect(ruleConvergenceWarnings({ ...base, then: { renameTo: "{basename}" } })).toEqual([]);
  });
});
