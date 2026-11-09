import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { VaultPreviewEntry } from "../../src/obsidian/vault-preview-modal";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";
import { exportPreviewSummary, filterPreviewEntries, previewReviewSummary } from "../../src/obsidian/bulk-review";
import { UndoHistoryModal, undoHistoryPage } from "../../src/obsidian/undo-history-modal";
import { TestElement } from "../helpers/dom";

function entry(path: string, ruleId: string, desiredPath = path): VaultPreviewEntry {
  return { path, desiredPath, propertyChangeCount: 1, preview: { needsBodyContent: false,
    current: { path, basename: "note", extension: "md", frontmatter: { password: "private-value" }, bodyContent: "private-body", tags: [] }, result: null,
    preview: { path, desiredPath, outcome: "changed", appliedRuleIds: [ruleId], involvedRuleIds: [], iterations: 1, mutationKinds: ["frontmatter"], message: "" } } };
}
function decision(index: number): ReconciliationDecision {
  return { timestamp: index, path: `Inbox/${index}.md`, desiredPath: `Archive/${index}.md`, outcome: "changed", transactionId: String(index), appliedRuleIds: [], involvedRuleIds: [], iterations: 1, mutationKinds: ["move"] };
}

describe("bulk review helpers", () => {
  it("combines path/status/rule filters and stable grouping", () => {
    const entries = [entry("Z/note.md", "two"), entry("A/note.md", "one"), entry("B/note.md", "one", "Archive/target.md")];
    expect(filterPreviewEntries(entries, { query: "ARCHIVE", outcome: "changed", ruleId: "one", groupBy: "folder" })).toEqual([entries[2]]);
    expect(filterPreviewEntries(entries, { query: "", outcome: "", ruleId: "", groupBy: "rule" })).toEqual([entries[1], entries[2], entries[0]]);
    expect(entries[0]?.path).toBe("Z/note.md");
  });
  it("warns about duplicate proposed destinations", () => {
    expect(previewReviewSummary([entry("a.md", "r", "same.md"), entry("b.md", "r", "same.md")])).toContain("1 duplicate proposed destination");
  });
  it("exports no bodies or property values", () => {
    const text = exportPreviewSummary([entry("note.md", "r")]);
    expect(text).toContain('"password"');
    expect(text).not.toContain("private-value");
    expect(text).not.toContain("private-body");
  });
});

describe("all retained undo history", () => {
  it("makes older entries accessible instead of discarding everything beyond 20", () => {
    const entries = Array.from({ length: 55 }, (_, i) => decision(i));
    expect(undoHistoryPage(entries, 0)).toMatchObject({ total: 55, pages: 3, items: entries.slice(35).reverse() });
    expect(undoHistoryPage(entries, 2).items).toEqual(entries.slice(0, 15).reverse());
    expect(undoHistoryPage(entries, 100).page).toBe(2);
  });
  it("filters both paths and batches and excludes reverted transactions", () => {
    const entries = [decision(0), { ...decision(1), batchId: "find-me" }, { ...decision(0), outcome: "undone" as const, revertsTransactionId: "0" }];
    expect(undoHistoryPage(entries, 0, "find-me").items).toEqual([entries[1]]);
    expect(undoHistoryPage(entries, 0, "Archive").total).toBe(1);
  });
  it("renders pages of 20 and retains disabled legacy undo controls", async () => {
    const history = Array.from({ length: 45 }, (_, i) => decision(i));
    const onUndo = vi.fn();
    const modal = new UndoHistoryModal({} as App, () => history, onUndo);
    const root = new TestElement(); modal.contentEl = root.asElement(); modal.onOpen();
    expect(root.all("button").filter((button) => button.textContent === "Undo")).toHaveLength(20);
    expect(root.all("button").filter((button) => button.textContent === "Undo").every((button) => button.disabled)).toBe(true);
    await root.all("button").find((button) => button.textContent === "Next")?.fire("click");
    await root.all("button").find((button) => button.textContent === "Next")?.fire("click");
    expect(root.all("button").filter((button) => button.textContent === "Undo")).toHaveLength(5);
    expect(onUndo).not.toHaveBeenCalled();
  });
});
