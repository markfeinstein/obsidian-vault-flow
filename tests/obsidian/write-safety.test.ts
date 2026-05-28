import { describe, expect, it, vi } from "vitest";
import { WriteSafety } from "../../src/obsidian/write-safety";
import { DEFAULT_SETTINGS, sanitizeVaultFlowSettings } from "../../src/obsidian/settings";
import { formatVaultFlowStatus } from "../../src/obsidian/status";

describe("session write circuit breaker", () => {
  it("trips before exceeding the rolling limit and requires explicit resume", () => {
    let now = 0;
    const onPause = vi.fn();
    const safety = new WriteSafety(onPause, () => now);
    safety.consume(2);
    safety.consume(2);
    expect(() => safety.consume(2)).toThrow("Write limit reached");
    expect(safety.paused).toBe(true);
    now = 120_000;
    expect(() => safety.consume(2)).toThrow("paused");
    safety.setPaused(false);
    expect(() => safety.consume(2)).not.toThrow();
    expect(onPause).toHaveBeenCalledTimes(2);
  });

  it("expires old starts without counting dry-run plans", () => {
    let now = 0;
    const safety = new WriteSafety(() => {}, () => now);
    safety.consume(1);
    now = 60_000;
    safety.consume(1);
    expect(safety.paused).toBe(false);
    safety.setPaused(true);
    expect(() => safety.assertCanWrite()).toThrow("Paused by the user");
    expect(formatVaultFlowStatus({ paused: true, dryRun: false, queue: { pendingCount: 1, runningCount: 0 }, latestDecision: null })).toContain("PAUSED");
  });

  it("supplies safe defaults for old settings and validates configured limits", () => {
    expect(sanitizeVaultFlowSettings({}).settings.maxBatchWrites).toBe(100);
    const migrated = sanitizeVaultFlowSettings({ settingsVersion: 2, rules: [] });
    expect(migrated.sanitized).toBe(true);
    expect(migrated.settings.maxWritesPerMinute).toBe(100);
    const valid = sanitizeVaultFlowSettings({ maxWritesPerMinute: 20, maxBatchWrites: 30 });
    expect(valid.settings).toMatchObject({ maxWritesPerMinute: 20, maxBatchWrites: 30 });
    const invalid = sanitizeVaultFlowSettings({ maxWritesPerMinute: -1, maxBatchWrites: 0 });
    expect(invalid.sanitized).toBe(true);
    expect(invalid.settings.maxWritesPerMinute).toBe(DEFAULT_SETTINGS.maxWritesPerMinute);
  });
});
