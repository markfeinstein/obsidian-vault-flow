import { RE2JS } from "re2js";

export const MAX_GLOB_PATTERN_LENGTH = 1_024;
const MAX_CACHED_GLOBS = 512;
export interface PathGlobMatcher {
  test(path: string): boolean;
}
const patterns = new Map<string, PathGlobMatcher>();

/** Compile the shared *, **, and ? dialect with linear-time matching.
 * Keep flags in cache identities for callers with different Unicode semantics.
 * No user-controlled expression is passed to JavaScript's backtracking engine.
 */
export function compilePathGlob(glob: string, flags: "i" | "iu" = "i"): PathGlobMatcher {
  if (glob.length > MAX_GLOB_PATTERN_LENGTH) {
    throw new Error(`Path globs must contain at most ${MAX_GLOB_PATTERN_LENGTH} characters.`);
  }
  const key = `${flags}\u0000${glob}`;
  const cached = patterns.get(key);
  if (cached !== undefined) {
    patterns.delete(key);
    patterns.set(key, cached);
    return cached;
  }

  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
    }
  }
  const compiled = RE2JS.compile(`^${source}$`, RE2JS.CASE_INSENSITIVE);
  const matcher: PathGlobMatcher = { test: (path) => compiled.test(path) };
  patterns.set(key, matcher);
  if (patterns.size > MAX_CACHED_GLOBS) {
    const oldest = patterns.keys().next().value;
    if (oldest !== undefined) patterns.delete(oldest);
  }
  return matcher;
}
