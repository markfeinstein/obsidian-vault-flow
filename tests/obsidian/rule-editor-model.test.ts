import { describe, expect, it } from "vitest";
import {
  createRuleFromDraft,
  createDefaultRuleDraft,
  draftFromRule,
  predicateFromConditionNodes,
  summarizeActionSet,
  summarizePredicate,
  updateRuleById,
  parseTags,
  parsePropertyList,
} from "../../src/obsidian/rule-editor-model";
import type { VisualConditionNode, VisualRuleDraft } from "../../src/obsidian/rule-editor-model";
import type { Rule } from "../../src/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseDraft(overrides: Partial<VisualRuleDraft> = {}): VisualRuleDraft {
  return {
    name: "Test rule",
    enabled: true,
    priority: "0",
    order: "0",
    criteriaMode: "all",
    stopOnMatch: false,
    dryRun: false,
    runOn: "always",
    predicateType: "tag",
    tag: "test",
    pathGlob: "",
    basenamePattern: "",
    frontmatterValueProperty: "",
    frontmatterValueValue: "",
    frontmatterContainsSearchValue: "",
    sourceUrlProperty: "source",
    sourceUrlHost: "",
    fileAgeField: "mtime",
    fileAgeOlderThanDays: "",
    fileAgeNewerThanDays: "",
    contentContainsText: "",
    frontmatterRegexPattern: "",
    frontmatterDateAgeProperty: "",
    wordCountMoreThan: "",
    wordCountLessThan: "",
    tagPrefixValue: "",
    contentRegexPattern: "",
    moveTo: "",
    renameTo: "",
    addTags: "",
    removeTags: "",
    replaceTags: "",
    replaceTagsEnabled: false,
    setPropertiesJson: "",
    initPropertiesJson: "",
    appendToPropertyJson: "",
    deletePropertiesList: "",
    ...overrides,
  };
}

function minimalRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "test-rule",
    name: "Test rule",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "tag", tag: "test" },
    then: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// summarizePredicate — new types
// ---------------------------------------------------------------------------

describe("summarizePredicate — new predicate types", () => {
  it("summarizes frontmatterExists", () => {
    expect(summarizePredicate({ type: "frontmatterExists", property: "status" }))
      .toBe("status exists");
  });

  it("summarizes frontmatterMissing", () => {
    expect(summarizePredicate({ type: "frontmatterMissing", property: "reviewed" }))
      .toBe("reviewed is missing");
  });

  it("summarizes frontmatterContains", () => {
    expect(summarizePredicate({ type: "frontmatterContains", property: "desc", value: "urgent" }))
      .toBe('desc contains "urgent"');
  });

  it("summarizes fileAge with olderThanDays", () => {
    const s = summarizePredicate({ type: "fileAge", field: "mtime", olderThanDays: 30 });
    expect(s).toContain("mtime");
    expect(s).toContain("older than 30d");
  });

  it("summarizes fileAge with both constraints", () => {
    const s = summarizePredicate({ type: "fileAge", field: "ctime", olderThanDays: 90, newerThanDays: 7 });
    expect(s).toContain("older than 90d");
    expect(s).toContain("newer than 7d");
  });

  it("summarizes bodyH1", () => {
    expect(summarizePredicate({ type: "bodyH1", pattern: "^Meeting" }))
      .toBe("H1 heading matches /^Meeting/i");
  });

  it("summarizes contentContains", () => {
    expect(summarizePredicate({ type: "contentContains", text: "#project-x" }))
      .toBe('content contains "#project-x"');
  });
});

// ---------------------------------------------------------------------------
// summarizeActionSet — new action types
// ---------------------------------------------------------------------------

describe("summarizeActionSet — new action types", () => {
  it("summarizes removeTags", () => {
    const s = summarizeActionSet({ removeTags: ["wip", "draft"] });
    expect(s).toContain("remove tags");
    expect(s).toContain("#wip");
    expect(s).toContain("#draft");
  });

  it("summarizes replaceTags with values", () => {
    const s = summarizeActionSet({ replaceTags: ["archived", "done"] });
    expect(s).toContain("replace tags with");
    expect(s).toContain("#archived");
  });

  it("summarizes replaceTags with empty list", () => {
    const s = summarizeActionSet({ replaceTags: [] });
    expect(s).toBe("remove all tags");
  });

  it("summarizes deleteProperties", () => {
    const s = summarizeActionSet({ deleteProperties: ["legacy_id", "old_status"] });
    expect(s).toContain("delete legacy_id, old_status");
  });

  it("summarizes combined actions in order", () => {
    const s = summarizeActionSet({
      moveTo: "Archive/",
      addTags: ["archived"],
      removeTags: ["active"],
      deleteProperties: ["legacy"],
    });
    expect(s).toContain("move to");
    expect(s).toContain("add tags");
    expect(s).toContain("remove tags");
    expect(s).toContain("delete legacy");
  });

  it("returns 'No actions' for empty action set", () => {
    expect(summarizeActionSet({})).toBe("No actions");
  });
});

