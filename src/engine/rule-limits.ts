export const MAX_RULE_COUNT = 1_000;
export const MAX_RULE_INPUT_DEPTH = 64;
export const MAX_RULE_INPUT_NODES = 8_192;
export const MAX_RULESET_INPUT_NODES = 65_536;

interface Visit {
  readonly value: unknown;
  readonly depth: number;
  readonly exit?: boolean;
}

/** Bound the complete input, including unknown fields, before any recursive
 * validator, clone, formatter, fixture, or matcher sees it. Shared subtrees are
 * allowed; ancestor cycles are not. This walk itself never uses recursion.
 */
export function ruleInputLimitError(value: unknown): string | null {
  if (!Array.isArray(value)) return null; // Shape validation belongs to the caller.
  if (value.length > MAX_RULE_COUNT) return `Use at most ${MAX_RULE_COUNT} rules.`;
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const pending: Visit[] = [{ value: value[index], depth: 1 }];
    const ancestors = new Set<object>();
    let nodes = 0;
    let pendingValues = 1;
    while (pending.length > 0) {
      const visit = pending.pop();
      if (visit === undefined) break;
      const item = visit.value;
      if (visit.exit) {
        if (typeof item === "object" && item !== null) ancestors.delete(item);
        continue;
      }
      pendingValues -= 1;
      nodes += 1;
      total += 1;
      if (nodes > MAX_RULE_INPUT_NODES) return `Rule ${index + 1} exceeds ${MAX_RULE_INPUT_NODES} input nodes.`;
      if (total > MAX_RULESET_INPUT_NODES) return `The ruleset exceeds ${MAX_RULESET_INPUT_NODES} input nodes.`;
      if (typeof item !== "object" || item === null) continue;
      if (visit.depth > MAX_RULE_INPUT_DEPTH) return `Rule ${index + 1} exceeds the maximum nesting depth of ${MAX_RULE_INPUT_DEPTH}.`;
      if (ancestors.has(item)) return `Rule ${index + 1} contains a circular reference.`;
      const children: unknown[] = Array.isArray(item) ? item : [];
      if (!Array.isArray(item)) {
        for (const key in item) {
          if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
          children.push((item as Record<string, unknown>)[key]);
          if (children.length + nodes + pendingValues > MAX_RULE_INPUT_NODES) return `Rule ${index + 1} exceeds ${MAX_RULE_INPUT_NODES} input nodes.`;
          if (children.length + total + pendingValues > MAX_RULESET_INPUT_NODES) return `The ruleset exceeds ${MAX_RULESET_INPUT_NODES} input nodes.`;
        }
      }
      // Count queued children as well as visited values, so a deep, broad input
      // cannot allocate a frontier many times larger than its node budget.
      if (children.length + nodes + pendingValues > MAX_RULE_INPUT_NODES) return `Rule ${index + 1} exceeds ${MAX_RULE_INPUT_NODES} input nodes.`;
      if (children.length + total + pendingValues > MAX_RULESET_INPUT_NODES) return `The ruleset exceeds ${MAX_RULESET_INPUT_NODES} input nodes.`;
      pendingValues += children.length;
      ancestors.add(item);
      pending.push({ value: item, depth: visit.depth, exit: true });
      for (let child = children.length - 1; child >= 0; child -= 1) pending.push({ value: children[child], depth: visit.depth + 1 });
    }
  }
  return null;
}
