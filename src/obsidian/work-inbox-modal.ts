import { Modal, Notice, type App } from "obsidian";
import { MAX_WORK_INBOX_ITEMS, type WorkInboxItem } from "./work-inbox";

const PAGE_SIZE = 50;
export interface WorkInboxCallbacks {
  readonly replan: (item: WorkInboxItem) => Promise<void>;
  readonly openNote: (path: string) => Promise<void>;
  readonly openRecovery: () => void;
}
export class WorkInboxModal extends Modal {
  private page = 0;
  public constructor(app: App, private readonly getItems: () => readonly WorkInboxItem[], private readonly callbacks: WorkInboxCallbacks) { super(app); }
  override onOpen(): void { this.setTitle("Vault Flow — failed-work inbox"); this.render(); }
  override onClose(): void { this.contentEl.empty(); }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Recent unresolved work and pending-write recovery. Replan and review is read-only until you explicitly confirm a fresh apply preview; nothing here blindly retries an old mutation. Legacy diagnostics without a trigger use manual rules." });
    const items = this.getItems().slice(0, MAX_WORK_INBOX_ITEMS);
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    const controls = this.contentEl.createDiv({ cls: "vf-preview-controls" });
    const refresh = controls.createEl("button", { text: "Refresh inbox" }); refresh.onclick = () => { this.render(); };
    const recovery = controls.createEl("button", { text: "Inspect pending-write recovery" }); recovery.onclick = () => { this.callbacks.openRecovery(); };
    const previous = controls.createEl("button", { text: "Previous" }); previous.disabled = this.page === 0;
    previous.onclick = () => { this.page -= 1; this.render(); };
    controls.createSpan({ text: `${items.length} unresolved item(s), page ${this.page + 1} of ${pages} (at most ${MAX_WORK_INBOX_ITEMS} shown)`, attr: { role: "status", "aria-live": "polite" } });
    const next = controls.createEl("button", { text: "Next" }); next.disabled = this.page === pages - 1;
    next.onclick = () => { this.page += 1; this.render(); };
    if (items.length === 0) this.contentEl.createEl("p", { text: "No unresolved recent work. Older diagnostics may have expired; this inbox is not a durable job queue." });
    for (const item of items.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)) {
      const row = this.contentEl.createDiv({ cls: "vf-undo-row" });
      const info = row.createDiv({ cls: "vf-undo-info" });
      info.createEl("h4", { text: `${item.kind}: ${item.path}` });
      info.createEl("p", { text: `${item.timestamp > 0 ? new Date(item.timestamp).toLocaleString() : "Waiting"}; triggers: ${item.triggerContexts.join(", ")}` });
      info.createEl("p", { text: item.message });
      const actions = info.createDiv({ cls: "vf-preview-controls" });
      const open = actions.createEl("button", { text: "Open existing note" });
      open.onclick = async () => {
        try { await this.callbacks.openNote(item.path); }
        catch (error) { new Notice(`Could not open note: ${error instanceof Error ? error.message : String(error)}`); }
      };
      const action = actions.createEl("button", { text: item.recovery ? "Inspect recovery" : "Replan and review" });
      action.onclick = async () => {
        action.disabled = true;
        try {
          if (item.recovery) this.callbacks.openRecovery();
          else { this.close(); await this.callbacks.replan(item); }
        } catch (error) { new Notice(`Could not replan: ${error instanceof Error ? error.message : String(error)}`); }
        finally { action.disabled = false; }
      };
    }
  }
}
