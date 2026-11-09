import type { Rule } from "../engine";
import { sanitizeRules } from "./settings";
import { ruleConvergenceWarnings } from "./rule-warnings";

export const RULE_IMPORT_SCHEMA_VERSION = 3;
export const MAX_RULE_IMPORT_TEXT_LENGTH = 1_000_000;

export interface RuleExportEnvelope {
  readonly schemaVersion: typeof RULE_IMPORT_SCHEMA_VERSION;
  readonly pluginVersion: string;
  readonly rules: readonly Rule[];
}

export interface RuleImportIssue {
  readonly severity: "warning" | "error";
  readonly kind: "duplicate-id" | "dropped-rule" | "sanitized-rule" | "repetition-warning";
  readonly message: string;
  readonly index: number;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
}

export type RuleImportResult =
  | {
    readonly status: "success";
    readonly rules: readonly Rule[];
    readonly sanitized: boolean;
    readonly details: RuleImportDetails;
  }
  | {
    readonly status: "error";
    readonly error: string;
    readonly details?: RuleImportDetails;
  };

export interface RuleImportDetails {
  readonly schemaVersion: number | null;
  readonly pluginVersion: string | null;
  readonly inputRuleCount: number;
  readonly importedRuleCount: number;
  readonly droppedRuleCount: number;
  readonly sanitized: boolean;
  readonly warnings: readonly string[];
  readonly issues: readonly RuleImportIssue[];
}

