import { RE2JS, RE2Set } from "re2js";
import type { Rule, RulePredicate } from "./types";
import { regexCompilerForRules } from "./rule-regex";

interface Group { readonly allowLookbehinds: boolean; readonly set: RE2Set; readonly ids: ReadonlyMap<string, number> }
const pools = new WeakMap<readonly Rule[], readonly Group[] | null>();
const key = (pattern: string, lookbehind: boolean): string => (lookbehind ? "L:" : "S:") + pattern;

/** Only immutable body inputs are batched. Paths/frontmatter are always evaluated sequentially. */
export function lazyBodyRegexMatcher(rules: readonly Rule[], body: string): (pattern: string, lookbehind: boolean) => boolean | undefined {
  let matches: Map<string, boolean> | null | undefined;
  return (pattern, lookbehind) => {
    if (matches === undefined) {
      matches = null;
      const groups = prepare(rules);
      if (groups !== null) {
        const results = new Map<string, boolean>();
        try {
          for (const group of groups) {
            const ids = new Set(group.set.match(body));
            for (const [candidate, id] of group.ids) results.set(key(candidate, group.allowLookbehinds), ids.has(id));
          }
          matches = results;
        } catch { /* A bounded set failure falls back to individual matching. */ }
      }
    }
    return matches?.get(key(pattern, lookbehind));
  };
}
function prepare(rules: readonly Rule[]): readonly Group[] | null {
  const cached = pools.get(rules);
  if (cached !== undefined) return cached;
  const patterns = [new Set<string>(), new Set<string>()];
  const collect = (predicate: RulePredicate, lookbehind: boolean): void => {
    if (predicate.type === "contentRegex") patterns[lookbehind ? 1 : 0]?.add(predicate.pattern);
    else if (predicate.type === "not") collect(predicate.predicate, lookbehind);
    else if (predicate.type === "all" || predicate.type === "any") for (const child of predicate.predicates) collect(child, lookbehind);
  };
  for (const rule of rules) if (rule.enabled) collect(rule.when, rule.regexLookbehind === true);
  const count = patterns.reduce((sum, group) => sum + group.size, 0);
  if (count < 2 || count > 128) { pools.set(rules, null); return null; }
  try {
    const groups: Group[] = []; let instructions = 0;
    for (const [index, group] of patterns.entries()) {
      if (group.size === 0) continue;
      const allowLookbehinds = index === 1;
      const compile = regexCompilerForRules(rules, allowLookbehinds);
      const set = new RE2Set(RE2Set.UNANCHORED, RE2JS.CASE_INSENSITIVE | (allowLookbehinds ? RE2JS.LOOKBEHINDS : 0), 4 * 1024 * 1024);
      const ids = new Map<string, number>();
      for (const pattern of group) {
        instructions += compile(pattern).programSize;
        if (instructions > 20_000) throw new Error("Combined regex set exceeds its instruction budget.");
        ids.set(pattern, set.add(RE2JS.translateRegExp(pattern)));
      }
      set.compile(); groups.push({ allowLookbehinds, set, ids });
    }
    pools.set(rules, groups); return groups;
  } catch { pools.set(rules, null); return null; }
}
