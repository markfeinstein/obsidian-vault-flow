import { Modal, type App, type TFile } from "obsidian";
import type { PredicateTrace, RuleEvaluationTrace, RulePredicate, RuleRunOn } from "../engine";
import { planFileReconciliation, type FileReconciliationPlan } from "./planner";
import { summarizePredicate } from "./rule-editor-model";
import { renderFrontmatterDiff } from "./frontmatter-diff";
import { ruleConvergenceWarnings } from "./rule-warnings";
import type { VaultFlowSettings } from "./settings";

const TRACE_LIMIT = 200;

/** A fresh, read-only evaluation through the same planner/engine as automation. */
export class RuleDebuggerModal extends Modal {
  private generation = 0;

  public constructor(app: App, private readonly file: TFile, private readonly settings: VaultFlowSettings) { super(app); }

  override onOpen(): void {
    this.setTitle("Vault Flow — explain current note");
    void this.refresh("manual");
  }

  override onClose(): void { this.generation += 1; this.contentEl.empty(); }

  private async refresh(context: RuleRunOn): Promise<void> {
    const generation = ++this.generation;
    const now = Date.now();
    this.contentEl.empty();
    const actions = this.contentEl.createDiv({ cls: "vf-modal-actions" });
    for (const trigger of ["manual", "live", "sweep"] as const) {
      const button = actions.createEl("button", { text: `Evaluate ${trigger}`, attr: { "aria-pressed": String(trigger === context) } });
      button.onclick = () => { void this.refresh(trigger); };
    }
    const output = this.contentEl.createDiv();
    output.createEl("p", { text: "Evaluating current note without writing…", attr: { role: "status" } });
    const traces: RuleEvaluationTrace[] = [];
    let traceCount = 0;
    try {
      const plan = await planFileReconciliation(this.app, this.file, this.settings, context, now, {
        onRuleEvaluated: (trace) => { traceCount += 1; if (traces.length < TRACE_LIMIT) traces.push(trace); },
      });
      if (generation !== this.generation) return;
      output.empty();
      this.renderPlan(output, plan, traces, traceCount, context, now);
    } catch (error) {
      if (generation !== this.generation) return;
      output.empty();
      output.createEl("p", { text: `Could not evaluate this note: ${error instanceof Error ? error.message : String(error)}`, attr: { role: "alert" } });
    }
  }

  private renderPlan(output: HTMLElement, plan: FileReconciliationPlan, traces: readonly RuleEvaluationTrace[], total: number, context: RuleRunOn, now: number): void {
    output.createEl("p", { text: `${plan.current.path} — ${context} snapshot at ${new Date(now).toLocaleString()}. No writes; this evaluates rules, not write permissions, collision resolution, or unsaved editor text.` });
    if (plan.status !== "ready") {
      output.createEl("p", { text: plan.status === "excluded" ? plan.eligibility.message : plan.message, attr: { role: "status" } });
      return;
    }
    output.createEl("p", { text: `Result: ${plan.result.status}; ${plan.result.iterations} pass(es).${plan.result.status === "converged" ? (plan.result.changed ? " Changes planned." : " No live changes planned.") : " No changes would be applied."}` });
    const reached = new Set(traces.map((trace) => trace.ruleId));
    for (const rule of this.settings.rules) {
      if (!reached.has(rule.id)) {
        const reason = !rule.enabled ? "disabled" : rule.runOn !== undefined && rule.runOn !== "always" && rule.runOn !== context
          ? `different trigger (${rule.runOn})` : "not reached before stopOnMatch or trace display limit";
        output.createEl("p", { text: `${rule.name}: not evaluated — ${reason}.` });
      }
      for (const warning of ruleConvergenceWarnings(rule)) output.createEl("p", { text: `${rule.name}: ${warning}`, cls: "vf-muted" });
    }
    if (total > traces.length) output.createEl("p", { text: `Showing ${traces.length} of ${total} rule evaluations. Narrow the rules or trigger to inspect the rest.` });
    for (const trace of traces) {
      const details = output.createEl("details");
      details.createEl("summary", { text: `Pass ${trace.iteration} — ${trace.ruleName}: ${trace.outcome}` });
      let rendered = false;
      details.addEventListener("toggle", () => {
        if (!details.open || rendered) return;
        rendered = true;
        details.createEl("p", { text: `Path: ${trace.before.path} → ${trace.after.path}` });
        details.createEl("p", { text: `Exported captures from matching branches: basename ${JSON.stringify(trace.predicate.captures)}, body ${JSON.stringify(trace.predicate.contentCaptures)}` });
        for (const message of trace.messages) details.createEl("p", { text: message });
        this.renderPredicate(details.createEl("ul"), trace.predicate.predicate, trace.predicate, { remaining: 250 });
        renderFrontmatterDiff(details, trace.before, trace.after);
      });
    }
  }

  private renderPredicate(parent: HTMLElement, predicate: RulePredicate, trace: PredicateTrace | undefined, budget: { remaining: number }): void {
    if (budget.remaining-- <= 0) return;
    const row = parent.createEl("li");
    const label = predicate.type === "all" || predicate.type === "any" || predicate.type === "not" ? predicate.type : summarizePredicate(predicate);
    row.createSpan({ text: `${trace === undefined ? "NOT EVALUATED (short-circuited)" : trace.matched ? "TRUE" : "FALSE"}: ${label.slice(0, 1000)}` });
    const children = predicate.type === "all" || predicate.type === "any" ? predicate.predicates : predicate.type === "not" ? [predicate.predicate] : [];
    if (children.length > 0) {
      const list = row.createEl("ul");
      for (const [index, child] of children.entries()) {
        if (budget.remaining <= 0) { list.createEl("li", { text: "Predicate display truncated." }); break; }
        this.renderPredicate(list, child, trace?.children?.[index], budget);
      }
    }
  }
}
