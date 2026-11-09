import { RE2JS } from "re2js";

export const MAX_REGEX_PATTERN_LENGTH = 512;
const MAX_CACHED_REGEXES = 64;
const MAX_REGEX_PROGRAM_SIZE = 10_000;
const MAX_ACTIVE_REGEXES = 1024;
const MAX_ACTIVE_INSTRUCTIONS = 100_000;
export interface RuleRegex {
  readonly programSize: number;
  test(text: string): boolean;
  captures(text: string): readonly string[];
}
const patterns = new Map<string, RuleRegex | Error>();
const rulePools = new WeakMap<object, Map<boolean, (pattern: string) => RuleRegex>>();

export function regexCompilerForRules(owner: object, allowLookbehinds = false): (pattern: string) => RuleRegex {
  const pools = rulePools.get(owner) ?? new Map<boolean, (pattern: string) => RuleRegex>();
  const existing = pools.get(allowLookbehinds);
  if (existing !== undefined) return existing;
  const active = new Map<string, RuleRegex>();
  let retainedInstructions = 0;
  const compile = (pattern: string): RuleRegex => {
    const cached = active.get(pattern);
    if (cached !== undefined) return cached;
    const regex = compileRuleRegex(pattern, allowLookbehinds);
    if (active.size < MAX_ACTIVE_REGEXES && retainedInstructions + regex.programSize <= MAX_ACTIVE_INSTRUCTIONS) {
      active.set(pattern, regex); retainedInstructions += regex.programSize;
    }
    return regex;
  };
  pools.set(allowLookbehinds, compile); rulePools.set(owner, pools);
  return compile;
}

export function compileRuleRegex(pattern: string, allowLookbehinds = false): RuleRegex {
  const key = (allowLookbehinds ? "lookbehind:" : "strict:") + pattern;
  const cached = patterns.get(key);
  if (cached !== undefined) {
    patterns.delete(key); patterns.set(key, cached);
    if (cached instanceof Error) throw cached;
    return cached;
  }
  let result: RuleRegex | Error;
  try {
    if (pattern.length === 0 || pattern.length > MAX_REGEX_PATTERN_LENGTH) throw new Error(`Use 1–${MAX_REGEX_PATTERN_LENGTH} characters.`);
    const compiled = RE2JS.compile(RE2JS.translateRegExp(pattern), RE2JS.CASE_INSENSITIVE | (allowLookbehinds ? RE2JS.LOOKBEHINDS : 0));
    if (compiled.programSize() > MAX_REGEX_PROGRAM_SIZE) throw new Error("Pattern expands to too many matching instructions.");
    result = {
      programSize: compiled.programSize(),
      test: (text) => compiled.test(text),
      captures: (text) => {
        const match: readonly unknown[] | null = compiled.exec(text);
        return match === null ? [] : match.slice(1).map((value) => typeof value === "string" ? value : "");
      },
    };
  } catch (error) {
    result = new Error(`Unsupported rule regex. Use RE2-compatible syntax ${allowLookbehinds ? "without lookaheads or backreferences; lookbehinds must be captureless." : "without lookarounds or backreferences."} ${error instanceof Error ? error.message : String(error)}`);
  }
  patterns.set(key, result);
  if (patterns.size > MAX_CACHED_REGEXES) { const oldest = patterns.keys().next().value; if (oldest !== undefined) patterns.delete(oldest); }
  if (result instanceof Error) throw result;
  return result;
}
