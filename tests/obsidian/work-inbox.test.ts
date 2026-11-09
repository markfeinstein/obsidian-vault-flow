import { describe, expect, it, vi } from "vitest";
import { TFile, type App, type PluginManifest } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import type { RuleRunOn } from "../../src/engine";
import { buildWorkInbox, MAX_WORK_INBOX_ITEMS, type WorkInboxItem } from "../../src/obsidian/work-inbox";
import { WorkInboxModal } from "../../src/obsidian/work-inbox-modal";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";
import { cloneDecision } from "../../src/obsidian/diagnostics";
import type { JournalEntry } from "../../src/obsidian/transaction-journal";
import { sanitizeVaultFlowRuntimeState } from "../../src/obsidian/settings";
import { planReconciliationForFile } from "../../src/obsidian/dry-run-preview";
import { TestElement } from "../helpers/dom";

const decision = (overrides: Partial<ReconciliationDecision> = {}): ReconciliationDecision => ({ timestamp: 1, path: "Inbox/note.md", outcome: "error", issueKind: "read", triggerContexts: ["sweep"], appliedRuleIds: [], involvedRuleIds: [], mutationKinds: [], iterations: 0, message: "Unavailable", ...overrides });
const pending: JournalEntry = { transactionId: "pending", timestamp: 2, beforePath: "Inbox/note.md", afterPath: "Done/note.md", status: "started", mutationKinds: ["move"], ruleIds: ["r"], iterations: 1 };

describe("failed-work inbox", () => {
  it("resolves errors only with a later evaluation of the same trigger context", () => {
    const failed = decision();
    expect(buildWorkInbox([failed, decision({ timestamp: 2, outcome: "unchanged", issueKind: undefined, triggerContexts: ["live"] })], [])).toHaveLength(1);
    expect(buildWorkInbox([failed, decision({ timestamp: 3, outcome: "unchanged", issueKind: undefined })], [])).toEqual([]);
    expect(buildWorkInbox([failed, decision({ timestamp: 4, outcome: "changed", issueKind: undefined, desiredPath: "Done/note.md" })], [])).toEqual([]);
  });

  it("prioritizes pending journal entries and metadata waiting without leaking property snapshots", () => {
    const items = buildWorkInbox([decision()], [{ ...pending, beforeFrontmatter: { secret: "do not show" } }], ["Inbox/note.md", "Waiting/note.md"]);
    expect(items.map((item) => [item.path, item.kind, item.recovery])).toEqual([["Done/note.md", "mutation", true], ["Waiting/note.md", "metadata", false]]);
    expect(JSON.stringify(items)).not.toContain("do not show");
  });

  it("bounds the inbox and handles legacy errors conservatively", () => {
    const items = buildWorkInbox(Array.from({ length: 2_000 }, (_, i) => decision({ path: `${i}.md`, timestamp: i })), []);
    expect(items).toHaveLength(MAX_WORK_INBOX_ITEMS);
    expect(buildWorkInbox([decision({ issueKind: undefined, triggerContexts: undefined })], [])[0]?.triggerContexts).toEqual(["manual"]);
  });

  it("preserves and validates issue kinds and contexts in runtime history", () => {
    const item = decision();
    expect(cloneDecision(item)).toMatchObject({ issueKind: "read", triggerContexts: ["sweep"] });
    const runtime = sanitizeVaultFlowRuntimeState({ recentDecisions: [item], trackedMtimes: {}, ruleStats: {} });
    expect(runtime.runtimeState.recentDecisions[0]).toMatchObject({ issueKind: "read", triggerContexts: ["sweep"] });
    expect(sanitizeVaultFlowRuntimeState({ recentDecisions: [{ ...item, triggerContexts: ["invalid"] }], trackedMtimes: {}, ruleStats: {} }).runtimeState.recentDecisions).toEqual([]);
  });

  it("paginates and routes recovery separately from explicit reviewed replanning", async () => {
    const items = buildWorkInbox([decision()], [pending], Array.from({ length: 60 }, (_, i) => `Waiting/${i}.md`));
    const callbacks = { replan: vi.fn(async () => {}), openNote: vi.fn(async () => {}), openRecovery: vi.fn() };
    const modal = new WorkInboxModal({} as App, () => items, callbacks);
    const root = new TestElement(); modal.contentEl = root.asElement(); modal.onOpen();
    expect(root.all("h4")).toHaveLength(50);
    expect(callbacks.replan).not.toHaveBeenCalled();
    await root.all("button").find((button) => button.textContent === "Inspect recovery")?.fire("click");
    expect(callbacks.openRecovery).toHaveBeenCalledOnce();
    expect(callbacks.replan).not.toHaveBeenCalled();
    await root.all("button").find((button) => button.textContent === "Replan and review")?.fire("click");
    expect(callbacks.replan).toHaveBeenCalledWith(items[1]);
    await root.all("button").find((button) => button.textContent === "Next")?.fire("click");
    expect(root.all("h4")).toHaveLength(11);
  });

  it("replans sweep-only rules without writing and redirects unresolved mutations to recovery", async () => {
    const file = Object.assign(new TFile(), { path: "Inbox/note.md", basename: "note", extension: "md", stat: { ctime: 1, mtime: 1, size: 0 } });
    const write = vi.fn();
    const app = { vault: { getFileByPath: () => file }, metadataCache: { getFileCache: () => ({}) }, fileManager: { processFrontMatter: write, renameFile: write } } as unknown as App;
    const plugin = new VaultFlowPlugin(app, {} as PluginManifest);
    const host = plugin as unknown as { loaded: boolean; replanInboxItem(item: WorkInboxItem): Promise<void>; openVaultPreview(files: readonly TFile[], contexts: readonly RuleRunOn[]): Promise<void>; openWriteRecovery(): void; journal: { blockedReason: null; entries(): readonly JournalEntry[] } | null };
    host.loaded = true;
    plugin.settings = { ...plugin.settings, rules: [{ id: "sweep", name: "Sweep", enabled: true, priority: 0, order: 0, runOn: "sweep", when: { type: "pathGlob", glob: "**" }, then: { setProperties: { review: true } } }] };
    const preview = vi.spyOn(host, "openVaultPreview").mockImplementation(async (files, contexts) => {
      const plan = await planReconciliationForFile(app, files[0], plugin.settings, { triggerContext: contexts });
      expect(plan.preview.appliedRuleIds).toEqual(["sweep"]);
      expect(plan.preview.outcome).toBe("changed");
    });
    const item = buildWorkInbox([decision()], [])[0];
    await host.replanInboxItem(item);
    expect(preview).toHaveBeenCalledWith([file], ["sweep"]);
    expect(write).not.toHaveBeenCalled();
    const recovery = vi.spyOn(host, "openWriteRecovery").mockImplementation(() => {});
    host.journal = { blockedReason: null, entries: () => [pending] };
    await host.replanInboxItem(item);
    expect(recovery).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
});
