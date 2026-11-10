import { compileRuleRegex } from "../engine/rule-regex";
import type { FrontmatterValue, Rule, RuleActionSet, RulePredicate, RuleRunOn } from "../engine";

export type EditablePredicateType =
  | "tag"
  | "pathGlob"
  | "basename"
  | "frontmatterValue"
  | "frontmatterExists"
  | "frontmatterMissing"
  | "frontmatterContains"
  | "sourceUrl"
  | "fileAge"
  | "bodyH1"
  | "contentContains"
  | "frontmatterRegex"
  | "frontmatterDateAge"
  | "wordCount"
  | "tagPrefix"
  | "contentRegex";

export interface RuleSummary {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly priority: number;
  readonly order: number;
  readonly predicate: string;
  readonly actions: string;
  readonly stopOnMatch: boolean;
  readonly runOn: RuleRunOn;
}

export interface VisualCriterionDraft {
  readonly predicateType: EditablePredicateType;
  /** When true the predicate is wrapped in a `not` at build time. Default: false. */
  readonly negated?: boolean;
  // tag
  readonly tag: string;
  // pathGlob
  readonly pathGlob: string;
  // basename / bodyH1
  readonly basenamePattern: string;
  // frontmatterValue / frontmatterExists / frontmatterMissing / frontmatterContains
  readonly frontmatterValueProperty: string;
  readonly frontmatterValueValue: string;
  readonly frontmatterContainsSearchValue: string;
  // sourceUrl
  readonly sourceUrlProperty: string;
  readonly sourceUrlHost: string;
  // fileAge
  readonly fileAgeField: "ctime" | "mtime";
  readonly fileAgeOlderThanDays: string;
  readonly fileAgeNewerThanDays: string;
  // bodyH1 — reuses basenamePattern field
  // contentContains
  readonly contentContainsText: string;
  // frontmatterRegex — property reuses frontmatterValueProperty
  readonly frontmatterRegexPattern: string;
  // frontmatterDateAge
  readonly frontmatterDateAgeProperty: string;
  // wordCount
  readonly wordCountMoreThan: string;
  readonly wordCountLessThan: string;
  // tagPrefix
  readonly tagPrefixValue: string;
  // contentRegex
  readonly contentRegexPattern: string;
}

export interface VisualConditionGroup {
  readonly mode: "all" | "any";
  readonly conditions: readonly VisualCriterionDraft[];
  /** When true the whole group is wrapped in `not`. */
  readonly negated?: boolean;
}

export type VisualConditionNode =
  | { readonly kind: "criterion"; readonly criterion: VisualCriterionDraft }
  | { readonly kind: "group"; readonly group: VisualConditionGroup };

export interface VisualRuleDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: string;
  readonly order: string;
  readonly criteriaMode?: "all" | "any";
  readonly criteria?: readonly VisualCriterionDraft[];
  /** When present, takes precedence over `criteria` for building the predicate. */
  readonly conditionNodes?: readonly VisualConditionNode[];
  readonly stopOnMatch: boolean;
  readonly dryRun: boolean;
  readonly runOn: RuleRunOn;
  /** Compatibility mirror of the first criterion. */
  readonly predicateType: EditablePredicateType;
  readonly tag: string;
  readonly pathGlob: string;
  readonly basenamePattern: string;
  readonly frontmatterValueProperty: string;
  readonly frontmatterValueValue: string;
  readonly frontmatterContainsSearchValue: string;
  readonly sourceUrlProperty: string;
  readonly sourceUrlHost: string;
  readonly fileAgeField: "ctime" | "mtime";
  readonly fileAgeOlderThanDays: string;
  readonly fileAgeNewerThanDays: string;
  readonly contentContainsText: string;
  readonly frontmatterRegexPattern: string;
  readonly frontmatterDateAgeProperty: string;
  readonly wordCountMoreThan: string;
  readonly wordCountLessThan: string;
  readonly tagPrefixValue: string;
  readonly contentRegexPattern: string;
  // Actions
  readonly moveTo: string;
  readonly moveToKind?: "auto" | "folder" | "file";
  readonly renameTo: string;
  readonly addTags: string;
  readonly removeTags: string;
  readonly replaceTags: string;
  /** When false, the replaceTags action is not applied regardless of the replaceTags string. */
  readonly replaceTagsEnabled: boolean;
  readonly setPropertiesJson: string;
  readonly initPropertiesJson: string;
  readonly appendToPropertyJson: string;
  readonly deletePropertiesList: string;
}

export type RuleEditResult =
  | { readonly status: "ok"; readonly rules: readonly Rule[] }
  | { readonly status: "error"; readonly error: string };

export type SetPropertiesParseResult =
  | { readonly status: "ok"; readonly setProperties: Readonly<Record<string, FrontmatterValue>> | undefined }
  | { readonly status: "error"; readonly error: string };

export type AppendToPropertyParseResult =
  | { readonly status: "ok"; readonly appendToProperty: Readonly<Record<string, string>> | undefined }
  | { readonly status: "error"; readonly error: string };

