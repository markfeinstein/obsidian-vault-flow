import { RE2JS } from "re2js";

export const MAX_REGEX_PATTERN_LENGTH = 512;
const MAX_CACHED_REGEXES = 64;
const MAX_REGEX_PROGRAM_SIZE = 10_000;

export interface RuleRegex {
  test(text: string): boolean;
  captures(text: string): readonly string[];
}

// Shared by validation, matching, and capture extraction. Cache failures as well
// as successes, and evict old patterns so editing/importing cannot grow it forever.
const patterns = new Map<string, RuleRegex | Error>();
const rulePools = new WeakMap<object, (pattern: string) => RuleRegex>();

/** Active immutable rule sets retain their own patterns; unrelated sets remain collectible. */
export function regexCompilerForRules(owner: object): (pattern: string) => RuleRegex {
  const existing = rulePools.get(owner);
  if (existing !== undefined) return existing;
  const active = new Map<string, RuleRegex>();
  const compile = (pattern: string): RuleRegex => {
    const cached = active.get(pattern);
    if (cached !== undefined) return cached;
    const regex = compileRuleRegex(pattern);
    active.set(pattern, regex);
    return regex;
  };
  rulePools.set(owner, compile);
  return compile;
}

export function compileRuleRegex(pattern: string): RuleRegex {
  const cached = patterns.get(pattern);
  if (cached !== undefined) {
    patterns.delete(pattern);
    patterns.set(pattern, cached);
    if (cached instanceof Error) throw cached;
    return cached;
  }

  let result: RuleRegex | Error;
  try {
    if (pattern.length === 0 || pattern.length > MAX_REGEX_PATTERN_LENGTH) {
      throw new Error(`Use 1–${MAX_REGEX_PATTERN_LENGTH} characters.`);
    }
    const compiled = RE2JS.compile(RE2JS.translateRegExp(pattern), RE2JS.CASE_INSENSITIVE);
    if (compiled.programSize() > MAX_REGEX_PROGRAM_SIZE) {
      throw new Error("Pattern expands to too many matching instructions.");
    }
    result = {
      test: (text) => compiled.test(text),
      captures: (text) => {
        const match: readonly unknown[] | null = compiled.exec(text);
        return match === null ? [] : match.slice(1).map((value) => typeof value === "string" ? value : "");
      },
    };
  } catch (error) {
    result = new Error(`Unsupported rule regex. Use RE2-compatible syntax without lookarounds or backreferences. ${error instanceof Error ? error.message : String(error)}`);
  }
  patterns.set(pattern, result);
  if (patterns.size > MAX_CACHED_REGEXES) {
    const oldest = patterns.keys().next().value;
    if (oldest !== undefined) patterns.delete(oldest);
  }
  if (result instanceof Error) throw result;
  return result;
}
