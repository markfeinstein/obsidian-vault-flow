import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { Rule } from "../engine";
import {
  DIAGNOSTIC_LOG_OUTCOME_FILTERS,
  formatDiagnosticLogOutcomeFilterLabel,
  formatRecentDecisionLogEntries,
  isDiagnosticLogOutcomeFilter,
  type DiagnosticLogOutcomeFilter,
  type ReconciliationDecision,
} from "./diagnostics";

export const VAULT_FLOW_DIAGNOSTICS_VIEW_TYPE = "vault-flow-diagnostics";

const DEFAULT_VISIBLE_DECISION_LIMIT = 50;

type DiagnosticsTab = "log" | "stats";

export class VaultFlowDiagnosticsView extends ItemView {
  private selectedOutcomeFilter: DiagnosticLogOutcomeFilter = "all";
  private activeTab: DiagnosticsTab = "log";

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly decisionsProvider: () => readonly ReconciliationDecision[],
    private readonly rulesProvider?: () => readonly Rule[],
    private readonly visibleDecisionLimit: number = DEFAULT_VISIBLE_DECISION_LIMIT,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VAULT_FLOW_DIAGNOSTICS_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Vault Flow diagnostics";
  }

  override getIcon(): string {
    return "list-checks";
  }

  public refresh(): void {
    this.render();
  }

  protected override async onOpen(): Promise<void> {
    this.render();
  }

  protected override async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();

    this.contentEl.createEl("h2", { text: "Vault Flow diagnostics" });

    // Tab bar
    const tabBar = this.contentEl.createDiv({ cls: "vf-diag-tabs" });

    const logTabBtn = tabBar.createEl("button", { text: "Decision log" });
    const statsTabBtn = tabBar.createEl("button", { text: "Rule stats" });

    const setActiveTab = (tab: DiagnosticsTab): void => {
      this.activeTab = tab;
      logTabBtn.toggleClass("is-active", tab === "log");
      statsTabBtn.toggleClass("is-active", tab === "stats");
    };

    logTabBtn.addEventListener("click", () => {
      setActiveTab("log");
      this.render();
    });

    statsTabBtn.addEventListener("click", () => {
      setActiveTab("stats");
      this.render();
    });

    setActiveTab(this.activeTab);

    if (this.activeTab === "log") {
      this.renderLogTab();
    } else {
      this.renderStatsTab();
    }
  }

  private renderLogTab(): void {
    const decisions = this.decisionsProvider();

    if (decisions.length === 0) {
      this.contentEl.createEl("p", { text: "Vault Flow has no recent diagnostic decisions yet." });
      return;
    }

    this.renderOutcomeFilter();

    const entries = formatRecentDecisionLogEntries(
      decisions,
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

  private renderStatsTab(): void {
    const decisions = this.decisionsProvider();
    const rules = this.rulesProvider?.() ?? [];

    if (decisions.length === 0) {
      this.contentEl.createEl("p", { text: "No diagnostic decisions yet. Stats will appear after Vault Flow processes some notes." });
      return;
    }

    // Aggregate counts
    const totals = {
      changed: 0,
      unchanged: 0,
      "dry-run": 0,
      skipped: 0,
      "cycle-detected": 0,
      "max-iterations-exceeded": 0,
      error: 0,
      undone: 0,
    };
    const ruleFireCount = new Map<string, number>();
    const ruleChangeCount = new Map<string, number>();

    for (const decision of decisions) {
      if (decision.outcome in totals) {
        (totals as Record<string, number>)[decision.outcome]++;
      }

      for (const ruleId of decision.appliedRuleIds) {
        ruleFireCount.set(ruleId, (ruleFireCount.get(ruleId) ?? 0) + 1);
        if (decision.outcome === "changed" || decision.outcome === "dry-run") {
          ruleChangeCount.set(ruleId, (ruleChangeCount.get(ruleId) ?? 0) + 1);
        }
      }
    }

    // Summary
    this.contentEl.createEl("h3", { text: "Outcome summary" });
    const summaryTable = this.contentEl.createEl("table", { cls: "vf-diag-table" });

    const headerRow = summaryTable.createEl("tr");
    for (const col of ["Outcome", "Count"]) {
      headerRow.createEl("th", { text: col, cls: "vf-diag-table-header" });
    }

    for (const [outcome, count] of Object.entries(totals)) {
      if (count === 0) continue;
      const row = summaryTable.createEl("tr");
      row.createEl("td", { text: outcome, cls: "vf-diag-table-cell" });
      row.createEl("td", { text: String(count), cls: "vf-diag-table-cell" });
    }

    this.contentEl.createEl("p", {
      text: `Total decisions recorded: ${decisions.length}`,
      cls: "vf-muted",
    });

    // Per-rule stats
    this.contentEl.createEl("h3", { text: "Rule activity" });

    if (ruleFireCount.size === 0) {
      this.contentEl.createEl("p", { text: "No rules have fired yet." });
      return;
    }

    // Build a lookup from ruleId → rule name
    const ruleNameById = new Map<string, string>(rules.map((r) => [r.id, r.name]));

    // Sort by fire count descending
    const sortedRuleIds = [...ruleFireCount.entries()].sort((a, b) => b[1] - a[1]);

    const ruleTable = this.contentEl.createEl("table", { cls: "vf-diag-table" });

    const ruleHeaderRow = ruleTable.createEl("tr");
    for (const col of ["Rule", "Times fired", "Times changed"]) {
      ruleHeaderRow.createEl("th", { text: col, cls: "vf-diag-table-header" });
    }

    for (const [ruleId, fireCount] of sortedRuleIds) {
      const ruleName = ruleNameById.get(ruleId) ?? ruleId;
      const changeCount = ruleChangeCount.get(ruleId) ?? 0;
      const row = ruleTable.createEl("tr");
      const nameCell = row.createEl("td", { text: ruleName, cls: "vf-diag-table-cell" });
      if (!ruleNameById.has(ruleId)) {
        nameCell.addClass("vf-muted");
        nameCell.title = `Rule ID: ${ruleId} (no longer configured)`;
      }
      row.createEl("td", { text: String(fireCount), cls: "vf-diag-table-cell" });
      row.createEl("td", { text: String(changeCount), cls: "vf-diag-table-cell" });
    }

    // Rules that have never fired
    const neverFiredRules = rules.filter((r) => !ruleFireCount.has(r.id));
    if (neverFiredRules.length > 0) {
      this.contentEl.createEl("h4", { text: "Rules that have never fired" });
      const neverList = this.contentEl.createEl("ul", { cls: "vf-muted vf-small-text" });
      for (const rule of neverFiredRules) {
        neverList.createEl("li", { text: rule.enabled ? rule.name : `${rule.name} (disabled)` });
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
