import { normalizePath, type CliData } from "obsidian";
import type { RuleRunOn } from "../engine";
import { cliError, parseCliTrigger } from "./cli";
import { mapWithConcurrency } from "./concurrency";

export const MAX_CLI_PLAN_PATHS = 200;
export type CliPathsRequest = { readonly paths: readonly string[]; readonly trigger: RuleRunOn } | { readonly error: string };
export function parseCliPaths(params: CliData): CliPathsRequest {
  const limit = params.limit === undefined ? 100 : /^\d+$/u.test(params.limit) ? Number(params.limit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLI_PLAN_PATHS) return { error: "limit must be an integer from 1 to 200." };
  const trigger = parseCliTrigger(params.trigger);
  if (trigger === null) return { error: "trigger must be manual, live, or sweep." };
  if (typeof params.paths !== "string" || new TextEncoder().encode(params.paths).byteLength > 65_536) return { error: "paths must be a JSON string array or newline-separated exact paths, at most 64 KiB." };
  let parsed: unknown;
  try { parsed = params.paths.trim().startsWith("[") ? JSON.parse(params.paths) : params.paths.split(/\r?\n/u).filter((path) => path.trim().length > 0); }
  catch { return { error: "paths contains invalid JSON." }; }
  if (!Array.isArray(parsed) || parsed.some((path: unknown) => typeof path !== "string" || !path.trim() || path.length > 2048 || path.startsWith("/") || path.includes("\\") || /[*?]/u.test(path) || path.includes("\u0000") || path.split("/").some((part) => part === ".." || part === "."))) return { error: "Use exact relative vault paths without traversal or wildcards." };
  const paths = [...new Set((parsed as string[]).map((path) => normalizePath(path)))];
  if (paths.length === 0 || paths.length > limit) return { error: `Provide 1–${limit} distinct paths, or explicitly raise limit (maximum 200).` };
  return { paths, trigger };
}

/** Only summaries survive each mapper invocation; no note bodies are retained. */
export async function planCliPaths(
  params: CliData,
  plan: (path: string, trigger: RuleRunOn) => Promise<unknown>,
  options: { readonly timeoutMs?: number; readonly stillValid?: () => boolean; readonly settingsRevision?: number } = {},
): Promise<string> {
  const request = parseCliPaths(params);
  if ("error" in request) return cliError(request.error);
  const timeoutMs = Math.max(1, Math.min(30_000, options.timeoutMs ?? 10_000));
  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  let timer: number | undefined;
  const work = mapWithConcurrency(request.paths, 4, async (path) => {
    try { return await plan(path, request.trigger); }
    catch (error) { return { status: "error", path, message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) }; }
  }, { isCancelled: () => cancelled || Date.now() >= deadline || options.stillValid?.() === false });
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => { cancelled = true; resolve(null); }, timeoutMs);
  });
  try {
    const plans = await Promise.race([work, timeout]);
    if (plans === null || Date.now() >= deadline) return cliError("Read-only planning exceeded its deadline. No further paths will be started; an in-flight Obsidian read or synchronous evaluation cannot be aborted.");
    if (options.stillValid?.() === false) return cliError("Plugin or settings changed during planning. Run the read-only request again.");
    const output = JSON.stringify({ status: "ok", readOnly: true, settingsRevision: options.settingsRevision, count: plans.length, trigger: request.trigger, plans }, null, 2);
    return new TextEncoder().encode(output).byteLength <= 1_048_576 ? output : cliError("Plan summaries exceed 1 MiB. Request fewer paths.");
  } finally { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); }
}
