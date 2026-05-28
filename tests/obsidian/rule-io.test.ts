import { describe, expect, it } from "vitest";
import type { Rule } from "../../src/engine";
import { formatRuleExport, formatRuleImportReport, MAX_RULE_IMPORT_TEXT_LENGTH, parseRuleImport } from "../../src/obsidian/rule-io";

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

describe("rule import/export", () => {
  const pluginVersion = "9.8.7";

  it("exports a versioned envelope with plugin version", () => {
    const exported = JSON.parse(formatRuleExport([minimalRule()], pluginVersion)) as Record<string, unknown>;

    expect(exported.schemaVersion).toBe(2);
    expect(exported.pluginVersion).toBe(pluginVersion);
    expect(exported.rules).toEqual([minimalRule()]);
  });

  it("imports versioned envelopes", () => {
    const result = parseRuleImport(formatRuleExport([minimalRule()], pluginVersion));

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      return;
    }
    expect(result.rules).toEqual([minimalRule()]);
    expect(result.details.schemaVersion).toBe(2);
    expect(result.details.pluginVersion).toBe(pluginVersion);
  });

  it("keeps compatibility with bare rule arrays", () => {
    const result = parseRuleImport(JSON.stringify([minimalRule()]));

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      return;
    }
    expect(result.rules).toEqual([minimalRule()]);
    expect(result.details.schemaVersion).toBeNull();
  });

  it("keeps compatibility with legacy rules objects", () => {
    const result = parseRuleImport(JSON.stringify({ rules: [minimalRule()] }));

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      return;
    }
    expect(result.rules).toEqual([minimalRule()]);
    expect(result.details.schemaVersion).toBeNull();
  });

  it("rejects future schema versions", () => {
    const result = parseRuleImport(JSON.stringify({ schemaVersion: 3, rules: [minimalRule()] }));

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      return;
    }
    expect(result.error).toBe("Rule import uses unsupported schemaVersion 3; this plugin supports schemaVersion 2.");
  });

  it("rejects invalid schema versions", () => {
    const result = parseRuleImport(JSON.stringify({ schemaVersion: "1", rules: [minimalRule()] }));

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      return;
    }
    expect(result.error).toBe("Rule import schemaVersion must be a positive integer.");
  });

  it("rejects imports over the text size limit", () => {
    const result = parseRuleImport(`${JSON.stringify({ rules: [] })}${" ".repeat(MAX_RULE_IMPORT_TEXT_LENGTH)}`);

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      return;
    }
    expect(result.error).toBe("Rule import is too large.");
  });

  it("reports validation details for dropped and sanitized rules", () => {
    const result = parseRuleImport(JSON.stringify({ rules: [minimalRule({ id: " r1 ", name: " Rule 1 " }), minimalRule(), { id: "bad", name: "Bad Rule" }] }));

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      return;
    }
    expect(result.rules).toEqual([minimalRule()]);
    expect(result.sanitized).toBe(true);
    expect(result.details.inputRuleCount).toBe(3);
    expect(result.details.importedRuleCount).toBe(1);
    expect(result.details.droppedRuleCount).toBe(2);
    expect(result.details.warnings).toContain("Dropped 2 invalid or duplicate rule(s).");
    expect(result.details.issues).toEqual([
      {
        severity: "warning",
        kind: "sanitized-rule",
        message: "Sanitized imported rule \"Rule 1\" (r1).",
        index: 0,
        ruleId: "r1",
        ruleName: "Rule 1",
      },
      {
        severity: "warning",
        kind: "duplicate-id",
        message: "Dropped duplicate rule ID \"r1\" (\"Rule 1\").",
        index: 1,
        ruleId: "r1",
        ruleName: "Rule 1",
      },
      {
        severity: "error",
        kind: "dropped-rule",
        message: "Dropped invalid rule at index 2 (\"Bad Rule\").",
        index: 2,
        ruleId: "bad",
        ruleName: "Bad Rule",
      },
    ]);
  });

  it("formats a validation report before applying imports", () => {
    const result = parseRuleImport(JSON.stringify({ schemaVersion: 1, pluginVersion: "0.1.0", rules: [minimalRule(), minimalRule()] }));

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      return;
    }

    expect(formatRuleImportReport(result.details)).toContain("Import contains 2 rule(s); 1 valid rule(s) will be imported.");
    expect(formatRuleImportReport(result.details)).toContain("Schema version: 1.");
    expect(formatRuleImportReport(result.details)).toContain("Dropped duplicate rule ID \"r1\"");
  });
});
