import { describe, expect, it } from "vitest";
import { sanitizeVaultFlowRuntimeState, sanitizeVaultFlowSettings, sanitizeRules, DEFAULT_SETTINGS } from "../../src/obsidian/settings";
import type { VaultFlowSettings } from "../../src/obsidian/settings";
import type { Rule } from "../../src/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "r1",
    name: "Rule 1",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "tag", tag: "test" },
    then: { moveTo: "Test/" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sanitizeVaultFlowSettings — top-level
// ---------------------------------------------------------------------------

describe("sanitizeVaultFlowSettings — top-level", () => {
  it.each([
    { monitoredFolders: 42 }, { monitoredFolders: [null] }, { monitoredFolders: [" "] }, { monitoredFolders: ["///"] },
    { exclusionPatterns: "Private/**" }, { exclusionPatterns: ["Private/**", false] },
    { disableFrontmatterKey: "" },
  ])("blocks malformed scope settings rather than broadening write scope: %j", (scope) => {
    const result = sanitizeVaultFlowSettings({ dryRun: false, ...scope });
    expect(result.scopeErrors?.length).toBeGreaterThan(0);
  });

  it("allows explicit entire-vault scope and harmless scope normalization", () => {
    expect(sanitizeVaultFlowSettings({ monitoredFolders: [], exclusionPatterns: [] }).scopeErrors).toBeUndefined();
    expect(sanitizeVaultFlowSettings({ monitoredFolders: ["Inbox/", "Inbox/"] }).scopeErrors).toBeUndefined();
  });

  it("returns defaults for null input", () => {
    const result = sanitizeVaultFlowSettings(null);
    expect(result.sanitized).toBe(false);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for undefined input", () => {
    const result = sanitizeVaultFlowSettings(undefined);
    expect(result.sanitized).toBe(false);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("sanitizes non-object input", () => {
    const result = sanitizeVaultFlowSettings("bad string");
    expect(result.sanitized).toBe(true);
  });

  it("preserves valid scalar settings", () => {
    const data: Partial<VaultFlowSettings> = {
      debounceMs: 200,
      maxIterations: 5,
      dryRun: false,
      sweepOnStartup: false,
      periodicSweepEnabled: true,
      sweepIntervalMs: 600000,
      collisionPolicy: "rename-with-suffix",
    };
    const result = sanitizeVaultFlowSettings(data);
    expect(result.sanitized).toBe(false);
    expect(result.settings.debounceMs).toBe(200);
    expect(result.settings.maxIterations).toBe(5);
    expect(result.settings.dryRun).toBe(false);
    expect(result.settings.collisionPolicy).toBe("rename-with-suffix");
  });

  it("sanitizes invalid debounceMs (zero)", () => {
    const result = sanitizeVaultFlowSettings({ debounceMs: 0 });
    expect(result.sanitized).toBe(true);
    expect(result.settings.debounceMs).toBe(DEFAULT_SETTINGS.debounceMs);
  });

  it("sanitizes invalid debounceMs (negative)", () => {
    const result = sanitizeVaultFlowSettings({ debounceMs: -100 });
    expect(result.sanitized).toBe(true);
    expect(result.settings.debounceMs).toBe(DEFAULT_SETTINGS.debounceMs);
  });

  it("sanitizes invalid collisionPolicy", () => {
    const result = sanitizeVaultFlowSettings({ collisionPolicy: "unknown" });
    expect(result.sanitized).toBe(true);
    expect(result.settings.collisionPolicy).toBe(DEFAULT_SETTINGS.collisionPolicy);
  });

  it("accepts versioned settings envelopes", () => {
    const result = sanitizeVaultFlowSettings({
      settingsVersion: 4,
      settings: { debounceMs: 250 },
    });
    expect(result.sanitized).toBe(false);
    expect(result.settings.debounceMs).toBe(250);
  });

  it("fails closed for unsupported future settings versions", () => {
    const result = sanitizeVaultFlowSettings({
      settingsVersion: 5,
      settings: { debounceMs: 250, dryRun: false },
    });
    expect(result.sanitized).toBe(false);
    expect(result.incompatibleVersion).toBe(5);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("preserves settings when wrapped in a matching version envelope", () => {
    const result = sanitizeVaultFlowSettings({
      settingsVersion: 4,
      settings: {
        dryRun: false,
        collisionPolicy: "skip",
      },
    });

    expect(result.sanitized).toBe(false);
    expect(result.settings.dryRun).toBe(false);
  });

  it("preserves monitoredFolders", () => {
    const result = sanitizeVaultFlowSettings({ monitoredFolders: ["Projects", "Inbox"] });
    expect(result.sanitized).toBe(false);
    expect(result.settings.monitoredFolders).toEqual(["Projects", "Inbox"]);
  });

  it("sanitizes invalid monitoredFolders entry (non-string)", () => {
    const result = sanitizeVaultFlowSettings({ monitoredFolders: ["Projects", 42, "Inbox"] as unknown[] });
    expect(result.sanitized).toBe(true);
    expect(result.settings.monitoredFolders).toEqual(["Projects", "Inbox"]);
  });
});

// ---------------------------------------------------------------------------
// New settings fields
// ---------------------------------------------------------------------------

describe("sanitizeVaultFlowSettings — exclusionPatterns", () => {
  it("defaults to empty array when absent", () => {
    const result = sanitizeVaultFlowSettings({});
    expect(result.settings.exclusionPatterns).toEqual([]);
    expect(result.sanitized).toBe(false);
  });

  it("preserves valid exclusion patterns", () => {
    const result = sanitizeVaultFlowSettings({ exclusionPatterns: ["Templates/**", "Archive/**"] });
    expect(result.sanitized).toBe(false);
    expect(result.settings.exclusionPatterns).toEqual(["Templates/**", "Archive/**"]);
  });

  it("filters out non-string entries", () => {
    const result = sanitizeVaultFlowSettings({ exclusionPatterns: ["Templates/**", 42, null] as unknown[] });
    expect(result.sanitized).toBe(true);
    expect(result.settings.exclusionPatterns).toEqual(["Templates/**"]);
  });

  it("filters out blank entries", () => {
    const result = sanitizeVaultFlowSettings({ exclusionPatterns: ["Templates/**", "  ", "Archive/**"] });
    expect(result.sanitized).toBe(true);
    expect(result.settings.exclusionPatterns).toEqual(["Templates/**", "Archive/**"]);
  });

  it("sanitizes non-array value", () => {
    const result = sanitizeVaultFlowSettings({ exclusionPatterns: "Templates/**" });
    expect(result.sanitized).toBe(true);
    expect(result.settings.exclusionPatterns).toEqual([]);
  });
});

describe("sanitizeVaultFlowSettings — disableFrontmatterKey", () => {
  it("defaults to 'vault-flow-disable' when absent", () => {
    const result = sanitizeVaultFlowSettings({});
    expect(result.settings.disableFrontmatterKey).toBe("vault-flow-disable");
    expect(result.sanitized).toBe(false);
  });

  it("preserves valid custom key", () => {
    const result = sanitizeVaultFlowSettings({ disableFrontmatterKey: "my-custom-key" });
    expect(result.sanitized).toBe(false);
    expect(result.settings.disableFrontmatterKey).toBe("my-custom-key");
  });

  it("falls back to default for empty string", () => {
    const result = sanitizeVaultFlowSettings({ disableFrontmatterKey: "" });
    expect(result.settings.disableFrontmatterKey).toBe("vault-flow-disable");
  });

  it("falls back to default for non-string", () => {
    const result = sanitizeVaultFlowSettings({ disableFrontmatterKey: 42 as unknown as string });
    expect(result.settings.disableFrontmatterKey).toBe("vault-flow-disable");
  });
});

// ---------------------------------------------------------------------------
// sanitizeRules — basic shapes
// ---------------------------------------------------------------------------

describe("sanitizeRules — basic", () => {
  it("returns empty array for undefined", () => {
    const result = sanitizeRules(undefined);
    expect(result.rules).toEqual([]);
    expect(result.sanitized).toBe(false);
  });

  it("sanitizes non-array", () => {
    const result = sanitizeRules("not an array");
    expect(result.sanitized).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it("rejects rules with missing required fields", () => {
    const result = sanitizeRules([{ id: "r1" }]); // missing name, enabled, etc.
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts a minimal valid rule", () => {
    const result = sanitizeRules([minimalRule()]);
    expect(result.sanitized).toBe(false);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe("r1");
  });

  it("deduplicates rules with the same id", () => {
    const result = sanitizeRules([minimalRule(), minimalRule()]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sanitizeRules — stopOnMatch and runOn
// ---------------------------------------------------------------------------

describe("sanitizeRules — stopOnMatch and runOn", () => {
  it("preserves stopOnMatch: true", () => {
    const result = sanitizeRules([minimalRule({ stopOnMatch: true })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].stopOnMatch).toBe(true);
  });

  it("omits stopOnMatch when false (normalised away)", () => {
    const result = sanitizeRules([minimalRule({ stopOnMatch: false })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].stopOnMatch).toBeUndefined();
  });

  it("rejects a non-boolean stopOnMatch value", () => {
    const result = sanitizeRules([{ ...minimalRule(), stopOnMatch: "yes" }]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("preserves valid runOn values", () => {
    for (const runOn of ["always", "live", "sweep", "manual"] as const) {
      const result = sanitizeRules([minimalRule({ runOn })]);
      expect(result.sanitized).toBe(false);
      if (runOn === "always") {
        // "always" may be omitted since it's the default
        expect(result.rules[0].runOn === undefined || result.rules[0].runOn === "always").toBe(true);
      } else {
        expect(result.rules[0].runOn).toBe(runOn);
      }
    }
  });

  it("rejects an invalid runOn value", () => {
    const ruleData = { ...minimalRule(), runOn: "invalid-trigger" };
    const result = sanitizeRules([ruleData]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("rejects unsupported future runOn value", () => {
    const result = sanitizeRules([{ ...minimalRule(), runOn: "future" as unknown as Rule["runOn"] }]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeRules — new predicate types
// ---------------------------------------------------------------------------

describe("sanitizeRules — new predicate types", () => {
  function ruleWith(when: Rule["when"]): object {
    return { ...minimalRule(), when };
  }

  it.each(["basename", "bodyH1", "frontmatterRegex", "contentRegex"])("rejects unsupported RE2 syntax for %s, even inside groups", (type) => {
    const when = { type: "not", predicate: { type, property: "status", pattern: "(?=foo)foo" } };
    const raw = { rules: [{ ...minimalRule(), when }] };
    const result = sanitizeVaultFlowSettings(raw);
    expect(result.regexErrors).toEqual([minimalRule().id]);
    expect(result.settings.rules).toEqual([]);
    expect(result.sanitized).toBe(true);
    expect(raw.rules[0]?.when).toEqual(when);
  });

  it("accepts frontmatterExists predicate", () => {
    const result = sanitizeRules([ruleWith({ type: "frontmatterExists", property: "status" })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when).toEqual({ type: "frontmatterExists", property: "status" });
  });

  it("rejects frontmatterValue predicates with a missing value", () => {
    const result = sanitizeRules([ruleWith({ type: "frontmatterValue", property: "status" } as unknown as Rule["when"])]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("rejects unsafe frontmatter predicate property keys", () => {
    for (const property of ["__proto__", "constructor", "prototype"]) {
      const result = sanitizeRules([ruleWith({ type: "frontmatterExists", property })]);
      expect(result.sanitized).toBe(true);
      expect(result.rules).toHaveLength(0);
    }
  });

  it("rejects frontmatterExists with missing property", () => {
    const result = sanitizeRules([ruleWith({ type: "frontmatterExists", property: "" })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts frontmatterMissing predicate", () => {
    const result = sanitizeRules([ruleWith({ type: "frontmatterMissing", property: "reviewed" })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when.type).toBe("frontmatterMissing");
  });

  it("accepts frontmatterContains predicate", () => {
    const result = sanitizeRules([ruleWith({ type: "frontmatterContains", property: "desc", value: "urgent" })]);
    expect(result.sanitized).toBe(false);
    const when = result.rules[0].when;
    expect(when.type).toBe("frontmatterContains");
    if (when.type === "frontmatterContains") {
      expect(when.property).toBe("desc");
      expect(when.value).toBe("urgent");
    }
  });

  it("rejects frontmatterContains with non-string value", () => {
    const result = sanitizeRules([ruleWith({ type: "frontmatterContains", property: "desc", value: 42 } as unknown as Rule["when"])]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts fileAge predicate with olderThanDays", () => {
    const result = sanitizeRules([ruleWith({ type: "fileAge", field: "mtime", olderThanDays: 30 })]);
    expect(result.sanitized).toBe(false);
    const when = result.rules[0].when;
    expect(when.type).toBe("fileAge");
    if (when.type === "fileAge") {
      expect(when.field).toBe("mtime");
      expect(when.olderThanDays).toBe(30);
    }
  });

  it("accepts fileAge predicate with newerThanDays only", () => {
    const result = sanitizeRules([ruleWith({ type: "fileAge", field: "ctime", newerThanDays: 7 })]);
    expect(result.sanitized).toBe(false);
    const when = result.rules[0].when;
    if (when.type === "fileAge") {
      expect(when.newerThanDays).toBe(7);
      expect(when.olderThanDays).toBeUndefined();
    }
  });

  it("rejects fileAge with invalid field", () => {
    const result = sanitizeRules([ruleWith({ type: "fileAge", field: "atime", olderThanDays: 30 } as unknown as Rule["when"])]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("rejects fileAge with invalid thresholds", () => {
    const result = sanitizeRules([ruleWith({ type: "fileAge", field: "mtime", olderThanDays: 0 } as unknown as Rule["when"]) ]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts bodyH1 predicate", () => {
    const result = sanitizeRules([ruleWith({ type: "bodyH1", pattern: "^Meeting" })]);
    expect(result.sanitized).toBe(false);
    const when = result.rules[0].when;
    expect(when.type).toBe("bodyH1");
    if (when.type === "bodyH1") {
      expect(when.pattern).toBe("^Meeting");
    }
  });

  it("rejects bodyH1 with invalid regex", () => {
    const result = sanitizeRules([ruleWith({ type: "bodyH1", pattern: "[invalid(" })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("rejects very large regex patterns", () => {
    const result = sanitizeRules([ruleWith({ type: "contentRegex", pattern: "a".repeat(600) })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts contentContains predicate", () => {
    const result = sanitizeRules([ruleWith({ type: "contentContains", text: "#project-x" })]);
    expect(result.sanitized).toBe(false);
    const when = result.rules[0].when;
    expect(when.type).toBe("contentContains");
    if (when.type === "contentContains") {
      expect(when.text).toBe("#project-x");
    }
  });

  it("rejects contentContains with non-string text", () => {
    const result = sanitizeRules([ruleWith({ type: "contentContains", text: 42 } as unknown as Rule["when"])]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeRules — new action types
// ---------------------------------------------------------------------------

describe("sanitizeRules — new action types", () => {
  function ruleWithThen(then: Rule["then"]): object {
    return { ...minimalRule(), then };
  }

  it("accepts removeTags action", () => {
    const result = sanitizeRules([ruleWithThen({ removeTags: ["wip", "draft"] })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.removeTags).toEqual(["wip", "draft"]);
  });

  it("accepts replaceTags action", () => {
    const result = sanitizeRules([ruleWithThen({ replaceTags: ["archived"] })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.replaceTags).toEqual(["archived"]);
  });

  it("accepts replaceTags with empty array", () => {
    const result = sanitizeRules([ruleWithThen({ replaceTags: [] })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.replaceTags).toEqual([]);
  });

  it("accepts deleteProperties action", () => {
    const result = sanitizeRules([ruleWithThen({ deleteProperties: ["legacy_id", "old_status"] })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.deleteProperties).toEqual(["legacy_id", "old_status"]);
  });

  it("rejects unsafe deleteProperties keys", () => {
    const result = sanitizeRules([ruleWithThen({ deleteProperties: ["legacy_id", "constructor"] })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("rejects removeTags with non-string array entries", () => {
    const result = sanitizeRules([ruleWithThen({ removeTags: ["wip", 42] as unknown[] } as unknown as Rule["then"])]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("normalizes tag action values and removes case-variant duplicates", () => {
    const result = sanitizeRules([ruleWithThen({ addTags: ["#Project", " project ", "Area/Work"] })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules[0].then.addTags).toEqual(["Project", "Area/Work"]);
  });

  it.each(["two words", "1984", "bad,tag", "bad#tag"])("rejects invalid tag action value %s", (tag) => {
    const result = sanitizeRules([ruleWithThen({ addTags: [tag] })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts Unicode and emoji tag values", () => {
    const result = sanitizeRules([ruleWithThen({ addTags: ["研究/資料", "project/🚀"] })]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.addTags).toEqual(["研究/資料", "project/🚀"]);
  });

  it("rejects unknown action keys", () => {
    const result = sanitizeRules([ruleWithThen({ moveTo: "Test/", unknownField: "oops" } as unknown as Rule["then"])]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("drops unsafe frontmatter keys in imported actions", () => {
    const setProperties = Object.create(null) as Record<string, unknown>;
    setProperties.__proto__ = { polluted: true };
    setProperties.safe = "ok";
    const result = sanitizeRules([ruleWithThen({ setProperties } as unknown as Rule["then"])]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts a rule with all action types combined", () => {
    const then: Rule["then"] = {
      moveTo: "Archive/",
      renameTo: "{title}",
      addTags: ["archived"],
      removeTags: ["active"],
      replaceTags: ["done"],
      setProperties: { status: "archived" },
      deleteProperties: ["legacy"],
    };
    const result = sanitizeRules([ruleWithThen(then)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then).toEqual(then);
  });
});

// ---------------------------------------------------------------------------
// sanitizeRules — all/any/not compound predicates
// ---------------------------------------------------------------------------

describe("sanitizeRules — compound predicates", () => {
  it("accepts all predicate wrapping new types", () => {
    const result = sanitizeRules([{
      ...minimalRule(),
      when: {
        type: "all",
        predicates: [
          { type: "frontmatterExists", property: "status" },
          { type: "fileAge", field: "mtime", olderThanDays: 30 },
        ],
      },
    }]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when.type).toBe("all");
  });

  it("accepts not wrapping frontmatterMissing", () => {
    const result = sanitizeRules([{
      ...minimalRule(),
      when: { type: "not", predicate: { type: "frontmatterMissing", property: "reviewed" } },
    }]);
    expect(result.sanitized).toBe(false);
    const when = result.rules[0].when;
    expect(when.type).toBe("not");
  });

  it("rejects all with an invalid child predicate", () => {
    const result = sanitizeRules([{
      ...minimalRule(),
      when: {
        type: "all",
        predicates: [
          { type: "frontmatterExists", property: "status" },
          { type: "fileAge", field: "INVALID", olderThanDays: 30 }, // bad field
        ],
      },
    }]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeRules — 5 new predicate types serialization
// ---------------------------------------------------------------------------

describe("sanitizeRules — 5 new predicate types (serialization round-trip)", () => {
  function ruleWith(when: Rule["when"]): object {
    return { ...minimalRule(), when };
  }

  it("accepts and round-trips frontmatterRegex predicate", () => {
    const predicate = { type: "frontmatterRegex", property: "status", pattern: "^done$" } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when).toEqual(predicate);
  });

  it("rejects frontmatterRegex with invalid regex pattern", () => {
    const result = sanitizeRules([ruleWith({ type: "frontmatterRegex", property: "status", pattern: "[invalid(" })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts and round-trips frontmatterDateAge with olderThanDays", () => {
    const predicate = { type: "frontmatterDateAge", property: "date", olderThanDays: 30 } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when).toEqual(predicate);
  });

  it("accepts and round-trips frontmatterDateAge with newerThanDays", () => {
    const predicate = { type: "frontmatterDateAge", property: "date", newerThanDays: 7 } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when).toEqual(predicate);
  });

  it("accepts frontmatterDateAge with both olderThanDays and newerThanDays", () => {
    const predicate = { type: "frontmatterDateAge", property: "date", olderThanDays: 90, newerThanDays: 30 } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    const when = result.rules[0].when;
    if (when.type === "frontmatterDateAge") {
      expect(when.olderThanDays).toBe(90);
      expect(when.newerThanDays).toBe(30);
    }
  });

  it("accepts and round-trips wordCount predicate with moreThan", () => {
    const predicate = { type: "wordCount", moreThan: 100 } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when).toEqual(predicate);
  });

  it("accepts and round-trips wordCount predicate with lessThan", () => {
    const predicate = { type: "wordCount", lessThan: 10 } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when).toEqual(predicate);
  });

  it("accepts wordCount predicate with both moreThan and lessThan", () => {
    const predicate = { type: "wordCount", moreThan: 5, lessThan: 200 } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    const when = result.rules[0].when;
    if (when.type === "wordCount") {
      expect(when.moreThan).toBe(5);
      expect(when.lessThan).toBe(200);
    }
  });

  it("accepts and round-trips tagPrefix predicate", () => {
    const predicate = { type: "tagPrefix", prefix: "area" } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when).toEqual(predicate);
  });

  it("normalizes a leading hash in tag predicates", () => {
    const result = sanitizeRules([ruleWith({ type: "tag", tag: "#Project" })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules[0].when).toEqual({ type: "tag", tag: "Project" });
  });

  it("rejects invalid tag predicates", () => {
    const result = sanitizeRules([ruleWith({ type: "tag", tag: "two words" })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("rejects tagPrefix with empty prefix", () => {
    const result = sanitizeRules([ruleWith({ type: "tagPrefix", prefix: "" })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts and round-trips contentRegex predicate", () => {
    const predicate = { type: "contentRegex", pattern: "TODO:" } as const;
    const result = sanitizeRules([ruleWith(predicate)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].when).toEqual(predicate);
  });

  it("rejects contentRegex with invalid regex pattern", () => {
    const result = sanitizeRules([ruleWith({ type: "contentRegex", pattern: "[invalid(" })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeRules — initProperties and appendToProperty action serialization
// ---------------------------------------------------------------------------

describe("sanitizeRules — initProperties and appendToProperty actions", () => {
  function ruleWithThen(then: Rule["then"]): object {
    return { ...minimalRule(), then };
  }

  it("accepts and round-trips initProperties action", () => {
    const then = { initProperties: { status: "inbox", priority: 1, reviewed: false } } satisfies Rule["then"];
    const result = sanitizeRules([ruleWithThen(then)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.initProperties).toEqual({ status: "inbox", priority: 1, reviewed: false });
  });

  it("accepts initProperties with null value", () => {
    const then = { initProperties: { legacy: null } } satisfies Rule["then"];
    const result = sanitizeRules([ruleWithThen(then)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.initProperties?.legacy).toBeNull();
  });

  it("accepts and round-trips appendToProperty action", () => {
    const then = { appendToProperty: { log: "entry", notes: "text" } } satisfies Rule["then"];
    const result = sanitizeRules([ruleWithThen(then)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.appendToProperty).toEqual({ log: "entry", notes: "text" });
  });

  it("rejects appendToProperty with non-string value", () => {
    const result = sanitizeRules([ruleWithThen({ appendToProperty: { log: 42 } } as unknown as Rule["then"])]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("rejects unsafe appendToProperty keys", () => {
    const result = sanitizeRules([ruleWithThen({ appendToProperty: { prototype: "entry" } })]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });

  it("accepts rule combining initProperties and appendToProperty", () => {
    const then: Rule["then"] = {
      initProperties: { status: "new" },
      appendToProperty: { log: "created" },
    };
    const result = sanitizeRules([ruleWithThen(then)]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].then.initProperties).toEqual({ status: "new" });
    expect(result.rules[0].then.appendToProperty).toEqual({ log: "created" });
  });
});

// ---------------------------------------------------------------------------
// sanitizeRules — per-rule dryRun serialization
// ---------------------------------------------------------------------------

describe("sanitizeRules — per-rule dryRun", () => {
  it("preserves dryRun: true on a rule", () => {
    const result = sanitizeRules([{ ...minimalRule(), dryRun: true }]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].dryRun).toBe(true);
  });

  it("omits dryRun when false (normalized away)", () => {
    const result = sanitizeRules([{ ...minimalRule(), dryRun: false }]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].dryRun).toBeUndefined();
  });

  it("omits dryRun when absent", () => {
    const result = sanitizeRules([minimalRule()]);
    expect(result.sanitized).toBe(false);
    expect(result.rules[0].dryRun).toBeUndefined();
  });

  it("rejects a non-boolean dryRun value instead of enabling writes", () => {
    const result = sanitizeRules([{ ...minimalRule(), dryRun: "yes" }]);
    expect(result.sanitized).toBe(true);
    expect(result.rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeVaultFlowSettings — ruleStats
// ---------------------------------------------------------------------------

describe("sanitizeVaultFlowSettings — ruleStats", () => {
  it("defaults to empty object when absent", () => {
    const result = sanitizeVaultFlowSettings({});
    expect(result.settings.ruleStats).toEqual({});
    expect(result.sanitized).toBe(false);
  });

  it("round-trips valid ruleStats entries", () => {
    const ruleStats = {
      "rule-1": { matchCount: 5, lastMatchAt: 1710000000000 },
      "rule-2": { matchCount: 0, lastMatchAt: 0 },
    };
    const result = sanitizeVaultFlowSettings({ ruleStats });
    expect(result.sanitized).toBe(false);
    expect(result.settings.ruleStats).toEqual(ruleStats);
  });

  it("drops invalid ruleStats entries (non-numeric matchCount)", () => {
    const ruleStats = {
      "rule-good": { matchCount: 3, lastMatchAt: 1710000000000 },
      "rule-bad": { matchCount: "not-a-number", lastMatchAt: 1710000000000 },
    };
    const result = sanitizeVaultFlowSettings({ ruleStats });
    expect(result.sanitized).toBe(true);
    expect(result.settings.ruleStats["rule-good"]).toEqual({ matchCount: 3, lastMatchAt: 1710000000000 });
    expect(result.settings.ruleStats["rule-bad"]).toBeUndefined();
  });

  it("drops ruleStats entries with negative matchCount", () => {
    const result = sanitizeVaultFlowSettings({
      ruleStats: { "r1": { matchCount: -1, lastMatchAt: 1710000000000 } },
    });
    expect(result.sanitized).toBe(true);
    expect(result.settings.ruleStats["r1"]).toBeUndefined();
  });

  it("sanitizes non-object ruleStats", () => {
    const result = sanitizeVaultFlowSettings({ ruleStats: "invalid" });
    expect(result.sanitized).toBe(true);
    expect(result.settings.ruleStats).toEqual({});
  });
});

describe("sanitizeVaultFlowRuntimeState", () => {
  it("migrates complete transaction snapshots into a separate journal", () => {
    const result = sanitizeVaultFlowRuntimeState({
      trackedMtimes: { "Note.md": 10 },
      ruleStats: { rule: { matchCount: 1, lastMatchAt: 20 } },
      recentDecisions: [{
        timestamp: Date.now(),
        path: "Note.md",
        desiredPath: "Archive/Note.md",
        outcome: "changed",
        appliedRuleIds: ["rule"],
        involvedRuleIds: [],
        mutationKinds: ["move", "frontmatter"],
        iterations: 1,
        transactionId: "tx-1",
        beforeFrontmatter: { nested: { values: [1, 2] } },
        afterFrontmatter: { nested: { values: [3] } },
      }],
    });

    expect(result.sanitized).toBe(true);
    expect(result.runtimeState.transactions?.[0]).toMatchObject({
      transactionId: "tx-1",
      beforeFrontmatter: { nested: { values: [1, 2] } },
      afterFrontmatter: { nested: { values: [3] } },
    });
  });
});