export function summarizeRule(rule: Rule): RuleSummary {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    status: rule.enabled ? "Enabled" : "Disabled",
    priority: rule.priority,
    order: rule.order,
    predicate: summarizePredicate(rule.when),
    actions: summarizeActionSet(rule.then),
    stopOnMatch: rule.stopOnMatch ?? false,
    runOn: rule.runOn ?? "always",
  };
}

export function summarizePredicate(predicate: RulePredicate): string {
  switch (predicate.type) {
    case "tag":
      return `tag is ${formatTag(predicate.tag)}`;
    case "pathGlob":
      return `path matches ${quote(predicate.glob)}`;
    case "basename":
      return `basename matches /${predicate.pattern}/i`;
    case "frontmatterValue":
      return `${predicate.property} == ${JSON.stringify(predicate.value)}`;
    case "frontmatterExists":
      return `${predicate.property} exists`;
    case "frontmatterMissing":
      return `${predicate.property} is missing`;
    case "frontmatterContains":
      return `${predicate.property} contains ${quote(predicate.value)}`;
    case "sourceUrl":
      return `${predicate.property} URL host is ${quote(predicate.host)}`;
    case "fileAge": {
      const parts: string[] = [`${predicate.field}`];
      if (predicate.olderThanDays !== undefined) {
        parts.push(`older than ${predicate.olderThanDays}d`);
      }
      if (predicate.newerThanDays !== undefined) {
        parts.push(`newer than ${predicate.newerThanDays}d`);
      }
      return `file age (${parts.join(", ")})`;
    }
    case "bodyH1":
      return `H1 heading matches /${predicate.pattern}/i`;
    case "contentContains":
      return `content contains ${quote(predicate.text)}`;
    case "frontmatterRegex":
      return `${predicate.property} matches /${predicate.pattern}/i`;
    case "frontmatterDateAge": {
      const fdaParts: string[] = [`${predicate.property}`];
      if (predicate.olderThanDays !== undefined) {
        fdaParts.push(`older than ${predicate.olderThanDays}d`);
      }
      if (predicate.newerThanDays !== undefined) {
        fdaParts.push(`newer than ${predicate.newerThanDays}d`);
      }
      return `frontmatter date (${fdaParts.join(", ")})`;
    }
    case "wordCount": {
      const wcParts: string[] = [];
      if (predicate.moreThan !== undefined) {
        wcParts.push(`> ${predicate.moreThan}`);
      }
      if (predicate.lessThan !== undefined) {
        wcParts.push(`< ${predicate.lessThan}`);
      }
      return `word count (${wcParts.join(", ") || "any"})`;
    }
    case "tagPrefix":
      return `tag starts with ${formatTag(predicate.prefix)}`;
    case "contentRegex":
      return `content matches /${predicate.pattern}/i`;
    case "all":
      return summarizeCompoundPredicate("all", predicate.predicates);
    case "any":
      return summarizeCompoundPredicate("any", predicate.predicates);
    case "not":
      return `not (${summarizePredicate(predicate.predicate)})`;
  }
}

export function summarizeActionSet(actionSet: RuleActionSet): string {
  const actions: string[] = [];

  if (actionSet.moveTo !== undefined) {
    actions.push(`move to ${actionSet.moveToKind === undefined || actionSet.moveToKind === "auto" ? "" : `${actionSet.moveToKind} `}${quote(actionSet.moveTo)}`);
  }

  if (actionSet.renameTo !== undefined) {
    actions.push(`rename to ${quote(actionSet.renameTo)}`);
  }

  if (actionSet.addTags !== undefined && actionSet.addTags.length > 0) {
    actions.push(`add tags ${actionSet.addTags.map(formatTag).join(", ")}`);
  }

  if (actionSet.removeTags !== undefined && actionSet.removeTags.length > 0) {
    actions.push(`remove tags ${actionSet.removeTags.map(formatTag).join(", ")}`);
  }

  if (actionSet.replaceTags !== undefined) {
    if (actionSet.replaceTags.length > 0) {
      actions.push(`replace tags with ${actionSet.replaceTags.map(formatTag).join(", ")}`);
    } else {
      actions.push("remove all tags");
    }
  }

  if (actionSet.setProperties !== undefined) {
    const propertySummaries = Object.entries(actionSet.setProperties)
      .map(([key, value]) => `${key}=${formatFrontmatterValue(value)}`);
    if (propertySummaries.length > 0) {
      actions.push(`set ${propertySummaries.join(", ")}`);
    }
  }

  if (actionSet.initProperties !== undefined) {
    const propertySummaries = Object.entries(actionSet.initProperties)
      .map(([key, value]) => `${key}=${formatFrontmatterValue(value)}`);
    if (propertySummaries.length > 0) {
      actions.push(`initialize ${propertySummaries.join(", ")}`);
    }
  }

  if (actionSet.appendToProperty !== undefined) {
    const propertySummaries = Object.entries(actionSet.appendToProperty)
      .map(([key, value]) => `${key}+=${quote(value)}`);
    if (propertySummaries.length > 0) {
      actions.push(`append ${propertySummaries.join(", ")}`);
    }
  }

  if (actionSet.deleteProperties !== undefined && actionSet.deleteProperties.length > 0) {
    actions.push(`delete ${actionSet.deleteProperties.join(", ")}`);
  }

  return actions.length > 0 ? actions.join("; ") : "No actions";
}

