import { Modal, type App } from "obsidian";
import {
  DIAGNOSTIC_LOG_OUTCOME_FILTERS,
  formatDiagnosticLogOutcomeFilterLabel,
  formatRecentDecisionLogEntries,
  isDiagnosticLogOutcomeFilter,
  type DiagnosticLogOutcomeFilter,
  type ReconciliationDecision,
} from "./diagnostics";

const DEFAULT_VISIBLE_DECISION_LIMIT = 50;

export class DiagnosticLogModal extends Modal {
  private selectedOutcomeFilter: DiagnosticLogOutcomeFilter = "all";

  public constructor(
    app: App,
    private readonly decisions: readonly ReconciliationDecision[],
    private readonly visibleDecisionLimit: number = DEFAULT_VISIBLE_DECISION_LIMIT,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Vault Flow diagnostic log");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();

    if (this.decisions.length === 0) {
      this.contentEl.createEl("p", { text: "Vault Flow has no recent diagnostic decisions yet." });
      return;
    }

    this.renderOutcomeFilter();

    const entries = formatRecentDecisionLogEntries(
      this.decisions,
      this.visibleDecisionLimit,
      this.selectedOutcomeFilter,
    );

    if (entries.length === 0) {
      this.contentEl.createEl("p", { text: "No diagnostic decisions match the selected outcome." });
      return;
    }

    this.contentEl.createEl("p", {
      text: `Showing ${entries.length} most recent ${formatDiagnosticLogOutcomeFilterLabel(this.selectedOutcomeFilter)} decision(s).`,
    });

    const list = this.contentEl.createDiv({ cls: "vf-diagnostic-log" });
    for (const entry of entries) {
      const item = list.createDiv({ cls: "vf-diagnostic-log-entry" });
      item.createEl("strong", { text: entry.title });
      for (const detail of entry.details) {
        item.createDiv({ text: detail, cls: "vf-diagnostic-log-entry-detail" });
      }
    }
  }

  private renderOutcomeFilter(): void {
    const filterContainer = this.contentEl.createDiv({ cls: "vf-diagnostic-log-filter" });
    const label = filterContainer.createEl("label", { text: "Outcome: " });
    const select = label.createEl("select");

    for (const outcomeFilter of DIAGNOSTIC_LOG_OUTCOME_FILTERS) {
      const option = select.createEl("option", {
        text: formatDiagnosticLogOutcomeFilterLabel(outcomeFilter),
      });
      option.value = outcomeFilter;
      option.selected = outcomeFilter === this.selectedOutcomeFilter;
    }

    select.addEventListener("change", () => {
      this.selectedOutcomeFilter = isDiagnosticLogOutcomeFilter(select.value) ? select.value : "all";
      this.render();
    });
  }
}
