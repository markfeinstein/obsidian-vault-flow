import { ConfirmationModal, Modal, Notice, type App } from "obsidian";
import type { JournalEntry } from "./transaction-journal";

/** Inspection is always available; no note rollback is attempted from an unverified pending snapshot. */
export class RecoveryModal extends Modal {
  public constructor(app: App, private readonly getEntries: () => readonly JournalEntry[],
    private readonly restoreHistory: (entry: JournalEntry) => Promise<boolean>,
    private readonly acknowledge: (id: string) => Promise<void>, private readonly blockedReason: string | null = null) { super(app); }
  override onOpen(): void { this.setTitle("Vault Flow — pending-write recovery"); this.render(); }
  override onClose(): void { this.contentEl.empty(); }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "These device-local snapshots survive interrupted writes. No note is automatically rolled back. Inspect current notes and independent backups before acknowledging an entry. Exports include complete property values." });
    if (this.blockedReason !== null) this.contentEl.createEl("p", { text: this.blockedReason });
    const entries = this.getEntries();
    if (entries.length === 0) { this.contentEl.createEl("p", { text: "No pending writes." }); return; }
    for (const entry of [...entries].reverse()) {
      const row = this.contentEl.createDiv({ cls: "vf-undo-row" });
      const info = row.createDiv({ cls: "vf-undo-info" });
      info.createEl("h4", { text: `${entry.beforePath} → ${entry.afterPath}` });
      info.createEl("p", { text: `${entry.status}; ${new Date(entry.timestamp).toLocaleString()}; ${entry.transactionId}` });
      const details = info.createEl("details");
      details.createEl("summary", { text: "Inspect before/after property snapshots" });
      details.createEl("pre", { text: JSON.stringify({ before: entry.beforeFrontmatter, after: entry.afterFrontmatter }, null, 2) });
      const buttons = info.createDiv({ cls: "vf-preview-controls" });
      const open = buttons.createEl("button", { text: "Open current destination note" });
      open.onclick = async () => { await this.app.workspace.openLinkText(entry.afterPath, "", true); };
      const copy = buttons.createEl("button", { text: "Copy recovery snapshot (includes properties)" });
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(entry, null, 2)); new Notice("Recovery snapshot copied. Store it securely."); }
        catch { new Notice("Could not copy recovery data."); }
      };
      const recover = buttons.createEl("button", { text: "Restore verified write to history" });
      recover.disabled = entry.status !== "completed" || entry.transaction?.afterIdentity === undefined;
      recover.onclick = async () => {
        recover.disabled = true;
        try { await this.restoreHistory(entry); } finally { this.render(); }
      };
      const acknowledge = buttons.createEl("button", { text: "Acknowledge after manual inspection" });
      acknowledge.onclick = async () => {
        acknowledge.disabled = true;
        try {
          if (await confirmAcknowledgment(this.app, entry)) await this.acknowledge(entry.transactionId);
        } catch (error) { new Notice(`Could not acknowledge recovery entry: ${error instanceof Error ? error.message : String(error)}`); }
        finally { this.render(); }
      };
    }
  }
}
function confirmAcknowledgment(app: App, entry: JournalEntry): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false; const modal = new ConfirmationModal(app);
    modal.setTitle("Discard this recovery snapshot?");
    modal.setContent(`You must inspect ${entry.beforePath} and ${entry.afterPath} first. Acknowledging only deletes the device-local recovery snapshot; it does not repair the note, restore a backup, or resume writes.`);
    modal.addButton((button) => button.setButtonText("I inspected the note; acknowledge").setDestructive().onClick(() => { settled = true; resolve(true); }));
    modal.addCancelButton(); modal.setCloseCallback(() => { if (!settled) resolve(false); }); modal.open();
  });
}