export function setRuleEnabled(rules: readonly Rule[], ruleId: string, enabled: boolean): readonly Rule[] {
  return rules.map((rule) => rule.id === ruleId ? { ...rule, enabled } : rule);
}

export function createRuleFromDraft(rules: readonly Rule[], draft: VisualRuleDraft): RuleEditResult {
  const ruleResult = ruleFromDraft(rules, draft, undefined);
  if (ruleResult.status === "error") {
    return ruleResult;
  }

  const appended = { ...ruleResult.rule, priority: rules.length === 0 ? ruleResult.rule.priority : Math.max(...rules.map((rule) => rule.priority)) + 1, order: nextRuleOrder(rules) };
  return { status: "ok", rules: [...rules, appended] };
}

export function updateRuleById(rules: readonly Rule[], ruleId: string, draft: VisualRuleDraft): RuleEditResult {
  const existingIndex = rules.findIndex((rule) => rule.id === ruleId);
  const existingRule = rules[existingIndex];
  if (existingRule === undefined) {
    return { status: "error", error: "Rule was not found." };
  }

  const ruleResult = ruleFromDraft(rules, draft, existingRule.id);
  if (ruleResult.status === "error") {
    return ruleResult;
  }

  return {
    status: "ok",
    rules: rules.map((rule) => rule.id === ruleId ? ruleResult.rule : rule),
  };
}

export function deleteRuleById(rules: readonly Rule[], ruleId: string): readonly Rule[] {
  return rules.filter((rule) => rule.id !== ruleId);
}

export function reorderRule(rules: readonly Rule[], draggedRuleId: string, targetRuleId: string): readonly Rule[] {
  const fromIndex = rules.findIndex((rule) => rule.id === draggedRuleId);
  const toIndex = rules.findIndex((rule) => rule.id === targetRuleId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return rules;
  }

  const reordered = [...rules];
  const [draggedRule] = reordered.splice(fromIndex, 1);
  if (draggedRule === undefined) {
    return rules;
  }
  reordered.splice(toIndex, 0, draggedRule);
  return reindexRules(reordered);
}

export function reindexRules(rules: readonly Rule[]): readonly Rule[] {
  return rules.map((rule, index) => ({
    ...rule,
    priority: index,
    order: index,
  }));
}

export function nextRuleOrder(rules: readonly Rule[]): number {
  if (rules.length === 0) {
    return 0;
  }

  return Math.max(...rules.map((rule) => rule.order)) + 1;
}

export function createDefaultRuleDraft(rules: readonly Rule[]): VisualRuleDraft {
  return {
    name: "",
    enabled: true,
    priority: String(rules.length === 0 ? 0 : Math.max(...rules.map((rule) => rule.priority)) + 1),
    order: String(nextRuleOrder(rules)),
    criteriaMode: "all",
    criteria: [],
    stopOnMatch: false,
    dryRun: false,
    runOn: "always",
    predicateType: "tag",
    tag: "",
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
  };
}

export function draftFromRule(rule: Rule): VisualRuleDraft | null {
  const nodesResult = conditionNodesFromPredicate(rule.when);
  if (nodesResult === null) {
    return null;
  }

  // Derive first criterion for top-level compat fields
  const firstNode = nodesResult[0];
  const firstCriterion: VisualCriterionDraft = (() => {
    if (firstNode?.kind === "criterion") return firstNode.criterion;
    if (firstNode?.kind === "group" && firstNode.group.conditions.length > 0) {
      return firstNode.group.conditions[0] ?? makeDefaultCriterion();
    }
    return makeDefaultCriterion();
  })();

  // Top-level criteria mode comes from the predicate when it is a compound
  const criteriaMode: "all" | "any" = rule.when.type === "any" ? "any" : "all";

  return {
    name: rule.name,
    enabled: rule.enabled,
    priority: String(rule.priority),
    order: String(rule.order),
    criteriaMode,
    conditionNodes: nodesResult,
    stopOnMatch: rule.stopOnMatch ?? false,
    dryRun: rule.dryRun ?? false,
    runOn: rule.runOn ?? "always",
    predicateType: firstCriterion.predicateType,
    tag: firstCriterion.tag,
    pathGlob: firstCriterion.pathGlob,
    basenamePattern: firstCriterion.basenamePattern,
    frontmatterValueProperty: firstCriterion.frontmatterValueProperty,
    frontmatterValueValue: firstCriterion.frontmatterValueValue,
    frontmatterContainsSearchValue: firstCriterion.frontmatterContainsSearchValue,
    sourceUrlProperty: firstCriterion.sourceUrlProperty,
    sourceUrlHost: firstCriterion.sourceUrlHost,
    fileAgeField: firstCriterion.fileAgeField,
    fileAgeOlderThanDays: firstCriterion.fileAgeOlderThanDays,
    fileAgeNewerThanDays: firstCriterion.fileAgeNewerThanDays,
    contentContainsText: firstCriterion.contentContainsText,
    frontmatterRegexPattern: firstCriterion.frontmatterRegexPattern,
    frontmatterDateAgeProperty: firstCriterion.frontmatterDateAgeProperty,
    wordCountMoreThan: firstCriterion.wordCountMoreThan,
    wordCountLessThan: firstCriterion.wordCountLessThan,
    tagPrefixValue: firstCriterion.tagPrefixValue,
    contentRegexPattern: firstCriterion.contentRegexPattern,
    moveTo: rule.then.moveTo ?? "",
    ...(rule.then.moveToKind === undefined ? {} : { moveToKind: rule.then.moveToKind }),
    renameTo: rule.then.renameTo ?? "",
    addTags: rule.then.addTags?.join(", ") ?? "",
    removeTags: rule.then.removeTags?.join(", ") ?? "",
    replaceTags: rule.then.replaceTags?.join(", ") ?? "",
    replaceTagsEnabled: rule.then.replaceTags !== undefined,
    setPropertiesJson: rule.then.setProperties === undefined ? "" : JSON.stringify(rule.then.setProperties, null, 2),
    initPropertiesJson: rule.then.initProperties === undefined ? "" : JSON.stringify(rule.then.initProperties, null, 2),
    appendToPropertyJson: rule.then.appendToProperty === undefined ? "" : JSON.stringify(rule.then.appendToProperty, null, 2),
    deletePropertiesList: rule.then.deleteProperties === undefined ? "" : JSON.stringify(rule.then.deleteProperties),
  };
}

