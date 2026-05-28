import type { Rule } from "../engine";

/** Heuristics, not rejection or a claim that a guarded rule cannot converge. */
export function ruleConvergenceWarnings(rule: Rule): readonly string[] {
  const warnings: string[] = [];
  if (Object.keys(rule.then.appendToProperty ?? {}).length > 0) {
    if (rule.stopOnMatch !== true) warnings.push("String appends may repeat on every reconciliation pass if the condition remains true. Add a condition that becomes false after the append, or intentionally use stopOnMatch for a single pass.");
    if ((rule.runOn ?? "always") === "always" || rule.runOn === "live") warnings.push("Automatic appends can trigger another live run after their own write, even with stopOnMatch. Guard the changed property or make the rule manual-only.");
  }
  const rename = rule.then.renameTo;
  if (rename !== undefined && usesTemplateKey(rename, "basename") && rename.trim() !== "{basename}") {
    warnings.push("This rename transforms {basename} and may repeatedly prefix/suffix the name. Ensure the condition stops matching after the first rename; stopOnMatch alone does not prevent later automatic runs.");
  }
  const move = rule.then.moveTo;
  if (move !== undefined && (usesTemplateKey(move, "folder") || usesTemplateKey(move, "path"))) {
    warnings.push("This destination depends on the current folder/path and may keep nesting or moving the note. Use a stable destination or a condition that excludes the result.");
  }
  return warnings;
}

function usesTemplateKey(template: string, key: string): boolean {
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== "{") continue;
    if (template[index + 1] === "{") { index += 1; continue; }
    const closing = template.indexOf("}", index + 1);
    if (closing === -1) return false;
    if (template.slice(index + 1, closing).trim() === key) return true;
    index = closing;
  }
  return false;
}
