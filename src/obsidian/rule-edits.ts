import type { Rule } from "../engine";
import type { RuleEditResult } from "./rule-editor-model";
import { canonicalValue } from "../engine/value-utils";

/** Optimistic, rule-level merge. A stale editor must never replace the full settings snapshot. */
export function mergeRuleEdit(current: readonly Rule[], baseline: readonly Rule[], proposed: readonly Rule[]): RuleEditResult {
  const before = new Map(baseline.map((rule) => [rule.id, rule]));
  const after = new Map(proposed.map((rule) => [rule.id, rule]));
  const latest = new Map(current.map((rule) => [rule.id, rule]));
  const changed = new Set([...before.keys(), ...after.keys()].filter((id) =>
    canonicalValue(before.get(id)) !== canonicalValue(after.get(id))));
  for (const id of changed) {
    if (canonicalValue(latest.get(id)) !== canonicalValue(before.get(id))) {
      return { status: "error", error: "This rule changed or was deleted while its editor was open. Reopen it before saving; newer settings were preserved." };
    }
  }
  const rules = current.flatMap((rule) => changed.has(rule.id) ? (after.has(rule.id) ? [after.get(rule.id)!] : []) : [rule]);
  for (const rule of proposed) if (changed.has(rule.id) && !before.has(rule.id)) rules.push(rule);
  return { status: "ok", rules };
}