export function parseTags(value: string): readonly string[] {
  const tags: string[] = [];
  for (const item of value.split(/[\s,]+/u)) {
    const tag = normalizeTag(item);
    if (tag.length > 0 && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}

export function parsePropertyList(value: string): readonly string[] {
  if (value.trim().startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item: unknown) => typeof item === "string" && item.length > 0)) {
      throw new Error("Delete properties must be a JSON array of nonempty property names.");
    }
    return parsed as string[];
  }
  return value.split(/[,\n]+/u).map((item) => item.trim()).filter((item) => item.length > 0);
}

export function parseSetPropertiesJson(value: string): SetPropertiesParseResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { status: "ok", setProperties: undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { status: "error", error: "Set properties must be valid JSON." };
  }

  const frontmatter = readFrontmatterRecord(parsed);
  if (frontmatter === null) {
    return { status: "error", error: "Set properties JSON must be an object whose values are strings, numbers, booleans, null, arrays of those values, or objects with those values." };
  }

  return { status: "ok", setProperties: frontmatter };
}

export function parseAppendToPropertyJson(value: string): AppendToPropertyParseResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { status: "ok", appendToProperty: undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { status: "error", error: "Append properties must be valid JSON." };
  }

  if (!isRecord(parsed)) {
    return { status: "error", error: "Append properties JSON must be an object whose values are strings." };
  }

  const result = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(parsed)) {
    if (isUnsafeObjectKey(key) || typeof item !== "string") {
      return { status: "error", error: "Append properties JSON must use safe property names and string values." };
    }
    result[key] = item;
  }

  return { status: "ok", appendToProperty: result };
}

function makeDefaultCriterion(): VisualCriterionDraft {
  return {
    predicateType: "tag",
    negated: false,
    tag: "",
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
  };
}

function ruleFromDraft(rules: readonly Rule[], draft: VisualRuleDraft, existingId?: string):
  | { readonly status: "ok"; readonly rule: Rule }
  | { readonly status: "error"; readonly error: string } {
  const name = draft.name.trim();
  if (name.length === 0) {
    return { status: "error", error: "Rule name is required." };
  }

  const priority = parseFiniteNumber(draft.priority, "Priority");
  if (typeof priority === "string") {
    return { status: "error", error: priority };
  }

  const order = parseFiniteNumber(draft.order, "Order");
  if (typeof order === "string") {
    return { status: "error", error: order };
  }

  const predicate = predicateFromDraft(draft);
  if (typeof predicate === "string") {
    return { status: "error", error: predicate };
  }

  const actionSet = actionSetFromDraft(draft);
  if (typeof actionSet === "string") {
    return { status: "error", error: actionSet };
  }

  const id = existingId ?? nextRuleId(rules, name);
  return {
    status: "ok",
    rule: {
      id,
      name,
      enabled: draft.enabled,
      priority,
      order,
      when: predicate,
      then: actionSet,
      ...(draft.stopOnMatch ? { stopOnMatch: true } : {}),
      ...(draft.dryRun ? { dryRun: true } : {}),
      ...(draft.runOn !== "always" ? { runOn: draft.runOn } : {}),
    },
  };
}

function predicateFromDraft(draft: VisualRuleDraft): RulePredicate | string {
  if (draft.conditionNodes !== undefined && draft.conditionNodes.length > 0) {
    return predicateFromConditionNodes(draft.conditionNodes, draft.criteriaMode ?? "all");
  }

  const criteria = draft.criteria !== undefined
    ? draft.criteria
    : [criterionFromDraftFields(draft)];

  if (criteria.length === 0) {
    return "At least one criterion is required.";
  }
  const predicates: RulePredicate[] = [];

  for (const criterion of criteria) {
    const predicate = predicateFromCriterion(criterion);
    if (typeof predicate === "string") {
      return predicate;
    }
    predicates.push(predicate);
  }

  if (predicates.length === 1) {
    return predicates[0] ?? "At least one criterion is required.";
  }

  return { type: draft.criteriaMode ?? "all", predicates };
}

