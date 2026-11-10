import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationModal, TFile, TFolder, type App } from "obsidian";
import { noteStateFromObsidian } from "../../src/obsidian/adapter";
import { reserveBatchDestinations } from "../../src/obsidian/batch-destinations";
import { withNoteStatePath } from "../../src/obsidian/note-state";
import { VaultPreviewModal, type VaultPreviewEntry } from "../../src/obsidian/vault-preview-modal";
import type { ReconciliationDecision } from "../../src/obsidian/diagnostics";
import { TestElement } from "../helpers/dom";

afterEach(() => { vi.restoreAllMocks(); });
function harness() {
  const files = new Map<string, TFile>();
  const addFile = (path: string): TFile => {
    const file = Object.assign(new TFile(), { path, basename: path.split("/").at(-1)?.slice(0, -3) ?? "", extension: "md", stat: { ctime: 1, mtime: 2, size: 0 } });
    files.set(path, file); return file;
  };
  const first = addFile("Inbox/a.md"), second = addFile("Inbox/b.md");
  const folder = Object.assign(new TFolder(), { path: "Done" });
  const renameFile = vi.fn(async (file: TFile, path: string) => {
    files.delete(file.path); file.path = path; file.basename = path.split("/").at(-1)?.slice(0, -3) ?? ""; files.set(path, file);
  });
  const app = {
    metadataCache: { getFileCache: () => ({}) },
    vault: { configDir: ".obsidian", getFileByPath: (path: string) => files.get(path) ?? null,
      getAbstractFileByPath: (path: string) => path === "Done" ? folder : files.get(path) ?? null,
      createFolder: async () => folder, read: async () => "" },
    fileManager: { renameFile },
  } as unknown as App;
  const entry = (file: TFile, target = "Done/shared.md"): VaultPreviewEntry => {
    const current = noteStateFromObsidian(file, {});
    const result = { status: "converged" as const, desired: withNoteStatePath(current, target), mutations: [{ kind: "move" as const, ruleIds: ["move"] }, { kind: "rename" as const, ruleIds: ["move"] }], appliedRuleIds: ["move"], iterations: 1, changed: true, dryRunRuleIds: [] };
    return { path: current.path, desiredPath: target, propertyChangeCount: 0, selected: true, preview: { current, result, needsBodyContent: false, collisionBasePath: target,
      preview: { outcome: "changed", path: current.path, desiredPath: target, appliedRuleIds: ["move"], involvedRuleIds: [], mutationKinds: ["move", "rename"], iterations: 1, message: "Preview" } } };
  };
  return { app, first, second, entry, files, addFile, renameFile };
}
function approveConfirmations(): void {
  vi.spyOn(ConfirmationModal.prototype, "addButton").mockImplementation(function (this: ConfirmationModal, callback) {
    const button = { setButtonText() { return this; }, setCta() { return this; }, setInitialFocus() { return this; }, onClick(handler: () => void) { handler(); return this; } };
    callback(button as unknown as Parameters<typeof callback>[0]); return this;
  });
}

