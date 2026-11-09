import { normalizePath, type App, type TFile } from "obsidian";
import type { NoteState, PlannedMutation, ReconciliationConverged, RuleId, RuleRunOn } from "../engine";
import { resolveMoveCollision, validateReconciliationResult } from "./adapter";
import { withNoteStatePath } from "./note-state";
import { planFileReconciliation } from "./planner";
import type { VaultFlowSettings } from "./settings";

type PreviewSettings = Pick<VaultFlowSettings, "maxIterations" | "rules" | "collisionPolicy" | "exclusionPatterns" | "disableFrontmatterKey" | "monitoredFolders"> & { readonly useRegexSet?: boolean };

export type DryRunPreviewOutcome = "unchanged" | "changed" | "dry-run" | "skipped" | "cycle-detected" | "max-iterations-exceeded" | "excluded" | "error";

export interface DryRunPreview {
  readonly outcome: DryRunPreviewOutcome;
  readonly path: string;
  readonly desiredPath?: string;
  readonly appliedRuleIds: readonly RuleId[];
  readonly involvedRuleIds: readonly RuleId[];
  readonly dryRunRuleIds?: readonly RuleId[];
  readonly mutationKinds: readonly PlannedMutation["kind"][];
  readonly iterations: number;
  readonly message: string;
}

export interface DryRunPreviewLogEntry {
  readonly title: string;
  readonly details: readonly string[];
}

export interface DryRunPreviewPlan {
  readonly current: NoteState;
  readonly needsBodyContent: boolean;
  readonly preview: DryRunPreview;
  readonly result: ReconciliationConverged | null;
  readonly collisionBasePath?: string;
}

export async function previewReconciliationForFile(
  app: App,
  file: TFile,
  settings: PreviewSettings,
): Promise<DryRunPreview> {
  return (await planReconciliationForFile(app, file, settings)).preview;
}