export function formatRuleExport(rules: readonly Rule[], pluginVersion: string): string {
  const envelope: RuleExportEnvelope = { schemaVersion: RULE_IMPORT_SCHEMA_VERSION, pluginVersion, rules };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function formatRuleImportReport(details: RuleImportDetails): string {
  const lines = [
    `Import contains ${details.inputRuleCount} rule(s); ${details.importedRuleCount} valid rule(s) will be imported.`,
    ...(details.schemaVersion === null ? [] : [`Schema version: ${details.schemaVersion}.`]),
    ...(details.pluginVersion === null ? [] : [`Exported by plugin version: ${details.pluginVersion}.`]),
    ...(details.droppedRuleCount === 0 ? [] : [`Dropped ${details.droppedRuleCount} invalid or duplicate rule(s).`]),
  ];

  for (const issue of details.issues) {
    lines.push(`- ${issue.message}`);
  }

  return lines.join("\n");
}

export function parseRuleImport(text: string): RuleImportResult {
  if (text.trim().length === 0) {
    return { status: "error", error: "Paste rule JSON before importing." };
  }

  if (text.length > MAX_RULE_IMPORT_TEXT_LENGTH) {
    return { status: "error", error: "Rule import is too large." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "error", error: "Rule import is not valid JSON." };
  }

  const metadata = readImportMetadata(parsed);
  if (metadata.status === "unsupported-future") {
    return {
      status: "error",
      error: `Rule import uses unsupported schemaVersion ${metadata.schemaVersion}; this plugin supports schemaVersion ${RULE_IMPORT_SCHEMA_VERSION}.`,
    };
  }
  if (metadata.status === "invalid") {
    return { status: "error", error: "Rule import schemaVersion must be a positive integer." };
  }

  const rulesValue = readImportRulesValue(parsed);
  if (rulesValue === null) {
    return { status: "error", error: "Rule import must be a JSON array or an object with a rules array." };
  }

  const result = sanitizeRules(rulesValue, []);
  const droppedRuleCount = rulesValue.length - result.rules.length;
  const issues = buildImportIssues(rulesValue);
  const details: RuleImportDetails = {
    schemaVersion: metadata.schemaVersion,
    pluginVersion: metadata.pluginVersion,
    inputRuleCount: rulesValue.length,
    importedRuleCount: result.rules.length,
    droppedRuleCount,
    sanitized: result.sanitized,
    warnings: [
      ...(droppedRuleCount > 0 ? [`Dropped ${droppedRuleCount} invalid or duplicate rule(s).`] : []),
      ...(result.sanitized ? ["Sanitized one or more imported rule fields."] : []),
    ],
    issues,
  };

  if (rulesValue.length > 0 && result.rules.length === 0) {
    return { status: "error", error: "Rule import did not contain any valid rules.", details };
  }

  return { status: "success", rules: result.rules, sanitized: result.sanitized, details };
}

function buildImportIssues(inputRules: readonly unknown[]): readonly RuleImportIssue[] {
  const issues: RuleImportIssue[] = [];
  const seenInputIds = new Set<string>();

  inputRules.forEach((inputRule, index) => {
    const ruleId = readTrimmedString(isRecord(inputRule) ? inputRule.id : undefined);
    const ruleName = readTrimmedString(isRecord(inputRule) ? inputRule.name : undefined);
    const singleRuleResult = sanitizeRules([inputRule], []);
    const normalizedRule = singleRuleResult.rules[0];

    if (normalizedRule === undefined) {
      issues.push({
        severity: "error",
        kind: "dropped-rule",
        message: `Dropped invalid rule at index ${index}${formatRuleLabel(ruleName)}.`,
        index,
        ruleId,
        ruleName,
      });
      return;
    }

    if (seenInputIds.has(normalizedRule.id)) {
      issues.push({
        severity: "warning",
        kind: "duplicate-id",
        message: `Dropped duplicate rule ID ${JSON.stringify(normalizedRule.id)}${formatRuleLabel(ruleName)}.`,
        index,
        ruleId: normalizedRule.id,
        ruleName,
      });
      return;
    }

    seenInputIds.add(normalizedRule.id);
    for (const warning of ruleConvergenceWarnings(normalizedRule)) {
      issues.push({ severity: "warning", kind: "repetition-warning", message: `${normalizedRule.name}: ${warning}`,
        index, ruleId: normalizedRule.id, ruleName: normalizedRule.name });
    }

    if (stableStringify(inputRule) !== stableStringify(normalizedRule)) {
      issues.push({
        severity: "warning",
        kind: "sanitized-rule",
        message: `Sanitized imported rule ${JSON.stringify(normalizedRule.name)} (${normalizedRule.id}).`,
        index,
        ruleId: normalizedRule.id,
        ruleName: normalizedRule.name,
      });
    }
  });

  return issues;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatRuleLabel(ruleName: string | null): string {
  return ruleName === null ? "" : ` (${JSON.stringify(ruleName)})`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (isRecord(value)) {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }

  return value;
}

function readImportRulesValue(value: unknown): unknown[] | null {
  const source: unknown = isRecord(value) ? value.rules : value;
  if (!Array.isArray(source)) {
    return null;
  }

  const rules: unknown[] = [];
  for (const item of source as unknown[]) {
    rules.push(item);
  }
  return rules;
}

function readImportMetadata(value: unknown):
  | { readonly status: "ok"; readonly schemaVersion: number | null; readonly pluginVersion: string | null }
  | { readonly status: "invalid"; readonly schemaVersion: null; readonly pluginVersion: string | null }
  | { readonly status: "unsupported-future"; readonly schemaVersion: number; readonly pluginVersion: string | null } {
  if (!isRecord(value)) {
    return { status: "ok", schemaVersion: null, pluginVersion: null };
  }

  const pluginVersion = typeof value.pluginVersion === "string" && value.pluginVersion.length > 0 ? value.pluginVersion : null;

  if (value.schemaVersion === undefined) {
    return { status: "ok", schemaVersion: null, pluginVersion };
  }

  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    return { status: "invalid", schemaVersion: null, pluginVersion };
  }

  if (schemaVersion > RULE_IMPORT_SCHEMA_VERSION) {
    return { status: "unsupported-future", schemaVersion, pluginVersion };
  }

  return { status: "ok", schemaVersion, pluginVersion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