describe("deterministic selected-batch destinations", () => {
  it("reserves unique suffixes across selected rows without changing the original previews", () => {
    const h = harness(); const a = h.entry(h.first), b = h.entry(h.second);
    const plans = reserveBatchDestinations(h.app, [a, b], "rename-with-suffix");
    expect([...plans.values()].map((row) => row.desiredPath)).toEqual(["Done/shared.md", "Done/shared 1.md"]);
    expect(b.desiredPath).toBe("Done/shared.md");
    expect(plans.get(b)?.preview.result?.desired.basename).toBe("shared 1");
    h.addFile("Done/shared.md"); h.addFile("Done/shared 1.md");
    expect([...reserveBatchDestinations(h.app, [a, b], "rename-with-suffix").values()].map((row) => row.desiredPath)).toEqual(["Done/shared 2.md", "Done/shared 3.md"]);
  });

  it("blocks duplicate destinations under skip policy, duplicate sources, and unsafe vacate assumptions", () => {
    const h = harness(); const a = h.entry(h.first), b = h.entry(h.second);
    expect(reserveBatchDestinations(h.app, [a, b], "skip").get(b)?.preview.result).toBeNull();
    const duplicate = { ...a };
    expect(reserveBatchDestinations(h.app, [a, duplicate], "rename-with-suffix").get(duplicate)?.preview.preview.message).toContain("same source");
    const swap = h.entry(h.first, h.second.path);
    expect(reserveBatchDestinations(h.app, [swap], "skip").get(swap)?.preview.result).toBeNull();
  });

  it("reserves planned parent folders and blocks paths beneath an occupied or reserved file", () => {
    const h = harness();
    const nested = h.entry(h.first, "Done/parent.md/note.md"), parent = h.entry(h.second, "Done/parent.md");
    expect(reserveBatchDestinations(h.app, [nested, parent], "rename-with-suffix").get(parent)?.desiredPath).toBe("Done/parent 1.md");
    const fileFirst = h.entry(h.first, "Done/parent.md"), childLater = h.entry(h.second, "Done/parent.md/note.md");
    const blocked = reserveBatchDestinations(h.app, [fileFirst, childLater], "rename-with-suffix").get(childLater);
    expect(blocked?.preview.result).toBeNull();
    expect(blocked?.preview.preview.message).toContain("parent is a file");
    h.addFile("Done/parent.md");
    expect(reserveBatchDestinations(h.app, [nested], "rename-with-suffix").get(nested)?.preview.result).toBeNull();
  });

  it("renders and confirms the reserved names, then writes exactly those names", async () => {
    const h = harness(); const entries = [h.entry(h.first), h.entry(h.second)];
    const modal = new VaultPreviewModal(h.app, entries, { collisionPolicy: () => "rename-with-suffix" });
    const root = new TestElement(); modal.contentEl = root.asElement(); modal.onOpen();
    expect(root.all("td").some((cell) => cell.textContent === "Done/shared 1.md")).toBe(true);
    const confirmation = vi.spyOn(ConfirmationModal.prototype, "setContent"); approveConfirmations();
    const apply = root.all("button").find((button) => button.textContent === "Apply selected");
    if (apply === undefined) throw new Error("Missing apply button");
    await apply.fire("click");
    expect(confirmation).toHaveBeenCalledWith(expect.stringContaining("Inbox/b.md → Done/shared 1.md"));
    expect(h.renameFile.mock.calls.map((call) => call[1])).toEqual(["Done/shared.md", "Done/shared 1.md"]);
  });

  it("disables apply for selected conflicts until the conflicting row is deselected", async () => {
    const h = harness(); const modal = new VaultPreviewModal(h.app, [h.entry(h.first), h.entry(h.second)], { collisionPolicy: () => "skip" });
    const root = new TestElement(); modal.contentEl = root.asElement(); modal.onOpen();
    expect(root.all("button").find((button) => button.textContent === "Apply selected")?.disabled).toBe(true);
    const checkbox = root.all("input").filter((input) => input.attributes.type === "checkbox")[1];
    if (checkbox === undefined) throw new Error("Missing checkbox");
    checkbox.checked = false; await checkbox.fire("change");
    expect(root.all("button").find((button) => button.textContent === "Apply selected")?.disabled).toBe(false);
  });

  it("rechecks the exact target after asynchronous folder preparation", async () => {
    const h = harness(); const entry = h.entry(h.first); const decisions: ReconciliationDecision[] = [];
    h.app.vault.getAbstractFileByPath = (path) => h.files.get(path) ?? null;
    h.app.vault.createFolder = async () => { h.addFile("Done/shared.md"); return Object.assign(new TFolder(), { path: "Done" }); };
    const modal = new VaultPreviewModal(h.app, [], { collisionPolicy: () => "rename-with-suffix", recordDecision: (decision) => { decisions.push(decision); } });
    await (modal as unknown as { applySelected(entries: readonly VaultPreviewEntry[]): Promise<void> }).applySelected([entry]);
    expect(h.renameFile).not.toHaveBeenCalled();
    expect(decisions[0]?.outcome).toBe("error");
    expect(decisions[0]?.message).toContain("reviewed destination");
  });
});
