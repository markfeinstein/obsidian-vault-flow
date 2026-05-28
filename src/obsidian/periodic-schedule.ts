export interface PeriodicSweepRunContext {
  readonly isMobileApp: boolean;
  readonly documentHidden: boolean;
}

export const MIN_SWEEP_INTERVAL_MS = 60000;

const JITTER_RATIO = 0.1;

export function computeJitteredSweepIntervalMs(
  baseIntervalMs: number,
  randomValue: number = Math.random(),
  minimumIntervalMs: number = MIN_SWEEP_INTERVAL_MS,
): number {
  const safeRandomValue = clamp(randomValue, 0, 1);
  const multiplier = 1 - JITTER_RATIO + (safeRandomValue * JITTER_RATIO * 2);
  return Math.max(minimumIntervalMs, Math.round(baseIntervalMs * multiplier));
}

export function shouldRunPeriodicSweep(context: PeriodicSweepRunContext): boolean {
  return !(context.isMobileApp && context.documentHidden);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}
