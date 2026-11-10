import type { Rule } from "../engine";
import { canonicalValue } from "../engine/value-utils";

export interface RuleSemanticChange { readonly section: string; readonly before: unknown; readonly after: unknown }
export function semanticRuleChanges(before: Rule | null, after: Rule): readonly RuleSemanticChange[] {
  const sections = [
    ["conditions", before?.when, after.when],
    ["actions", before?.then, after.then],
    ["execution", before === null ? undefined : execution(before), execution(after)],
    ["fixtures", before?.fixtures ?? [], after.fixtures ?? []],
  ] as const;
  return sections.filter(([, left, right]) => canonicalValue(left) !== canonicalValue(right)).map(([section, left, right]) => ({ section, before: left, after: right }));
}
function execution(rule: Rule): unknown {
  return { enabled: rule.enabled, priority: rule.priority, order: rule.order, stopOnMatch: rule.stopOnMatch ?? false, dryRun: rule.dryRun ?? false, runOn: rule.runOn ?? "always", regexLookbehind: rule.regexLookbehind ?? false };
}
export function formatSemanticChanges(changes: readonly RuleSemanticChange[]): string {
  return changes.map((change) => `${change.section.toUpperCase()}\nBefore: ${JSON.stringify(change.before) ?? "(new rule)"}\nAfter: ${JSON.stringify(change.after)}`).join("\n\n");
}