export async function planReconciliationForFile(
  app: App,
  file: TFile,
  settings: PreviewSettings,
  options: { readonly now?: number; readonly triggerContext?: RuleRunOn | readonly RuleRunOn[] } = {},
): Promise<DryRunPreviewPlan> {
  const plan = await planFileReconciliation(
    app,
    file,
    settings,
    options.triggerContext ?? "manual",
    options.now ?? Date.now(),
  );
  const { current, needsBodyContent } = plan;

  if (plan.status === "excluded") {
    return {
      current,
      needsBodyContent,
      result: null,
      preview: {
        outcome: "excluded",
        path: current.path,
        appliedRuleIds: [],
        involvedRuleIds: [],
        mutationKinds: [],
        iterations: 0,
        message: `${plan.eligibility.message} It is excluded from Vault Flow processing.`,
      },
    };
  }

  if (plan.status === "metadata-unavailable" || plan.status === "content-read-failed") {
    return {
      current,
      needsBodyContent,
      result: null,
      preview: {
        outcome: "error",
        path: current.path,
        appliedRuleIds: [],
        involvedRuleIds: [],
        mutationKinds: [],
        iterations: 0,
        message: plan.status === "content-read-failed"
          ? `Vault Flow could not read the note body: ${plan.message}`
          : plan.message,
      },
    };
  }

  const { result } = plan;

  if (result.status !== "converged") {
    return {
      current,
      needsBodyContent,
      result: null,
      preview: {
        outcome: result.status,
        path: current.path,
        appliedRuleIds: [],
        involvedRuleIds: [...result.involvedRuleIds],
        mutationKinds: [],
        iterations: result.iterations,
        message: result.status === "cycle-detected"
          ? formatCycleMessage(result.involvedRuleIds)
          : `Reconciliation exceeded ${result.iterations} iteration(s). Involved rules: ${formatList(result.involvedRuleIds)}.`,
      },
    };
  }

  const dryRunMatches = result.dryRunMatches ?? [];
  if (!result.changed) {
    if (dryRunMatches.length > 0) {
      const mutationKinds = uniqueMutationKinds(dryRunMatches.flatMap((match) => match.mutations.map((mutation) => mutation.kind)));
      const desiredPaths = [...new Set(dryRunMatches.map((match) => normalizePath(match.desired.path)))];
      return {
        current,
        needsBodyContent,
        result: null,
        preview: {
          outcome: "dry-run",
          path: current.path,
          ...(desiredPaths.length === 1 && desiredPaths[0] !== current.path ? { desiredPath: desiredPaths[0] } : {}),
          appliedRuleIds: [...result.dryRunRuleIds],
          involvedRuleIds: [],
          dryRunRuleIds: [...result.dryRunRuleIds],
          mutationKinds,
          iterations: result.iterations,
          message: "Matching per-rule dry-run actions were planned but cannot be applied.",
        },
      };
    }
    return {
      current,
      needsBodyContent,
      result,
      preview: {
        outcome: "unchanged",
        path: current.path,
        appliedRuleIds: [...result.appliedRuleIds],
        involvedRuleIds: [],
        mutationKinds: [],
        iterations: result.iterations,
        message: "No changes are planned for this note.",
      },
    };
  }

  try {
    validateReconciliationResult(app, file, result);
  } catch (error) {
    return {
      current,
      needsBodyContent,
      result: null,
      preview: {
        outcome: "error",
        path: current.path,
        desiredPath: normalizePath(result.desired.path),
        appliedRuleIds: [...result.appliedRuleIds],
        involvedRuleIds: [],
        ...(result.dryRunRuleIds.length === 0 ? {} : { dryRunRuleIds: [...result.dryRunRuleIds] }),
        mutationKinds: result.mutations.map((mutation) => mutation.kind),
        iterations: result.iterations,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const mutationKinds = result.mutations.map((mutation) => mutation.kind);
  const desiredPath = normalizePath(result.desired.path);
  const pathChanges = mutationKinds.includes("move") || mutationKinds.includes("rename");

  if (pathChanges && normalizePath(current.path) !== desiredPath) {
    const resolution = resolveMoveCollision(app, file, desiredPath, settings.collisionPolicy);
    if (resolution.status === "skipped") {
      return {
        current,
        needsBodyContent,
        result: null,
        preview: {
          outcome: "skipped",
          path: current.path,
          desiredPath: resolution.path,
          appliedRuleIds: [...result.appliedRuleIds],
          involvedRuleIds: [],
          ...(result.dryRunRuleIds.length === 0 ? {} : { dryRunRuleIds: [...result.dryRunRuleIds] }),
          mutationKinds,
          iterations: result.iterations,
          message: resolution.message,
        },
      };
    }

    return {
      current,
      needsBodyContent,
      result: resolution.path === desiredPath ? result : {
        ...result,
        desired: withNoteStatePath(result.desired, resolution.path),
      },
      collisionBasePath: desiredPath,
      preview: {
        outcome: "changed",
        path: current.path,
        desiredPath: resolution.path,
        appliedRuleIds: [...result.appliedRuleIds],
        involvedRuleIds: [],
        ...(result.dryRunRuleIds.length === 0 ? {} : { dryRunRuleIds: [...result.dryRunRuleIds] }),
        mutationKinds,
        iterations: result.iterations,
        message: resolution.collided
          ? `Destination already existed; live run would use available path: ${resolution.path}`
          : "Dry-run preview only; no vault changes were written.",
      },
    };
  }

  return {
    current,
    needsBodyContent,
    result,
    preview: {
      outcome: "changed",
      path: current.path,
      ...(desiredPath === normalizePath(current.path) ? {} : { desiredPath }),
      appliedRuleIds: [...result.appliedRuleIds],
      involvedRuleIds: [],
      ...(result.dryRunRuleIds.length === 0 ? {} : { dryRunRuleIds: [...result.dryRunRuleIds] }),
      mutationKinds,
      iterations: result.iterations,
      message: "Dry-run preview only; no vault changes were written.",
    },
  };
}

export function formatDryRunPreviewLogEntry(preview: DryRunPreview): DryRunPreviewLogEntry {
  const details = [`Current path: ${preview.path}`];

  if (preview.desiredPath !== undefined && preview.desiredPath !== preview.path) {
    details.push(`Desired path: ${preview.desiredPath}`);
  }

  const ruleIds = preview.appliedRuleIds.length > 0 ? preview.appliedRuleIds : preview.involvedRuleIds;
  details.push(`Rule IDs: ${formatList(ruleIds)}`);
  details.push(`Mutations: ${formatList(preview.mutationKinds)}`);
  details.push(`Iterations: ${preview.iterations}`);
  details.push(`Message: ${preview.message}`);

  return {
    title: `Preview outcome: ${preview.outcome}`,
    details,
  };
}

function uniqueMutationKinds(kinds: readonly PlannedMutation["kind"][]): PlannedMutation["kind"][] {
  return [...new Set(kinds)];
}

function formatCycleMessage(involvedRuleIds: readonly RuleId[]): string {
  if (involvedRuleIds.length === 0) {
    return "Cycle detected while previewing note changes.";
  }

  return `Cycle detected among rules: ${involvedRuleIds.join(", ")}`;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}
