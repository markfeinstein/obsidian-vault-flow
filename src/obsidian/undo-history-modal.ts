import { Modal, type App } from "obsidian";
import type { ReconciliationDecision } from "./diagnostics";

function formatTimestampShort(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return String(timestamp);
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class UndoHistoryModal extends Modal {
  public constructor(
    app: App,
    private readonly getDecisions: () => readonly ReconciliationDecision[],
    private readonly onUndo: (decision: ReconciliationDecision) => Promise<void>,
    private readonly onUndoBatch?: (batchId: string) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Vault Flow — undo history");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private getUndoableDecisions(): readonly ReconciliationDecision[] {
    const decisions = this.getDecisions();
    const revertedTransactions = new Set(
      decisions
        .filter((decision) => decision.outcome === "undone" && decision.revertsTransactionId !== undefined)
        .map((decision) => decision.revertsTransactionId as string),
    );
    return [...decisions]
      .filter((decision) => decision.outcome === "changed")
      .filter((decision) => decision.transactionId === undefined || !revertedTransactions.has(decision.transactionId))
      .filter((decision) => {
        const pathChanged = decision.desiredPath !== undefined && decision.desiredPath !== decision.path;
        const hasCompleteFrontmatterSnapshot = decision.beforeFrontmatter !== undefined && decision.afterFrontmatter !== undefined;
        return pathChanged || hasCompleteFrontmatterSnapshot;
      })
      .slice(-20)
      .reverse();
  }

  private render(): void {
    this.contentEl.empty();

    const decisions = this.getUndoableDecisions();
    if (decisions.length === 0) {
      this.contentEl.createEl("p", { text: "No recent Vault Flow transactions are safe to undo." });
      return;
    }

    if (this.onUndoBatch !== undefined) {
      const batches = new Map<string, number>();
      for (const decision of this.getDecisions()) {
        if (decision.outcome === "changed" && decision.batchId !== undefined && decision.afterIdentity !== undefined) {
          batches.set(decision.batchId, (batches.get(decision.batchId) ?? 0) + 1);
        }
      }
      for (const [batchId, count] of batches) {
        const button = this.contentEl.createEl("button", { text: `Undo batch (${count} retained transactions)`, cls: "vf-undo-batch-button" });
        button.onclick = async () => {
          button.disabled = true;
          try { await this.onUndoBatch?.(batchId); } finally { this.render(); }
        };
      }
    }
    const listEl = this.contentEl.createDiv({ cls: "vf-undo-list" });

    for (const decision of decisions) {
      const row = listEl.createDiv({ cls: "vf-undo-row" });
      const info = row.createDiv({ cls: "vf-undo-info" });
      info.createDiv({ text: formatTimestampShort(decision.timestamp), cls: "vf-undo-timestamp" });

      const pathsEl = info.createDiv({ cls: "vf-undo-paths" });
      pathsEl.createSpan({ text: decision.path, cls: "vf-undo-from-path" });
      if (decision.desiredPath !== undefined && decision.desiredPath !== decision.path) {
        pathsEl.createSpan({ text: " → " });
        pathsEl.createSpan({ text: decision.desiredPath, cls: "vf-undo-to-path" });
      }

      if (decision.beforeFrontmatter !== undefined || decision.afterFrontmatter !== undefined) {
        info.createDiv({ text: "Includes a complete frontmatter snapshot.", cls: "vf-muted" });
      }

      const undoBtn = row.createEl("button", { text: "Undo", cls: "vf-undo-button" });
      undoBtn.disabled = decision.afterIdentity === undefined;
      if (decision.afterIdentity === undefined) info.createDiv({ text: "Undo unavailable: no verified note identity was captured.", cls: "vf-muted" });
      undoBtn.onclick = async () => {
        undoBtn.disabled = true;
        undoBtn.textContent = "Undoing…";
        await this.onUndo(decision);
        this.render();
      };
    }
  }
}