function criterionFromDraftFields(draft: VisualRuleDraft): VisualCriterionDraft {
  return {
    predicateType: draft.predicateType,
    negated: false,
    tag: draft.tag,
    pathGlob: draft.pathGlob,
    basenamePattern: draft.basenamePattern,
    frontmatterValueProperty: draft.frontmatterValueProperty,
    frontmatterValueValue: draft.frontmatterValueValue,
    frontmatterContainsSearchValue: draft.frontmatterContainsSearchValue,
    sourceUrlProperty: draft.sourceUrlProperty,
    sourceUrlHost: draft.sourceUrlHost,
    fileAgeField: draft.fileAgeField,
    fileAgeOlderThanDays: draft.fileAgeOlderThanDays,
    fileAgeNewerThanDays: draft.fileAgeNewerThanDays,
    contentContainsText: draft.contentContainsText,
    frontmatterRegexPattern: draft.frontmatterRegexPattern,
    frontmatterDateAgeProperty: draft.frontmatterDateAgeProperty,
    wordCountMoreThan: draft.wordCountMoreThan,
    wordCountLessThan: draft.wordCountLessThan,
    tagPrefixValue: draft.tagPrefixValue,
    contentRegexPattern: draft.contentRegexPattern,
  };
}

function predicateFromCriterion(criterion: VisualCriterionDraft): RulePredicate | string {
  const bounds = criterion.predicateType === "fileAge" || criterion.predicateType === "frontmatterDateAge"
    ? [criterion.fileAgeOlderThanDays, criterion.fileAgeNewerThanDays]
    : criterion.predicateType === "wordCount" ? [criterion.wordCountMoreThan, criterion.wordCountLessThan] : [];
  if (bounds.some((value) => value.trim().length > 0 && parseOptionalPositiveDays(value) === undefined)) {
    return "Every nonempty numeric bound must be a finite number greater than zero.";
  }
  const result = predicateFromCriterionBase(criterion);
  if (typeof result === "string") return result;
  return criterion.negated ? { type: "not", predicate: result } : result;
}

