import { ConfirmationModal, Modal, Notice, type App } from "obsidian";
import type { SettingsRevision } from "./settings-history";

export interface SettingsRestoreRequest {
  readonly summary: string;
  readonly apply: () => Promise<void>;
}
export class SettingsHistoryModal extends Modal {
  public constructor(app: App, private readonly getEntries: () => readonly SettingsRevision[], private readonly prepareRestore: (id: string) => SettingsRestoreRequest,
    private readonly blockedReason: string | null = null) { super(app); }
  override onOpen(): void { this.setTitle("Vault Flow — settings revision history"); this.render(); }
  override onClose(): void { this.contentEl.empty(); }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Device-local rules and configuration snapshots: at most 20 revisions, 512 KiB per revision and 2 MiB total. Copies include rule values and fixtures; store them securely. No note bodies, undo history, or runtime statistics are included. This is not an independent backup." });
    this.contentEl.createEl("p", { text: "Restore requires compatible settings, checks for concurrent changes, and leaves writes paused. It does not undo changes to notes or clear pending-write recovery." });
    if (this.blockedReason !== null) this.contentEl.createEl("p", { text: this.blockedReason });
    const refresh = this.contentEl.createEl("button", { text: "Refresh revisions" }); refresh.onclick = () => { this.render(); };
    const entries = this.getEntries();
    if (entries.length === 0) this.contentEl.createEl("p", { text: "No retained settings revisions." });
    for (const entry of [...entries].reverse()) {
      const row = this.contentEl.createDiv({ cls: "vf-undo-row" });
      const info = row.createDiv({ cls: "vf-undo-info" });
      info.createEl("h4", { text: `${new Date(entry.timestamp).toLocaleString()} — ${entry.source}` });
      info.createEl("p", { text: entry.id });
      const controls = info.createDiv({ cls: "vf-preview-controls" });
      const copy = controls.createEl("button", { text: "Copy revision JSON" });
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(entry.data); new Notice("Settings revision copied; store it securely."); }
        catch { new Notice("Could not copy settings revision."); }
      };
      const restore = controls.createEl("button", { text: "Review restore" });
      restore.disabled = this.blockedReason !== null;
      restore.onclick = async () => {
        restore.disabled = true;
        try {
          const request = this.prepareRestore(entry.id);
          if (await confirmRestore(this.app, request.summary)) await request.apply();
        } catch (error) { new Notice(`Could not restore settings: ${error instanceof Error ? error.message : String(error)}`); }
        finally { this.render(); }
      };
    }
  }
}
function confirmRestore(app: App, summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new ConfirmationModal(app);
    modal.setTitle("Restore this settings revision?");
    modal.setContent(summary);
    modal.addButton((button) => button.setButtonText("Restore settings; keep writes paused").setDestructive().onClick(() => { settled = true; resolve(true); }));
    modal.addCancelButton(); modal.setCloseCallback(() => { if (!settled) resolve(false); }); modal.open();
  });
}