// ---------------------------------------------------------------------------
// createRuleFromDraft — new predicate types
// ---------------------------------------------------------------------------

describe("createRuleFromDraft — new predicate types", () => {
  it.each(["basename", "bodyH1", "frontmatterRegex", "contentRegex"] as const)("explains unsupported RE2 syntax for %s", (predicateType) => {
    const result = createRuleFromDraft([], baseDraft({
      predicateType, basenamePattern: "(?=foo)foo", frontmatterRegexPattern: "(?=foo)foo",
      contentRegexPattern: "(?=foo)foo", frontmatterValueProperty: "status", moveTo: "Archive",
    }));
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("RE2-compatible syntax");
  });
  it("creates frontmatterExists rule", () => {
    const result = createRuleFromDraft([], baseDraft({ predicateType: "frontmatterExists", frontmatterValueProperty: "status" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const rule = result.rules[0];
      expect(rule.when.type).toBe("frontmatterExists");
      if (rule.when.type === "frontmatterExists") {
        expect(rule.when.property).toBe("status");
      }
    }
  });

  it("creates frontmatterMissing rule", () => {
    const result = createRuleFromDraft([], baseDraft({ predicateType: "frontmatterMissing", frontmatterValueProperty: "reviewed" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].when.type).toBe("frontmatterMissing");
    }
  });

  it("returns error for frontmatterExists with empty property", () => {
    const result = createRuleFromDraft([], baseDraft({ predicateType: "frontmatterExists", frontmatterValueProperty: "" }));
    expect(result.status).toBe("error");
  });

  it("creates frontmatterContains rule", () => {
    const result = createRuleFromDraft([], baseDraft({
      predicateType: "frontmatterContains",
      frontmatterValueProperty: "desc",
      frontmatterContainsSearchValue: "urgent",
    }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const when = result.rules[0].when;
      expect(when.type).toBe("frontmatterContains");
      if (when.type === "frontmatterContains") {
        expect(when.value).toBe("urgent");
      }
    }
  });

  it("creates fileAge rule", () => {
    const result = createRuleFromDraft([], baseDraft({
      predicateType: "fileAge",
      fileAgeField: "mtime",
      fileAgeOlderThanDays: "30",
    }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const when = result.rules[0].when;
      if (when.type === "fileAge") {
        expect(when.field).toBe("mtime");
        expect(when.olderThanDays).toBe(30);
      }
    }
  });

  it("returns error for fileAge with no constraints", () => {
    const result = createRuleFromDraft([], baseDraft({
      predicateType: "fileAge",
      fileAgeField: "mtime",
      fileAgeOlderThanDays: "",
      fileAgeNewerThanDays: "",
    }));
    expect(result.status).toBe("error");
  });

  it("creates bodyH1 rule", () => {
    const result = createRuleFromDraft([], baseDraft({ predicateType: "bodyH1", basenamePattern: "^Meeting" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].when.type).toBe("bodyH1");
    }
  });

  it("creates contentContains rule", () => {
    const result = createRuleFromDraft([], baseDraft({ predicateType: "contentContains", contentContainsText: "#project-x" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const when = result.rules[0].when;
      if (when.type === "contentContains") {
        expect(when.text).toBe("#project-x");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// createRuleFromDraft — new action types
// ---------------------------------------------------------------------------

describe("createRuleFromDraft — new action types", () => {
  it("creates rule with removeTags", () => {
    const result = createRuleFromDraft([], baseDraft({ removeTags: "wip, draft" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].then.removeTags).toEqual(["wip", "draft"]);
    }
  });

  it("creates rule with replaceTags enabled", () => {
    const result = createRuleFromDraft([], baseDraft({ replaceTagsEnabled: true, replaceTags: "archived, done" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].then.replaceTags).toEqual(["archived", "done"]);
    }
  });

  it("creates rule with replaceTags enabled but empty (remove all)", () => {
    const result = createRuleFromDraft([], baseDraft({ replaceTagsEnabled: true, replaceTags: "" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].then.replaceTags).toEqual([]);
    }
  });

  it("omits replaceTags when replaceTagsEnabled is false", () => {
    const result = createRuleFromDraft([], baseDraft({ replaceTagsEnabled: false, replaceTags: "archived" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].then.replaceTags).toBeUndefined();
    }
  });

  it("creates rule with deleteProperties", () => {
    const result = createRuleFromDraft([], baseDraft({ deletePropertiesList: "legacy_id, old_field" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].then.deleteProperties).toEqual(["legacy_id", "old_field"]);
    }
  });
});

// ---------------------------------------------------------------------------
// createRuleFromDraft — rule options
// ---------------------------------------------------------------------------

describe("createRuleFromDraft — stopOnMatch and runOn", () => {
  it("sets stopOnMatch: true", () => {
    const result = createRuleFromDraft([], baseDraft({ stopOnMatch: true }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].stopOnMatch).toBe(true);
    }
  });

  it("omits stopOnMatch when false", () => {
    const result = createRuleFromDraft([], baseDraft({ stopOnMatch: false }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].stopOnMatch).toBeUndefined();
    }
  });

  it("sets runOn: 'sweep'", () => {
    const result = createRuleFromDraft([], baseDraft({ runOn: "sweep" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].runOn).toBe("sweep");
    }
  });

  it("omits runOn when 'always'", () => {
    const result = createRuleFromDraft([], baseDraft({ runOn: "always" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].runOn).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// draftFromRule — round-trips for all new fields
// ---------------------------------------------------------------------------

describe("draftFromRule — round-trips", () => {
  function roundTrip(rule: Rule): Rule | null {
    const draft = draftFromRule(rule);
    if (draft === null) return null;
    const result = createRuleFromDraft([], draft);
    if (result.status !== "ok") return null;
    return result.rules[0] ?? null;
  }

  it("round-trips a frontmatterExists rule", () => {
    const rule = minimalRule({ when: { type: "frontmatterExists", property: "status" } });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual({ type: "frontmatterExists", property: "status" });
  });

  it("round-trips a frontmatterMissing rule", () => {
    const rule = minimalRule({ when: { type: "frontmatterMissing", property: "reviewed" } });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual({ type: "frontmatterMissing", property: "reviewed" });
  });

  it("round-trips a frontmatterContains rule", () => {
    const rule = minimalRule({ when: { type: "frontmatterContains", property: "desc", value: "urgent" } });
    const rt = roundTrip(rule);
    expect(rt?.when.type).toBe("frontmatterContains");
    if (rt?.when.type === "frontmatterContains") {
      expect(rt.when.value).toBe("urgent");
    }
  });

  it("round-trips a fileAge rule", () => {
    const rule = minimalRule({ when: { type: "fileAge", field: "mtime", olderThanDays: 30 } });
    const rt = roundTrip(rule);
    expect(rt?.when.type).toBe("fileAge");
    if (rt?.when.type === "fileAge") {
      expect(rt.when.olderThanDays).toBe(30);
    }
  });

  it("round-trips a bodyH1 rule", () => {
    const rule = minimalRule({ when: { type: "bodyH1", pattern: "^Meeting" } });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual({ type: "bodyH1", pattern: "^Meeting" });
  });

  it("round-trips a contentContains rule", () => {
    const rule = minimalRule({ when: { type: "contentContains", text: "#project" } });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual({ type: "contentContains", text: "#project" });
  });

  it("round-trips removeTags action", () => {
    const rule = minimalRule({ then: { removeTags: ["wip"] } });
    const rt = roundTrip(rule);
    expect(rt?.then.removeTags).toEqual(["wip"]);
  });

  it("round-trips replaceTags with values", () => {
    const rule = minimalRule({ then: { replaceTags: ["archived", "done"] } });
    const rt = roundTrip(rule);
    expect(rt?.then.replaceTags).toEqual(["archived", "done"]);
  });

  it("round-trips replaceTags: [] (clear all tags — the key bug)", () => {
    const rule = minimalRule({ then: { replaceTags: [] } });
    const rt = roundTrip(rule);
    // Must preserve the empty array — this was the bug
    expect(rt?.then.replaceTags).toEqual([]);
    expect(rt?.then.replaceTags).toBeDefined();
  });

  it("round-trips deleteProperties action", () => {
    const rule = minimalRule({ then: { deleteProperties: ["legacy_id"] } });
    const rt = roundTrip(rule);
    expect(rt?.then.deleteProperties).toEqual(["legacy_id"]);
  });

  it("round-trips advanced property actions", () => {
    const rule = minimalRule({
      then: {
        initProperties: { status: "new" },
        appendToProperty: { notes: "reviewed" },
      },
    });
    const rt = roundTrip(rule);
    expect(rt?.then.initProperties).toEqual({ status: "new" });
    expect(rt?.then.appendToProperty).toEqual({ notes: "reviewed" });
  });

  it("round-trips stopOnMatch: true", () => {
    const rule = minimalRule({ stopOnMatch: true });
    const rt = roundTrip(rule);
    expect(rt?.stopOnMatch).toBe(true);
  });

  it("round-trips runOn: 'sweep'", () => {
    const rule = minimalRule({ runOn: "sweep" });
    const rt = roundTrip(rule);
    expect(rt?.runOn).toBe("sweep");
  });

  it("round-trips a 'not' predicate (negated criterion node)", () => {
    const rule = minimalRule({
      when: { type: "not", predicate: { type: "tag", tag: "archived" } },
    });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual({ type: "not", predicate: { type: "tag", tag: "archived" } });
  });

  it("returns null for deeply nested 'not' predicate (not editable via UI)", () => {
    const rule = minimalRule({
      when: { type: "not", predicate: { type: "not", predicate: { type: "tag", tag: "archived" } } },
    });
    const draft = draftFromRule(rule);
    expect(draft).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-condition rules
// ---------------------------------------------------------------------------

describe("createRuleFromDraft — multi-condition", () => {
  it("creates an all-of rule from multiple criteria", () => {
    const draft = baseDraft({
      criteriaMode: "all",
      criteria: [
        {
          predicateType: "tag", tag: "project",
          pathGlob: "", basenamePattern: "", frontmatterValueProperty: "",
          frontmatterValueValue: "", frontmatterContainsSearchValue: "",
          sourceUrlProperty: "source", sourceUrlHost: "", fileAgeField: "mtime",
          fileAgeOlderThanDays: "", fileAgeNewerThanDays: "", contentContainsText: "",
          frontmatterRegexPattern: "", frontmatterDateAgeProperty: "",
          wordCountMoreThan: "", wordCountLessThan: "", tagPrefixValue: "", contentRegexPattern: "",
        },
        {
          predicateType: "frontmatterExists", tag: "", pathGlob: "", basenamePattern: "",
          frontmatterValueProperty: "status", frontmatterValueValue: "",
          frontmatterContainsSearchValue: "", sourceUrlProperty: "source",
          sourceUrlHost: "", fileAgeField: "mtime", fileAgeOlderThanDays: "",
          fileAgeNewerThanDays: "", contentContainsText: "",
          frontmatterRegexPattern: "", frontmatterDateAgeProperty: "",
          wordCountMoreThan: "", wordCountLessThan: "", tagPrefixValue: "", contentRegexPattern: "",
        },
      ],
    });
    const result = createRuleFromDraft([], draft);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].when.type).toBe("all");
    }
  });

  it("creates an any-of rule from multiple criteria", () => {
    const draft = baseDraft({
      criteriaMode: "any",
      criteria: [
        {
          predicateType: "tag", tag: "wip",
          pathGlob: "", basenamePattern: "", frontmatterValueProperty: "",
          frontmatterValueValue: "", frontmatterContainsSearchValue: "",
          sourceUrlProperty: "source", sourceUrlHost: "", fileAgeField: "mtime",
          fileAgeOlderThanDays: "", fileAgeNewerThanDays: "", contentContainsText: "",
          frontmatterRegexPattern: "", frontmatterDateAgeProperty: "",
          wordCountMoreThan: "", wordCountLessThan: "", tagPrefixValue: "", contentRegexPattern: "",
        },
        {
          predicateType: "tag", tag: "draft",
          pathGlob: "", basenamePattern: "", frontmatterValueProperty: "",
          frontmatterValueValue: "", frontmatterContainsSearchValue: "",
          sourceUrlProperty: "source", sourceUrlHost: "", fileAgeField: "mtime",
          fileAgeOlderThanDays: "", fileAgeNewerThanDays: "", contentContainsText: "",
          frontmatterRegexPattern: "", frontmatterDateAgeProperty: "",
          wordCountMoreThan: "", wordCountLessThan: "", tagPrefixValue: "", contentRegexPattern: "",
        },
      ],
    });
    const result = createRuleFromDraft([], draft);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].when.type).toBe("any");
    }
  });
});

// ---------------------------------------------------------------------------
// updateRuleById
// ---------------------------------------------------------------------------

describe("updateRuleById", () => {
  it("updates an existing rule", () => {
    const existing = minimalRule({ id: "r1", name: "Old name" });
    const result = updateRuleById([existing], "r1", baseDraft({ name: "New name" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rules[0].name).toBe("New name");
      expect(result.rules[0].id).toBe("r1"); // id preserved
    }
  });

  it("returns error for non-existent id", () => {
    const result = updateRuleById([], "does-not-exist", baseDraft());
    expect(result.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// createDefaultRuleDraft
// ---------------------------------------------------------------------------

describe("createDefaultRuleDraft", () => {
  it("has replaceTagsEnabled: false by default", () => {
    const draft = createDefaultRuleDraft([]);
    expect(draft.replaceTagsEnabled).toBe(false);
  });

  it("has stopOnMatch: false by default", () => {
    const draft = createDefaultRuleDraft([]);
    expect(draft.stopOnMatch).toBe(false);
  });

  it("has runOn: 'always' by default", () => {
    const draft = createDefaultRuleDraft([]);
    expect(draft.runOn).toBe("always");
  });
});

// ---------------------------------------------------------------------------
// parseTags and parsePropertyList
// ---------------------------------------------------------------------------

describe("parseTags", () => {
  it("parses comma-separated tags", () => {
    expect(parseTags("wip, draft, project")).toEqual(["wip", "draft", "project"]);
  });

  it("strips # prefix", () => {
    expect(parseTags("#wip #draft")).toEqual(["wip", "draft"]);
  });

  it("deduplicates", () => {
    expect(parseTags("wip, wip, draft")).toEqual(["wip", "draft"]);
  });

  it("returns empty array for blank input", () => {
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("parsePropertyList", () => {
  it("parses comma-separated property names", () => {
    expect(parsePropertyList("legacy_id, old_field")).toEqual(["legacy_id", "old_field"]);
  });

  it("handles space-separated", () => {
    expect(parsePropertyList("a b c")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for blank", () => {
    expect(parsePropertyList("  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NOT toggle (negated criterion) support
// ---------------------------------------------------------------------------

describe("NOT toggle — negated criterion round-trips", () => {
  function roundTrip(rule: Rule): Rule | null {
    const draft = draftFromRule(rule);
    if (draft === null) return null;
    const result = createRuleFromDraft([], draft);
    if (result.status !== "ok") return null;
    return result.rules[0] ?? null;
  }

  it("round-trips not(tag) via conditionNodes", () => {
    const rule = minimalRule({ when: { type: "not", predicate: { type: "tag", tag: "archived" } } });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual({ type: "not", predicate: { type: "tag", tag: "archived" } });
  });

  it("round-trips not(frontmatterExists) via conditionNodes", () => {
    const rule = minimalRule({ when: { type: "not", predicate: { type: "frontmatterExists", property: "status" } } });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual({ type: "not", predicate: { type: "frontmatterExists", property: "status" } });
  });

  it("returns null for not(not(tag)) — too deep", () => {
    const rule = minimalRule({ when: { type: "not", predicate: { type: "not", predicate: { type: "tag", tag: "x" } } } });
    expect(draftFromRule(rule)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// predicateFromConditionNodes
// ---------------------------------------------------------------------------

describe("predicateFromConditionNodes", () => {
  function tagCriterionDraft(tag: string, negated = false) {
    return {
      predicateType: "tag" as const,
      negated,
      tag,
      pathGlob: "",
      basenamePattern: "",
      frontmatterValueProperty: "",
      frontmatterValueValue: "",
      frontmatterContainsSearchValue: "",
      sourceUrlProperty: "source",
      sourceUrlHost: "",
      fileAgeField: "mtime" as const,
      fileAgeOlderThanDays: "",
      fileAgeNewerThanDays: "",
      contentContainsText: "",
      frontmatterRegexPattern: "",
      frontmatterDateAgeProperty: "",
      wordCountMoreThan: "",
      wordCountLessThan: "",
      tagPrefixValue: "",
      contentRegexPattern: "",
    };
  }

  function tagNode(tag: string, negated = false): VisualConditionNode {
    return { kind: "criterion", criterion: tagCriterionDraft(tag, negated) };
  }

  it("single non-negated criterion → bare predicate", () => {
    const result = predicateFromConditionNodes([tagNode("project")], "all");
    expect(result).toEqual({ type: "tag", tag: "project" });
  });

  it("single negated criterion → not(predicate)", () => {
    const result = predicateFromConditionNodes([tagNode("archived", true)], "all");
    expect(result).toEqual({ type: "not", predicate: { type: "tag", tag: "archived" } });
  });

  it("multiple criteria → all(…)", () => {
    const result = predicateFromConditionNodes([tagNode("a"), tagNode("b")], "all");
    expect(result).toEqual({ type: "all", predicates: [{ type: "tag", tag: "a" }, { type: "tag", tag: "b" }] });
  });

  it("multiple criteria → any(…) when topMode is any", () => {
    const result = predicateFromConditionNodes([tagNode("a"), tagNode("b")], "any");
    expect(result).toEqual({ type: "any", predicates: [{ type: "tag", tag: "a" }, { type: "tag", tag: "b" }] });
  });

  it("group node → compound predicate", () => {
    const node: VisualConditionNode = {
      kind: "group",
      group: {
        mode: "any",
        conditions: [tagCriterionDraft("x"), tagCriterionDraft("y")],
        negated: false,
      },
    };
    const result = predicateFromConditionNodes([node], "all");
    expect(result).toEqual({ type: "any", predicates: [{ type: "tag", tag: "x" }, { type: "tag", tag: "y" }] });
  });

  it("negated group node → not(compound)", () => {
    const node: VisualConditionNode = {
      kind: "group",
      group: {
        mode: "all",
        conditions: [tagCriterionDraft("x"), tagCriterionDraft("y")],
        negated: true,
      },
    };
    const result = predicateFromConditionNodes([node], "all");
    expect(result).toEqual({
      type: "not",
      predicate: { type: "all", predicates: [{ type: "tag", tag: "x" }, { type: "tag", tag: "y" }] },
    });
  });

  it("returns error string for empty nodes list", () => {
    expect(predicateFromConditionNodes([], "all")).toBe("At least one condition is required.");
  });

  it("returns error string for empty group", () => {
    const node: VisualConditionNode = { kind: "group", group: { mode: "all", conditions: [], negated: false } };
    expect(predicateFromConditionNodes([node], "all")).toBe("Each condition group must have at least one condition.");
  });
});

// ---------------------------------------------------------------------------
// draftFromRule — compound predicate round-trips via conditionNodes
// ---------------------------------------------------------------------------

describe("draftFromRule — compound predicate round-trips", () => {
  function roundTrip(rule: Rule): Rule | null {
    const draft = draftFromRule(rule);
    if (draft === null) return null;
    const result = createRuleFromDraft([], draft);
    if (result.status !== "ok") return null;
    return result.rules[0] ?? null;
  }

  it("round-trips all([tag, frontmatterExists])", () => {
    const rule = minimalRule({
      when: {
        type: "all",
        predicates: [
          { type: "tag", tag: "project" },
          { type: "frontmatterExists", property: "status" },
        ],
      },
    });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual(rule.when);
  });

  it("round-trips any([not(tag), tag])", () => {
    const rule = minimalRule({
      when: {
        type: "any",
        predicates: [
          { type: "not", predicate: { type: "tag", tag: "archived" } },
          { type: "tag", tag: "active" },
        ],
      },
    });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual(rule.when);
  });

  it("round-trips not(all([tag, tag])) — negated group", () => {
    const rule = minimalRule({
      when: {
        type: "not",
        predicate: {
          type: "all",
          predicates: [{ type: "tag", tag: "a" }, { type: "tag", tag: "b" }],
        },
      },
    });
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual(rule.when);
  });

  it("round-trips all([tag, all([tag, tag])]) — top-level with nested group", () => {
    const rule = minimalRule({
      when: {
        type: "all",
        predicates: [
          { type: "tag", tag: "outer" },
          { type: "all", predicates: [{ type: "tag", tag: "a" }, { type: "tag", tag: "b" }] },
        ],
      },
    });
    // The nested all becomes a group node; round-trip should reconstruct the same predicate
    const rt = roundTrip(rule);
    expect(rt?.when).toEqual(rule.when);
  });

  it("returns null for all([all([all([tag])])]) — too deep", () => {
    const rule = minimalRule({
      when: {
        type: "all",
        predicates: [
          { type: "all", predicates: [{ type: "all", predicates: [{ type: "tag", tag: "x" }] }] },
        ],
      },
    });
    expect(draftFromRule(rule)).toBeNull();
  });
});