function predicateFromCriterionBase(criterion: VisualCriterionDraft): RulePredicate | string {
  switch (criterion.predicateType) {
    case "tag": {
      const tag = normalizeTag(criterion.tag);
      return tag.length === 0 ? "Predicate tag is required." : { type: "tag", tag };
    }
    case "pathGlob": {
      const glob = criterion.pathGlob.trim();
      return glob.length === 0 ? "Path glob is required." : { type: "pathGlob", glob };
    }
    case "basename": {
      const pattern = criterion.basenamePattern.trim();
      if (pattern.length === 0) {
        return "Basename regex pattern is required.";
      }
      try {
        compileRuleRegex(pattern);
      } catch (error) {
        return "Basename pattern is not a valid regular expression. " + (error instanceof Error ? error.message : String(error));
      }
      return { type: "basename", pattern };
    }
    case "frontmatterValue": {
      const property = criterion.frontmatterValueProperty.trim();
      if (property.length === 0) {
        return "Property name is required.";
      }
      const rawValue = criterion.frontmatterValueValue.trim();
      const value = parseFrontmatterValueString(rawValue);
      return { type: "frontmatterValue", property, value };
    }
    case "frontmatterExists": {
      const property = criterion.frontmatterValueProperty.trim();
      return property.length === 0 ? "Property name is required." : { type: "frontmatterExists", property };
    }
    case "frontmatterMissing": {
      const property = criterion.frontmatterValueProperty.trim();
      return property.length === 0 ? "Property name is required." : { type: "frontmatterMissing", property };
    }
    case "frontmatterContains": {
      const property = criterion.frontmatterValueProperty.trim();
      if (property.length === 0) {
        return "Property name is required.";
      }
      return {
        type: "frontmatterContains",
        property,
        value: criterion.frontmatterContainsSearchValue,
      };
    }
    case "sourceUrl": {
      const property = criterion.sourceUrlProperty.trim();
      const host = criterion.sourceUrlHost.trim();
      if (property.length === 0) {
        return "Source URL property is required.";
      }
      return host.length === 0 ? "Source URL host is required." : { type: "sourceUrl", property, host };
    }
    case "fileAge": {
      const olderThan = parseOptionalPositiveDays(criterion.fileAgeOlderThanDays);
      const newerThan = parseOptionalPositiveDays(criterion.fileAgeNewerThanDays);
      if (olderThan === undefined && newerThan === undefined) {
        return "File age requires at least one of 'older than days' or 'newer than days'.";
      }
      return {
        type: "fileAge",
        field: criterion.fileAgeField,
        ...(olderThan !== undefined ? { olderThanDays: olderThan } : {}),
        ...(newerThan !== undefined ? { newerThanDays: newerThan } : {}),
      };
    }
    case "bodyH1": {
      const pattern = criterion.basenamePattern.trim();
      if (pattern.length === 0) {
        return "H1 heading regex pattern is required.";
      }
      try {
        compileRuleRegex(pattern);
      } catch (error) {
        return "H1 heading pattern is not a valid regular expression. " + (error instanceof Error ? error.message : String(error));
      }
      return { type: "bodyH1", pattern };
    }
    case "contentContains": {
      return {
        type: "contentContains",
        text: criterion.contentContainsText,
      };
    }
    case "frontmatterRegex": {
      const property = criterion.frontmatterValueProperty.trim();
      if (property.length === 0) {
        return "Property name is required.";
      }
      const pattern = criterion.frontmatterRegexPattern.trim();
      if (pattern.length === 0) {
        return "Frontmatter regex pattern is required.";
      }
      try {
        compileRuleRegex(pattern);
      } catch (error) {
        return "Frontmatter regex pattern is not a valid regular expression. " + (error instanceof Error ? error.message : String(error));
      }
      return { type: "frontmatterRegex", property, pattern };
    }
    case "frontmatterDateAge": {
      const property = criterion.frontmatterDateAgeProperty.trim();
      if (property.length === 0) {
        return "Property name is required.";
      }
      const olderThan = parseOptionalPositiveDays(criterion.fileAgeOlderThanDays);
      const newerThan = parseOptionalPositiveDays(criterion.fileAgeNewerThanDays);
      if (olderThan === undefined && newerThan === undefined) {
        return "Frontmatter date age requires at least one of 'older than days' or 'newer than days'.";
      }
      return {
        type: "frontmatterDateAge",
        property,
        ...(olderThan !== undefined ? { olderThanDays: olderThan } : {}),
        ...(newerThan !== undefined ? { newerThanDays: newerThan } : {}),
      };
    }
    case "wordCount": {
      const moreThan = parseOptionalPositiveDays(criterion.wordCountMoreThan);
      const lessThan = parseOptionalPositiveDays(criterion.wordCountLessThan);
      if (moreThan === undefined && lessThan === undefined) {
        return "Word count requires at least one of 'more than' or 'less than'.";
      }
      return {
        type: "wordCount",
        ...(moreThan !== undefined ? { moreThan } : {}),
        ...(lessThan !== undefined ? { lessThan } : {}),
      };
    }
    case "tagPrefix": {
      const prefix = criterion.tagPrefixValue.trim().replace(/^#+/u, "");
      return prefix.length === 0 ? "Tag prefix is required." : { type: "tagPrefix", prefix };
    }
    case "contentRegex": {
      const pattern = criterion.contentRegexPattern.trim();
      if (pattern.length === 0) {
        return "Content regex pattern is required.";
      }
      try {
        compileRuleRegex(pattern);
      } catch (error) {
        return "Content regex pattern is not a valid regular expression. " + (error instanceof Error ? error.message : String(error));
      }
      return { type: "contentRegex", pattern };
    }
  }
}

function parseOptionalPositiveDays(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const num = Number(trimmed);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function parseFrontmatterValueString(raw: string): string | number | boolean | null {
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch { /* Unquoted text remains supported for existing editor workflows. */ }
  }
  if (raw === "null") {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  const asNumber = Number(raw);
  if (raw.length > 0 && !isNaN(asNumber) && isFinite(asNumber)) {
    return asNumber;
  }
  return raw;
}

function actionSetFromDraft(draft: VisualRuleDraft): RuleActionSet | string {
  const setProperties = parseSetPropertiesJson(draft.setPropertiesJson);
  if (setProperties.status === "error") {
    return setProperties.error;
  }
  const initProperties = parseSetPropertiesJson(draft.initPropertiesJson);
  if (initProperties.status === "error") {
    return `Initialize properties: ${initProperties.error}`;
  }
  const appendToProperty = parseAppendToPropertyJson(draft.appendToPropertyJson);
  if (appendToProperty.status === "error") {
    return appendToProperty.error;
  }

  const moveTo = draft.moveTo.trim();
  if (moveTo.length > 0 && !isSafeMoveDestination(moveTo)) {
    return "Move destination cannot contain '..' path segments.";
  }

  const renameTo = draft.renameTo.trim();
  const addTags = parseTags(draft.addTags);
  const removeTags = parseTags(draft.removeTags);
  const replaceTags = draft.replaceTagsEnabled ? parseTags(draft.replaceTags) : undefined;
  let deleteProperties: readonly string[];
  try { deleteProperties = parsePropertyList(draft.deletePropertiesList); }
  catch { return "Delete properties must be a JSON string array or comma-separated property names."; }

  return {
    ...(moveTo.length === 0 ? {} : { moveTo, ...(draft.moveToKind === undefined || draft.moveToKind === "auto" ? {} : { moveToKind: draft.moveToKind }) }),
    ...(renameTo.length === 0 ? {} : { renameTo }),
    ...(addTags.length === 0 ? {} : { addTags }),
    ...(removeTags.length === 0 ? {} : { removeTags }),
    ...(replaceTags !== undefined ? { replaceTags } : {}),
    ...(setProperties.setProperties === undefined ? {} : { setProperties: setProperties.setProperties }),
    ...(initProperties.setProperties === undefined ? {} : { initProperties: initProperties.setProperties }),
    ...(appendToProperty.appendToProperty === undefined ? {} : { appendToProperty: appendToProperty.appendToProperty }),
    ...(deleteProperties.length === 0 ? {} : { deleteProperties }),
  };
}

function parseFiniteNumber(value: string, label: string): number | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${label} is required.`;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : `${label} must be a number.`;
}

function nextRuleId(rules: readonly Rule[], name: string): string {
  const baseId = slugify(name);
  const usedIds = new Set(rules.map((rule) => rule.id));
  if (!usedIds.has(baseId)) {
    return baseId;
  }

  let suffix = 2;
  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length === 0 ? "rule" : slug;
}

function editableCriterionDraft(predicate: RulePredicate): VisualCriterionDraft | null {
  const base = makeDefaultCriterion();
  switch (predicate.type) {
    case "tag":
      return { ...base, predicateType: "tag", tag: predicate.tag };
    case "pathGlob":
      return { ...base, predicateType: "pathGlob", pathGlob: predicate.glob };
    case "basename":
      return { ...base, predicateType: "basename", basenamePattern: predicate.pattern };
    case "frontmatterValue":
      return { ...base, predicateType: "frontmatterValue", frontmatterValueProperty: predicate.property, frontmatterValueValue: JSON.stringify(predicate.value) };
    case "frontmatterExists":
      return { ...base, predicateType: "frontmatterExists", frontmatterValueProperty: predicate.property };
    case "frontmatterMissing":
      return { ...base, predicateType: "frontmatterMissing", frontmatterValueProperty: predicate.property };
    case "frontmatterContains":
      return { ...base, predicateType: "frontmatterContains", frontmatterValueProperty: predicate.property, frontmatterContainsSearchValue: predicate.value };
    case "sourceUrl":
      return { ...base, predicateType: "sourceUrl", sourceUrlProperty: predicate.property, sourceUrlHost: predicate.host };
    case "fileAge":
      return {
        ...base,
        predicateType: "fileAge",
        fileAgeField: predicate.field,
        fileAgeOlderThanDays: predicate.olderThanDays !== undefined ? String(predicate.olderThanDays) : "",
        fileAgeNewerThanDays: predicate.newerThanDays !== undefined ? String(predicate.newerThanDays) : "",
      };
    case "bodyH1":
      return { ...base, predicateType: "bodyH1", basenamePattern: predicate.pattern };
    case "contentContains":
      return { ...base, predicateType: "contentContains", contentContainsText: predicate.text };
    case "frontmatterRegex":
      return { ...base, predicateType: "frontmatterRegex", frontmatterValueProperty: predicate.property, frontmatterRegexPattern: predicate.pattern };
    case "frontmatterDateAge":
      return {
        ...base,
        predicateType: "frontmatterDateAge",
        frontmatterDateAgeProperty: predicate.property,
        fileAgeOlderThanDays: predicate.olderThanDays !== undefined ? String(predicate.olderThanDays) : "",
        fileAgeNewerThanDays: predicate.newerThanDays !== undefined ? String(predicate.newerThanDays) : "",
      };
    case "wordCount":
      return {
        ...base,
        predicateType: "wordCount",
        wordCountMoreThan: predicate.moreThan !== undefined ? String(predicate.moreThan) : "",
        wordCountLessThan: predicate.lessThan !== undefined ? String(predicate.lessThan) : "",
      };
    case "tagPrefix":
      return { ...base, predicateType: "tagPrefix", tagPrefixValue: predicate.prefix };
    case "contentRegex":
      return { ...base, predicateType: "contentRegex", contentRegexPattern: predicate.pattern };
    case "all":
    case "any":
      return null;
    case "not": {
      // Extract one-level negation: not(simple) → inner criterion with negated:true
      const inner = predicate.predicate;
      if (inner.type !== "not" && inner.type !== "all" && inner.type !== "any") {
        const innerCriterion = editableCriterionDraft(inner);
        return innerCriterion === null ? null : { ...innerCriterion, negated: true };
      }
      return null;
    }
  }
}

/**
 * Build a `RulePredicate` from a flat/nested list of condition nodes.
 * When `conditionNodes` is set on a draft this is used instead of the old `criteria` array.
 */
export function predicateFromConditionNodes(
  nodes: readonly VisualConditionNode[],
  topMode: "all" | "any",
): RulePredicate | string {
  if (nodes.length === 0) {
    return "At least one condition is required.";
  }

  const predicates: RulePredicate[] = [];
  for (const node of nodes) {
    if (node.kind === "criterion") {
      const p = predicateFromCriterion(node.criterion);
      if (typeof p === "string") return p;
      predicates.push(p);
    } else {
      const { group } = node;
      if (group.conditions.length === 0) {
        return "Each condition group must have at least one condition.";
      }
      const groupPredicates: RulePredicate[] = [];
      for (const c of group.conditions) {
        const p = predicateFromCriterion(c);
        if (typeof p === "string") return p;
        groupPredicates.push(p);
      }
      const compound: RulePredicate = { type: group.mode, predicates: groupPredicates };
      predicates.push(group.negated ? { type: "not", predicate: compound } : compound);
    }
  }

  if (predicates.length === 1) {
    return predicates[0] ?? "At least one condition is required.";
  }

  return { type: topMode, predicates };
}

/**
 * Inverse of `predicateFromConditionNodes`.
 * Returns null when the nesting is too deep to represent in the UI.
 */
function conditionNodesFromPredicate(predicate: RulePredicate): readonly VisualConditionNode[] | null {
  switch (predicate.type) {
    // --- Base (simple) predicates ---
    case "tag":
    case "pathGlob":
    case "basename":
    case "frontmatterValue":
    case "frontmatterExists":
    case "frontmatterMissing":
    case "frontmatterContains":
    case "sourceUrl":
    case "fileAge":
    case "bodyH1":
    case "contentContains":
    case "frontmatterRegex":
    case "frontmatterDateAge":
    case "wordCount":
    case "tagPrefix":
    case "contentRegex": {
      const c = editableCriterionDraft(predicate);
      return c === null ? null : [{ kind: "criterion", criterion: c }];
    }

    // --- not ---
    case "not": {
      const inner = predicate.predicate;
      if (inner.type === "all" || inner.type === "any") {
        // not(all/any) → single negated group node
        const conditions: VisualCriterionDraft[] = [];
        for (const child of inner.predicates) {
          const c = editableCriterionDraft(child);
          if (c === null) return null;
          conditions.push(c);
        }
        return [{ kind: "group", group: { mode: inner.type, conditions, negated: true } }];
      }
      if (inner.type !== "not") {
        // not(simple) → negated criterion node
        const c = editableCriterionDraft(inner);
        return c === null ? null : [{ kind: "criterion", criterion: { ...c, negated: true } }];
      }
      return null; // not(not(...)) — too deep
    }

    // --- all / any ---
    case "all":
    case "any": {
      const nodes: VisualConditionNode[] = [];
      for (const child of predicate.predicates) {
        if (child.type === "all" || child.type === "any") {
          // Nested compound → group node
          const conditions: VisualCriterionDraft[] = [];
          for (const gc of child.predicates) {
            const c = editableCriterionDraft(gc);
            if (c === null) return null;
            conditions.push(c);
          }
          nodes.push({ kind: "group", group: { mode: child.type, conditions, negated: false } });
        } else if (child.type === "not") {
          const innerChild = child.predicate;
          if (innerChild.type === "all" || innerChild.type === "any") {
            // not(all/any) → negated group node
            const conditions: VisualCriterionDraft[] = [];
            for (const gc of innerChild.predicates) {
              const c = editableCriterionDraft(gc);
              if (c === null) return null;
              conditions.push(c);
            }
            nodes.push({ kind: "group", group: { mode: innerChild.type, conditions, negated: true } });
          } else if (innerChild.type !== "not") {
            // not(simple) → negated criterion node
            const c = editableCriterionDraft(innerChild);
            if (c === null) return null;
            nodes.push({ kind: "criterion", criterion: { ...c, negated: true } });
          } else {
            return null; // not(not(...)) — too deep
          }
        } else {
          // Simple child → plain criterion node
          const c = editableCriterionDraft(child);
          if (c === null) return null;
          nodes.push({ kind: "criterion", criterion: c });
        }
      }
      return nodes;
    }
  }
}

function summarizeCompoundPredicate(type: "all" | "any", predicates: readonly RulePredicate[]): string {
  if (predicates.length === 0) {
    return `${type} of no predicates`;
  }

  return `${type} (${predicates.map(summarizePredicate).join("; ")})`;
}

function formatTag(tag: string): string {
  return tag.startsWith("#") ? tag : `#${tag}`;
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/u, "");
}

