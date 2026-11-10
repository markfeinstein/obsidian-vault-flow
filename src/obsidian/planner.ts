import { getFrontMatterInfo, moment, type App, type TFile } from "obsidian";
import { predicateNeedsBodyContent, reconcileFileState, type NoteState, type ReconciliationResult, type ReconciliationOptions, type Rule, type RuleRunOn } from "../engine";
import { noteStateFromObsidian } from "./adapter";
import { evaluateFileEligibility, type FileEligibility, type FileEligibilitySettings } from "./eligibility";

export interface FilePlanningSettings extends FileEligibilitySettings {
  readonly maxIterations: number;
  readonly useRegexSet?: boolean;
  readonly rules: readonly Rule[];
}

export type FileReconciliationPlan =
  | {
    readonly status: "ready";
    readonly current: NoteState;
    readonly result: ReconciliationResult;
    readonly needsBodyContent: boolean;
  }
  | {
    readonly status: "excluded";
    readonly current: NoteState;
    readonly eligibility: Exclude<FileEligibility, { readonly eligible: true }>;
    readonly needsBodyContent: boolean;
  }
  | {
    readonly status: "metadata-unavailable";
    readonly current: NoteState;
    readonly message: string;
    readonly needsBodyContent: boolean;
  }
  | {
    readonly status: "content-read-failed";
    readonly current: NoteState;
    readonly message: string;
    readonly needsBodyContent: true;
  };

export async function planFileReconciliation(
  app: App,
  file: TFile,
  settings: FilePlanningSettings,
  triggerContext: RuleRunOn | readonly RuleRunOn[],
  now: number,
  diagnostics: { readonly onRuleEvaluated?: ReconciliationOptions["onRuleEvaluated"] } = {},
): Promise<FileReconciliationPlan> {
  const cache = app.metadataCache.getFileCache(file);
  const runnable = runnableRules(settings.rules, triggerContext);
  let needsBodyContent = runnable.some((rule) => predicateNeedsBodyContent(rule.when));
  const currentWithoutBody = noteStateFromObsidian(file, cache);
  const eligibility = evaluateFileEligibility(file, cache, settings);

  if (!eligibility.eligible) {
    if (eligibility.reason === "metadata-unavailable") {
      return {
        status: "metadata-unavailable",
        current: currentWithoutBody,
        message: eligibility.message,
        needsBodyContent,
      };
    }
    return {
      status: "excluded",
      current: currentWithoutBody,
      eligibility,
      needsBodyContent,
    };
  }

  const evaluate = (current: NoteState, probe = false): ReconciliationResult => reconcileFileState({
    file: current, rules: runnable, options: {
      maxIterations: settings.maxIterations, useRegexSet: settings.useRegexSet, now, triggerContext,
      formatDate: (timestamp, format) => moment(timestamp).format(format),
      ...(probe ? {} : diagnostics),
      onMissingBodyContent: (): never => { throw BODY_REQUIRED; },
    },
  });
  if (needsBodyContent) {
    try {
      const result = evaluate(currentWithoutBody, true);
      needsBodyContent = false;
      return { status: "ready", current: currentWithoutBody, needsBodyContent, result: diagnostics.onRuleEvaluated === undefined ? result : evaluate(currentWithoutBody) };
    } catch (error) {
      if (error !== BODY_REQUIRED) throw error;
    }
  }
  let bodyContent: string | undefined;
  if (needsBodyContent) {
    try {
      const completeContent = await app.vault.cachedRead(file);
      bodyContent = markdownBodyContent(completeContent);
    } catch (error) {
      return {
        status: "content-read-failed",
        current: currentWithoutBody,
        message: formatError(error),
        needsBodyContent: true,
      };
    }
  }

  const current = noteStateFromObsidian(file, cache, { bodyContent });
  return {
    status: "ready",
    current,
    needsBodyContent,
    result: evaluate(current),
  };
}

const BODY_REQUIRED = new Error("Body input required for planning");
const runnableCache = new WeakMap<readonly Rule[], Map<string, readonly Rule[]>>();

export function runnableRules(rules: readonly Rule[], triggerContext: RuleRunOn | readonly RuleRunOn[]): readonly Rule[] {
  const contexts = Array.isArray(triggerContext) ? triggerContext : [triggerContext];
  const key = [...new Set(contexts)].sort().join(",");
  const cached = runnableCache.get(rules)?.get(key);
  if (cached !== undefined) return cached;
  const selected = rules.filter((rule) => {
    if (!rule.enabled) {
      return false;
    }
    const runOn = rule.runOn ?? "always";
    return runOn === "always" || contexts.includes(runOn);
  });
  const entries = runnableCache.get(rules) ?? new Map<string, readonly Rule[]>();
  entries.set(key, selected);
  runnableCache.set(rules, entries);
  return selected;
}

export function markdownBodyContent(content: string): string {
  const frontmatterInfo = getFrontMatterInfo(content);
  return frontmatterInfo.exists ? content.slice(frontmatterInfo.contentStart) : content;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
