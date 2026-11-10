import { describe, expect, it, vi } from "vitest";
import { RE2JS } from "re2js";
import { TFile, type App } from "obsidian";
import type { Rule } from "../../src/engine";
import { planFileReconciliation } from "../../src/obsidian/planner";
import { planReconciliationForFile } from "../../src/obsidian/dry-run-preview";
import { DEFAULT_SETTINGS } from "../../src/obsidian/settings";
import { compactPreviewPlan } from "../../src/obsidian/preview-snapshot";
import { VaultPreviewModal, type VaultPreviewEntry } from "../../src/obsidian/vault-preview-modal";
import { mapWithConcurrency } from "../../src/obsidian/concurrency";

function file(path = "Archive/note.md"): TFile {
  const value = new TFile();
  Object.assign(value, { path, basename: "note", extension: "md", stat: { ctime: 1, mtime: 1, size: 0 } });
  return value;
}
const bodyRule: Rule = { id: "body", name: "Body", enabled: true, priority: 1, order: 1,
  when: { type: "all", predicates: [{ type: "pathGlob", glob: "Inbox/**" }, { type: "contentContains", text: "trigger" }] },
  then: { setProperties: { reviewed: true } } };
function app(body = "trigger"): App & { readBody: ReturnType<typeof vi.fn> } {
  const readBody = vi.fn(async () => body);
  return { readBody, metadataCache: { getFileCache: () => ({}) }, vault: { cachedRead: readBody, read: async () => body } } as unknown as App & { readBody: ReturnType<typeof vi.fn> };
}

describe("planning cost and semantics", () => {
  it("does not read any of 1000 bodies ruled out by metadata", async () => {
    const host = app();
    const settings = { ...DEFAULT_SETTINGS, rules: [bodyRule] };
    for (let i = 0; i < 1000; i++) await planFileReconciliation(host, file(), settings, "manual", 1);
    expect(host.readBody).not.toHaveBeenCalled();
  });
  it("still loads the body if an earlier rule changes a later predicate's path", async () => {
    const host = app();
    const move: Rule = { ...bodyRule, id: "move", priority: 0, order: 0, when: { type: "pathGlob", glob: "Archive/**" }, then: { moveTo: "Inbox/" } };
    const plan = await planFileReconciliation(host, file(), { ...DEFAULT_SETTINGS, rules: [move, bodyRule] }, "manual", 1);
    expect(host.readBody).toHaveBeenCalledOnce();
    expect(plan).toMatchObject({ status: "ready", result: { desired: { path: "Inbox/note.md", frontmatter: { reviewed: true } } } });
  });
  it("preserves known negation and trace semantics without reading an irrelevant body", async () => {
    const host = app(); const traces: unknown[] = [];
    const plan = await planFileReconciliation(host, file(), { ...DEFAULT_SETTINGS, rules: [{ ...bodyRule, when: { type: "not", predicate: bodyRule.when } }] }, "manual", 1, { onRuleEvaluated: (trace) => { traces.push(trace); } });
    expect(host.readBody).not.toHaveBeenCalled();
    expect(plan).toMatchObject({ needsBodyContent: false, result: { changed: true } });
    expect(traces).not.toHaveLength(0);
  });
  it("retains all 80 active patterns across notes, rather than thrashing a 64-entry LRU", async () => {
    const host = app();
    const settings = { ...DEFAULT_SETTINGS, rules: Array.from({ length: 80 }, (_, i): Rule => ({ ...bodyRule, id: String(i), when: { type: "contentRegex", pattern: "uniquePerfPattern" + i + "$" } })) };
    await planFileReconciliation(host, file(), settings, "manual", 1);
    const compile = vi.spyOn(RE2JS, "compile");
    try {
      for (let i = 0; i < 20; i++) await planFileReconciliation(host, file(), settings, "manual", 1);
      expect(compile).not.toHaveBeenCalled();
    } finally { compile.mockRestore(); }
  });
  it("does not retain rejected results while still reporting progress", async () => {
    const progress = vi.fn();
    expect(await mapWithConcurrency([1, 2, 3], 2, async (value) => value, { retainResult: (value) => value !== 2, onProgress: progress })).toEqual([1, 3]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });
});

describe("compact writable preview baselines", () => {
  it.each([false, true])("preserves stale-body checks after releasing preview text (changed=%s)", async (changed) => {
    const target = file("Inbox/note.md"); let body = "trigger"; const frontmatter = {};
    const write = vi.fn(async (_file: TFile, callback: (value: Record<string, unknown>) => void) => { callback(frontmatter); });
    const host = { metadataCache: { getFileCache: () => ({ frontmatter }) }, vault: { configDir: ".obsidian", cachedRead: async () => body, read: async () => body, getFileByPath: () => target },
      fileManager: { processFrontMatter: write } } as unknown as App;
    const plan = await compactPreviewPlan(await planReconciliationForFile(host, target, { ...DEFAULT_SETTINGS, rules: [bodyRule] }));
    expect(plan.current.bodyContent).toBeUndefined();
    expect(plan.result?.desired.bodyContent).toBeUndefined();
    expect(plan.current.bodyFingerprint).toHaveLength(64);
    if (changed) body = "new body with identical stat";
    const entry: VaultPreviewEntry = { path: target.path, propertyChangeCount: 1, preview: plan };
    const modal = new VaultPreviewModal(host, [entry]) as unknown as { applySelected(entries: readonly VaultPreviewEntry[]): Promise<void> };
    await modal.applySelected([entry]);
    expect(write).toHaveBeenCalledTimes(changed ? 0 : 1);
  });
});
