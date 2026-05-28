import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, type App, type PluginManifest } from "obsidian";
import type { Rule } from "../../src/engine";
import { planMtimeSweep, sweepRulesDependOnTime, timeDependentSweepDue } from "../../src/obsidian/sweep";
import VaultFlowPlugin from "../../src/main";
import { DEFAULT_SETTINGS, type VaultFlowSettings } from "../../src/obsidian/settings";

const DAY = 86_400_000;
const rule: Rule = {
  id: "age", name: "Age", enabled: true, priority: 0, order: 0, runOn: "sweep",
  when: { type: "all", predicates: [{ type: "not", predicate: { type: "fileAge", field: "mtime", newerThanDays: 30 } }] },
  then: { setProperties: { review: true } },
};

function makeFile(path = "note.md", timestamp = 1): TFile {
  return Object.assign(new TFile(), {
    path,
    basename: path.replace(/\.md$/u, ""),
    extension: "md",
    stat: { ctime: timestamp, mtime: timestamp, size: 0 },
  });
}

const file = makeFile();

describe("sweep invalidation", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("detects nested age predicates and current-time templates", () => {
    expect(sweepRulesDependOnTime([rule])).toBe(true);
    expect(sweepRulesDependOnTime([{ ...rule, when: { type: "frontmatterDateAge", property: "due", olderThanDays: 1 } }])).toBe(true);
    for (const template of ["{now}", "{today:YYYY}", "{date:YYYY-MM-DD}"]) {
      expect(sweepRulesDependOnTime([{ ...rule, when: { type: "pathGlob", glob: "**" }, then: { renameTo: template } }])).toBe(true);
    }
    expect(sweepRulesDependOnTime([{ ...rule, when: { type: "pathGlob", glob: "**" }, then: { renameTo: "{{today}}" } }])).toBe(false);
  });

  it("ignores disabled and non-sweep time-dependent rules", () => {
    expect(sweepRulesDependOnTime([{ ...rule, enabled: false }])).toBe(false);
    expect(sweepRulesDependOnTime([{ ...rule, runOn: "manual" }])).toBe(false);
    expect(sweepRulesDependOnTime([{ ...rule, runOn: "live" }])).toBe(false);
  });

  it("lets the mtime planner enqueue only specifically due unchanged files", () => {
    const due = makeFile("due.md", 1);
    const waiting = makeFile("waiting.md", 1);
    const plan = planMtimeSweep([due, waiting], { "due.md": 1, "waiting.md": 1 }, {
      shouldReevaluate: (candidate) => candidate.path === "due.md",
    });
    expect(plan.filesToEnqueue).toEqual([due]);
    expect(planMtimeSweep([due], { "due.md": 1 }).filesToEnqueue).toEqual([]);
  });

  it("reevaluates exactly when file-age boundaries change truth value", () => {
    const timestamp = new Date(2026, 0, 1, 0, 0, 0).getTime();
    const aged = makeFile("aged.md", timestamp);
    const boundary = timestamp + 30 * DAY;
    const olderRule = { ...rule, when: { type: "fileAge" as const, field: "mtime" as const, olderThanDays: 30 } };
    expect(timeDependentSweepDue(aged, {}, [olderRule], boundary - 1, boundary)).toBe(false);
    expect(timeDependentSweepDue(aged, {}, [olderRule], boundary, boundary + 1)).toBe(true);
    const newerRule = { ...rule, when: { type: "fileAge" as const, field: "mtime" as const, newerThanDays: 30 } };
    expect(timeDependentSweepDue(aged, {}, [newerRule], boundary - 1, boundary)).toBe(true);
  });

  it("uses frontmatter date thresholds without rescanning every interval", () => {
    const timestamp = new Date(2026, 0, 1, 0, 0, 0).getTime();
    const boundary = timestamp + DAY;
    const dateRule = { ...rule, when: { type: "frontmatterDateAge" as const, property: "due", olderThanDays: 1 } };
    expect(timeDependentSweepDue(file, { frontmatter: { due: timestamp } }, [dateRule], boundary - 10, boundary)).toBe(false);
    expect(timeDependentSweepDue(file, { frontmatter: { due: timestamp } }, [dateRule], boundary, boundary + 1)).toBe(true);
    expect(timeDependentSweepDue(file, { frontmatter: { due: "invalid" } }, [dateRule], boundary, boundary + 1)).toBe(false);
  });

  it("reevaluates date templates only when their rendered value changes", () => {
    const morning = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const evening = new Date(2026, 0, 1, 20, 0, 0).getTime();
    const tomorrow = new Date(2026, 0, 2, 1, 0, 0).getTime();
    const todayRule = { ...rule, when: { type: "pathGlob" as const, glob: "**" }, then: { renameTo: "{today}" } };
    expect(timeDependentSweepDue(file, {}, [todayRule], morning, evening)).toBe(false);
    expect(timeDependentSweepDue(file, {}, [todayRule], evening, tomorrow)).toBe(true);
    expect(timeDependentSweepDue(file, { frontmatter: { today: "fixed" } }, [todayRule], evening, tomorrow)).toBe(false);
    const minuteRule = { ...todayRule, then: { renameTo: "{now:mm}" } };
    expect(timeDependentSweepDue(file, {}, [minuteRule], morning, morning + 60_000)).toBe(true);
  });

  it("fails safe on clock rollback for time-dependent rules", () => {
    expect(timeDependentSweepDue(file, {}, [rule], 200, 100)).toBe(true);
    expect(timeDependentSweepDue(file, {}, [{ ...rule, when: { type: "pathGlob", glob: "**" } }], 200, 100)).toBe(false);
  });

  it("invalidates unchanged files after a rule/settings revision", async () => {
    const enqueue = vi.fn();
    const app = {
      metadataCache: { getFileCache: () => ({}) },
      vault: { getMarkdownFiles: () => [file] },
    } as unknown as App;
    const plugin = new VaultFlowPlugin(app, {} as PluginManifest) as unknown as {
      settings: VaultFlowSettings; settingsRevision: number; queue: { enqueueMany(files: readonly TFile[], context: string): Promise<void> }; runMtimeSweep(): Promise<void>;
    };
    plugin.settings = { ...DEFAULT_SETTINGS, trackedMtimes: { "note.md": 1 } };
    plugin.settingsRevision = 1;
    plugin.queue = { enqueueMany: async (files, context) => { for (const item of files) enqueue(item, context); } };
    await plugin.runMtimeSweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
    await plugin.runMtimeSweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
    plugin.settingsRevision = 2;
    await plugin.runMtimeSweep();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenLastCalledWith(file, "sweep");
  });

  it("enqueues unchanged notes only when an age threshold is crossed", async () => {
    vi.useFakeTimers();
    const timestamp = new Date(2026, 0, 1, 0, 0, 0).getTime();
    const aged = makeFile("aged.md", timestamp);
    const enqueue = vi.fn();
    const app = {
      metadataCache: { getFileCache: () => ({}) },
      vault: { getMarkdownFiles: () => [aged] },
    } as unknown as App;
    const plugin = new VaultFlowPlugin(app, {} as PluginManifest) as unknown as {
      settings: VaultFlowSettings; settingsRevision: number; queue: { enqueueMany(files: readonly TFile[], context: string): Promise<void> }; runMtimeSweep(): Promise<void>;
    };
    plugin.settings = { ...DEFAULT_SETTINGS, rules: [{ ...rule, when: { type: "fileAge", field: "mtime", olderThanDays: 30 } }], trackedMtimes: { "aged.md": timestamp } };
    plugin.settingsRevision = 1;
    plugin.queue = { enqueueMany: async (files, context) => { for (const item of files) enqueue(item, context); } };

    vi.setSystemTime(timestamp + 10 * DAY);
    await plugin.runMtimeSweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
    vi.setSystemTime(timestamp + 20 * DAY);
    await plugin.runMtimeSweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
    vi.setSystemTime(timestamp + 31 * DAY);
    await plugin.runMtimeSweep();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
