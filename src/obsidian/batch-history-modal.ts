import { Modal, type App } from "obsidian";
import type { BatchReceipt } from "./batch-history";

export class BatchHistoryModal extends Modal {
  public constructor(app: App, private readonly receipts: readonly BatchReceipt[]) { super(app); }

  override onOpen(): void {
    this.setTitle("Vault Flow — batch receipts");
    this.contentEl.empty();
    if (this.receipts.length === 0) this.contentEl.createEl("p", { text: "No retained apply batches on this device." });
    for (const receipt of [...this.receipts].reverse()) {
      const details = this.contentEl.createEl("details");
      details.createEl("summary", { text: `${new Date(receipt.startedAt).toLocaleString()} — ${receipt.status}: ${receipt.applied} applied, ${receipt.skipped} skipped, ${receipt.failed} failed, ${receipt.unprocessed} unprocessed` });
      details.createEl("p", { text: `Batch ${receipt.batchId}${receipt.truncated ? "; row details were truncated by retention limits" : ""}.` });
      const rowsEl = details.createDiv();
      let page = 0;
      const renderPage = (): void => {
        rowsEl.empty();
        const pageCount = Math.max(1, Math.ceil(receipt.rows.length / 100));
        const actions = rowsEl.createDiv({ cls: "vf-modal-actions" });
        const previous = actions.createEl("button", { text: "Previous" });
        previous.disabled = page === 0;
        previous.onclick = () => { page -= 1; renderPage(); };
        actions.createSpan({ text: `Page ${page + 1} of ${pageCount}` });
        const next = actions.createEl("button", { text: "Next" });
        next.disabled = page === pageCount - 1;
        next.onclick = () => { page += 1; renderPage(); };
        const table = rowsEl.createEl("table", { cls: "vf-preview-table" });
        const header = table.createEl("thead").createEl("tr");
        for (const label of ["File", "Outcome", "After path / reason"]) header.createEl("th", { text: label, attr: { scope: "col" } });
        const body = table.createEl("tbody");
        for (const row of receipt.rows.slice(page * 100, (page + 1) * 100)) {
          const tr = body.createEl("tr");
          for (const text of [row.path, row.outcome, row.message ?? row.afterPath ?? "—"]) tr.createEl("td", { text });
        }
      };
      let rendered = false;
      details.addEventListener("toggle", () => {
        if (details.open && !rendered) { rendered = true; renderPage(); }
      });
    }
  }

  override onClose(): void { this.contentEl.empty(); }
}