function quote(value: string): string {
  return `"${value}"`;
}

function formatFrontmatterValue(value: FrontmatterValue): string {
  if (typeof value === "string") {
    return quote(value);
  }

  return JSON.stringify(value);
}

function readFrontmatterRecord(value: unknown): Readonly<Record<string, FrontmatterValue>> | null {
  if (!isRecord(value)) {
    return null;
  }

  const result = Object.create(null) as Record<string, FrontmatterValue>;
  for (const key of Object.keys(value)) {
    if (isUnsafeObjectKey(key)) {
      return null;
    }
    const item = value[key];
    const frontmatterValue = readFrontmatterValue(item);
    if (frontmatterValue === null && item !== null) {
      return null;
    }
    result[key] = frontmatterValue;
  }
  return result;
}

function readFrontmatterValue(value: unknown): FrontmatterValue | null {
  if (isJsonScalar(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const items: (string | number | boolean | null)[] = [];
    for (const item of value as unknown[]) {
      if (!isJsonScalar(item)) {
        return null;
      }
      items.push(item);
    }
    return items;
  }

  if (isRecord(value)) {
    const result = Object.create(null) as Record<string, string | number | boolean | null>;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (!isJsonScalar(item) || isUnsafeObjectKey(key)) {
        return null;
      }
      result[key] = item;
    }
    return result;
  }

  return null;
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isSafeMoveDestination(value: string): boolean {
  return !value.replace(/\\/g, "/").split("/").some((segment) => segment === "..");
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
