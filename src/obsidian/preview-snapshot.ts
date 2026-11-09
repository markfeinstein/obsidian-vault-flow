import type { NoteState } from "../engine";
import type { DryRunPreviewPlan } from "./dry-run-preview";

export async function bodyFingerprint(body: string): Promise<string> {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withoutBody(state: NoteState, fingerprint?: string): NoteState {
  const { bodyContent: _body, ...rest } = state;
  return { ...rest, ...(fingerprint === undefined ? {} : { bodyFingerprint: fingerprint }) };
}

/** Release note text before retaining large preview/cache result sets. Never weaken a writable baseline. */
export async function compactPreviewPlan(plan: DryRunPreviewPlan): Promise<DryRunPreviewPlan> {
  if (plan.current.bodyContent === undefined) return plan;
  let fingerprint: string | undefined;
  if (plan.preview.outcome === "changed") {
    try { fingerprint = await bodyFingerprint(plan.current.bodyContent); }
    catch { return plan; } // Preserve the full baseline if crypto is unavailable.
  }
  return {
    ...plan,
    current: withoutBody(plan.current, fingerprint),
    result: plan.result === null ? null : {
      ...plan.result, desired: withoutBody(plan.result.desired, fingerprint),
      dryRunMatches: plan.result.dryRunMatches?.map((match) => ({ ...match, desired: withoutBody(match.desired, fingerprint) })),
    },
  };
}
