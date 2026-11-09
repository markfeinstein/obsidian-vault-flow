import { ConfirmationModal, Modal, Notice, type App } from "obsidian";
import type { ReconciliationDecision } from "./diagnostics";

export function undoableDecisions(decisions: readonly ReconciliationDecision[]): readonly ReconciliationDecision[] {
  const reverted = new Set(decisions.filter((decision) => decision.outcome === "undone").map((decision) => decision.revertsTransactionId));
  return [...decisions].reverse().filter((decision) => decision.outcome === "changed"
    && (decision.transactionId === undefined || !reverted.has(decision.transactionId))
    && ((decision.desiredPath !== undefined && decision.desiredPath !== decision.path) || (decision.beforeFrontmatter !== undefined && decision.afterFrontmatter !== undefined)));
}

export function undoHistoryPage(decisions: readonly ReconciliationDecision[], page: number, query = "", pageSize = 20): {
  readonly items: readonly ReconciliationDecision[]; readonly total: number; readonly page: number; readonly pages: number;
} {
  const normalized = query.toLocaleLowerCase();
  const filtered = undoableDecisions(decisions).filter((decision) => !normalized || [decision.path, decision.desiredPath ?? "", decision.batchId ?? ""].some((value) => value.toLocaleLowerCase().includes(normalized)));
  const size = Math.max(1, Math.floor(pageSize));
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const index = Math.max(0, Math.min(pages - 1, page));
  return { items: filtered.slice(index * size, (index + 1) * size), total: filtered.length, page: index, pages };
}

function formatTimestampShort(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return String(timestamp);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class UndoHistoryModal extends Modal {
  private page = 0;
  private query = "";
  public constructor(app: App, private readonly getDecisions: () => readonly ReconciliationDecision[],
    private readonly onUndo: (decision: ReconciliationDecision) => Promise<void>,
    private readonly onUndoBatch?: (batchId: string) => Promise<void>) { super(app); }

  override onOpen(): void { this.setTitle("Vault Flow — undo history"); this.render(); }
  override onClose(): void { this.contentEl.empty(); }

  private render(focusQueryAt?: number): void {
    this.contentEl.empty();
    const history = this.getDecisions();
    const current = undoHistoryPage(history, this.page, this.query);
    this.page = current.page;
    const controls = this.contentEl.createDiv({ cls: "vf-preview-controls" });
    const search = controls.createEl("input", { type: "search", attr: { placeholder: "Filter paths or batch ID", "aria-label": "Filter undo history" } });
    search.value = this.query;
    search.addEventListener("input", () => { this.query = search.value; this.page = 0; this.render(search.selectionStart ?? search.value.length); });
    if (focusQueryAt !== undefined) { search.focus?.(); search.setSelectionRange?.(focusQueryAt, focusQueryAt); }
    const previous = controls.createEl("button", { text: "Previous" }); previous.disabled = this.page === 0;
    previous.onclick = () => { this.page--; this.render(); };
    controls.createSpan({ text: `Page ${current.page + 1} of ${current.pages}; ${current.total} retained transaction(s)`, attr: { "aria-live": "polite" } });
    const next = controls.createEl("button", { text: "Next" }); next.disabled = this.page >= current.pages - 1;
    next.onclick = () => { this.page++; this.render(); };

    if (current.total === 0) { this.contentEl.createEl("p", { text: "No matching retained Vault Flow transactions." }); return; }
    if (this.onUndoBatch !== undefined) {
      const visibleBatches = new Set(current.items.map((decision) => decision.batchId));
      const batches = new Map<string, number>();
      for (const decision of undoableDecisions(history)) if (decision.batchId !== undefined && visibleBatches.has(decision.batchId) && decision.afterIdentity !== undefined) {
        batches.set(decision.batchId, (batches.get(decision.batchId) ?? 0) + 1);
      }
      for (const [batchId, count] of batches) {
        const button = this.contentEl.createEl("button", { text: `Undo entire batch (${count} retained transactions)`, cls: "vf-undo-batch-button" });
        button.onclick = async () => {
          if (!(await confirmUndo(this.app, `Undo all ${count} verified retained transactions in batch ${batchId}, including entries on other pages or outside this filter? Each note is checked before undo.`))) return;
          button.disabled = true;
          try { await this.onUndoBatch?.(batchId); }
          catch (error) { new Notice(`Vault Flow batch undo failed: ${error instanceof Error ? error.message : String(error)}`); }
          finally { this.render(); }
        };
      }
    }

    const listEl = this.contentEl.createDiv({ cls: "vf-undo-list" });
    for (const decision of current.items) {
      const row = listEl.createDiv({ cls: "vf-undo-row" });
      const info = row.createDiv({ cls: "vf-undo-info" });
      info.createDiv({ text: formatTimestampShort(decision.timestamp), cls: "vf-undo-timestamp" });
      const paths = info.createDiv({ cls: "vf-undo-paths" });
      paths.createSpan({ text: decision.path, cls: "vf-undo-from-path" });
      if (decision.desiredPath !== undefined && decision.desiredPath !== decision.path) {
        paths.createSpan({ text: " → " }); paths.createSpan({ text: decision.desiredPath, cls: "vf-undo-to-path" });
      }
      if (decision.beforeFrontmatter !== undefined || decision.afterFrontmatter !== undefined) info.createDiv({ text: "Includes a complete frontmatter snapshot.", cls: "vf-muted" });
      const undo = row.createEl("button", { text: "Undo", cls: "vf-undo-button" });
      undo.disabled = decision.afterIdentity === undefined;
      if (undo.disabled) info.createDiv({ text: "Undo unavailable: no verified note identity was captured.", cls: "vf-muted" });
      undo.onclick = async () => {
        if (!(await confirmUndo(this.app, `Undo the transaction for ${decision.desiredPath ?? decision.path}? The current note identity and frontmatter must still match.`))) return;
        undo.disabled = true; undo.textContent = "Undoing…";
        try { await this.onUndo(decision); }
        catch (error) { new Notice(`Vault Flow undo failed: ${error instanceof Error ? error.message : String(error)}`); }
        finally { this.render(); }
      };
    }
  }
}

function confirmUndo(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new ConfirmationModal(app);
    modal.setTitle("Confirm Vault Flow undo"); modal.setContent(message);
    modal.addButton((button) => button.setButtonText("Undo transaction(s)").setDestructive().onClick(() => { settled = true; resolve(true); }));
    modal.addCancelButton(); modal.setCloseCallback(() => { if (!settled) resolve(false); }); modal.open();
  });
}
