import { describe, expect, it, vi } from "vitest";
import { TFile, type App } from "obsidian";
import { RecoveryModal } from "../../src/obsidian/recovery-modal";
import type { JournalEntry } from "../../src/obsidian/transaction-journal";
import { TestElement } from "../helpers/dom";

const pending: JournalEntry = {
  transactionId: "pending", timestamp: 1, beforePath: "Inbox/note.md", afterPath: "Done/note.md",
  status: "started", mutationKinds: ["move"], ruleIds: ["r"], iterations: 1,
};

function render(file: TFile | null) {
  const getFileByPath = vi.fn(() => file);
  const openFile = vi.fn(async (_file: TFile) => {});
  const getLeaf = vi.fn(() => ({ openFile }));
  const openLinkText = vi.fn(async () => {});
  const restoreHistory = vi.fn(async () => true);
  const acknowledge = vi.fn(async () => {});
  const app = { vault: { getFileByPath }, workspace: { getLeaf, openLinkText } } as unknown as App;
  const modal = new RecoveryModal(app, () => [pending], restoreHistory, acknowledge);
  const root = new TestElement();
  modal.contentEl = root.asElement();
  modal.onOpen();
  const button = root.all("button").find((button) => button.textContent === "Open current destination note");
  if (button === undefined) throw new Error("Missing destination inspection control");
  return { button, getFileByPath, openFile, getLeaf, openLinkText, restoreHistory, acknowledge };
}

describe("pending-write destination inspection", () => {
  it("opens only the exact existing destination file without resolving a creatable link", async () => {
    const file = Object.assign(new TFile(), { path: pending.afterPath });
    const view = render(file);
    await view.button.fire("click");
    expect(view.getFileByPath).toHaveBeenCalledWith(pending.afterPath);
    expect(view.getLeaf).toHaveBeenCalledWith(true);
    expect(view.openFile).toHaveBeenCalledWith(file);
    expect(view.openLinkText).not.toHaveBeenCalled();
    expect(view.restoreHistory).not.toHaveBeenCalled();
    expect(view.acknowledge).not.toHaveBeenCalled();
  });

  it("does not create a missing destination while inspecting an interrupted write", async () => {
    const view = render(null);
    await view.button.fire("click");
    expect(view.getLeaf).not.toHaveBeenCalled();
    expect(view.openFile).not.toHaveBeenCalled();
    expect(view.openLinkText).not.toHaveBeenCalled();
    expect(view.acknowledge).not.toHaveBeenCalled();
  });

  it("rechecks the exact destination when a note moves after the recovery view opens", async () => {
    const view = render(Object.assign(new TFile(), { path: pending.afterPath }));
    view.getFileByPath.mockReturnValue(null);
    await view.button.fire("click");
    expect(view.getFileByPath).toHaveBeenCalledOnce();
    expect(view.getLeaf).not.toHaveBeenCalled();
    expect(view.openLinkText).not.toHaveBeenCalled();
    expect(view.acknowledge).not.toHaveBeenCalled();
  });

  it("handles a file-open failure without recreating a path or acknowledging recovery", async () => {
    const view = render(Object.assign(new TFile(), { path: pending.afterPath }));
    view.openFile.mockRejectedValue(new Error("Note removed during opening"));
    await expect(view.button.fire("click")).resolves.toBeUndefined();
    expect(view.openLinkText).not.toHaveBeenCalled();
    expect(view.restoreHistory).not.toHaveBeenCalled();
    expect(view.acknowledge).not.toHaveBeenCalled();
  });
});
