import { compilePathGlob } from "./path-glob";
import { canonicalValue, sortValue } from "./value-utils";
import { lazyBodyRegexMatcher } from "./body-regex-set";
import { compileRuleRegex, regexCompilerForRules, type RuleRegex } from "./rule-regex";
import type {
  DryRunRuleMatch,
  Frontmatter,
  FrontmatterValue,
  JsonScalar,
  NoteState,
  PlannedMutation,
  PredicateTrace,
  RuleEvaluationTrace,
  ReconciliationInput,
  ReconciliationResult,
  Rule,
  RuleId,
  RulePredicate,
  RuleRunOn,
} from "./types";

interface EvaluationResult {
  readonly state: NoteState;
  readonly appliedRuleIds: readonly RuleId[];
  readonly dryRunRuleIds: readonly RuleId[];
  readonly dryRunMatches: readonly DryRunRuleMatch[];
  readonly moveRuleIds: readonly RuleId[];
  readonly renameRuleIds: readonly RuleId[];
  readonly frontmatterRuleIds: readonly RuleId[];
  readonly stoppedOnMatch: boolean;
}

interface ParsedPath {
  readonly path: string;
  readonly basename: string;
  readonly extension: string;
}

interface TemplateContext {
  readonly frontmatter: Frontmatter;
  readonly basename: string;
  readonly captures: readonly string[];
  readonly contentCaptures: readonly string[];
  readonly now: number;
  readonly path: string;
  readonly folder: string;
  readonly extension: string;
  readonly formatDate: (timestamp: number, format: string) => string;
  readonly skippedActions?: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function reconcileFileState(input: ReconciliationInput): ReconciliationResult {
  const now = input.options.now ?? Date.now();
  const dateFormatter = input.options.formatDate ?? formatDate;
  const baseline = normalizeComparableInput(input.file);
  const initial = normalizeNoteState(input.file);
  const rules = [...input.rules]
    .filter((rule) => rule.enabled)
    .filter((rule) => ruleMatchesTrigger(rule, input.options.triggerContext))
    .sort(compareRules);
  const maxIterations = Math.max(0, input.options.maxIterations);

  const predicateContext: PredicateContext = { owner: input.rules, missingBody: input.options.onMissingBodyContent, bodyCache: new Map(),
    bodyMatcher: input.options.useRegexSet === true && input.file.bodyContent !== undefined ? lazyBodyRegexMatcher(input.rules, input.file.bodyContent) : undefined };
  const seen = new Map<string, number>();
  const states: NoteState[] = [initial];
  const appliedRuleIds: RuleId[] = [];
  const dryRunRuleIds: RuleId[] = [];
  const dryRunMatches: DryRunRuleMatch[] = [];
  const moveRuleIds: RuleId[] = [];
  const renameRuleIds: RuleId[] = [];
  const frontmatterRuleIds: RuleId[] = [];
  seen.set(stableStringifyNoteState(initial), 0);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const current = states[states.length - 1];
    const evaluation = evaluateRules(current, rules, now, dateFormatter, iteration + 1, input.options.onRuleEvaluated, predicateContext);
    appendUnique(appliedRuleIds, evaluation.appliedRuleIds);
    appendUnique(dryRunRuleIds, evaluation.dryRunRuleIds);
    upsertDryRunMatches(dryRunMatches, evaluation.dryRunMatches);
    appendUnique(moveRuleIds, evaluation.moveRuleIds);
    appendUnique(renameRuleIds, evaluation.renameRuleIds);
    appendUnique(frontmatterRuleIds, evaluation.frontmatterRuleIds);

    if (noteStatesEqual(current, evaluation.state) || evaluation.stoppedOnMatch) {
      const mutations = buildMutations(baseline, evaluation.state, moveRuleIds, renameRuleIds, frontmatterRuleIds);
      return {
        status: "converged",
        desired: evaluation.state,
        mutations,
        appliedRuleIds,
        iterations: iteration + 1,
        changed: !noteStatesEqual(baseline, evaluation.state),
        dryRunRuleIds,
        dryRunMatches,
      };
    }

    const key = stableStringifyNoteState(evaluation.state);
    const previousIndex = seen.get(key);
    if (previousIndex !== undefined) {
      const cycleStates = states.slice(previousIndex);
      cycleStates.push(evaluation.state);
      return {
        status: "cycle-detected",
        iterations: iteration + 1,
        involvedRuleIds: appliedRuleIds,
        states: cycleStates,
      };
    }

    seen.set(key, states.length);
    states.push(evaluation.state);
  }

  return {
    status: "max-iterations-exceeded",
    iterations: maxIterations,
    involvedRuleIds: appliedRuleIds,
    states,
  };
}

// ---------------------------------------------------------------------------
// Rule filtering
// ---------------------------------------------------------------------------

function ruleMatchesTrigger(rule: Rule, triggerContext?: RuleRunOn | readonly RuleRunOn[]): boolean {
  const runOn = rule.runOn ?? "always";
  if (runOn === "always") {
    return true;
  }

  if (triggerContext === undefined) {
    return true;
  }

  if (Array.isArray(triggerContext)) {
    return triggerContext.includes(runOn);
  }

  return runOn === triggerContext;
}

function compareRules(left: Rule, right: Rule): number {
  const priorityComparison = left.priority - right.priority;
  if (priorityComparison !== 0) {
    return priorityComparison;
  }
  return left.order - right.order;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

function evaluateRules(
  state: NoteState,
  rules: readonly Rule[],
  now: number,
  dateFormatter: (timestamp: number, format: string) => string,
  iteration: number,
  onRuleEvaluated?: (trace: RuleEvaluationTrace) => void,
  context: PredicateContext = {},
): EvaluationResult {
  let nextState = state;
  const appliedRuleIds: RuleId[] = [];
  const dryRunRuleIds: RuleId[] = [];
  const dryRunMatches: DryRunRuleMatch[] = [];
  const moveRuleIds: RuleId[] = [];
  const renameRuleIds: RuleId[] = [];
  const frontmatterRuleIds: RuleId[] = [];
  let stoppedOnMatch = false;

  for (const rule of rules) {
    const needsCaptures = onRuleEvaluated !== undefined || [rule.then.moveTo, rule.then.renameTo].some((template) => template !== undefined && /\{\s*\d+\s*\}/u.test(template));
    const predicate = evaluatePredicate(rule.when, nextState, now, onRuleEvaluated !== undefined, { ...context, captures: needsCaptures,
      lookbehind: rule.regexLookbehind === true, compile: regexCompilerForRules(context.owner ?? rules, rule.regexLookbehind === true) });
    if (!predicate.matched) {
      if (predicate.trace !== undefined) onRuleEvaluated?.({ iteration, ruleId: rule.id, ruleName: rule.name,
        outcome: "not-matched", predicate: predicate.trace, before: nextState, after: nextState, messages: [] });
      continue;
    }
    const messages: string[] | undefined = onRuleEvaluated === undefined ? undefined : [];
    const traceResult = (before: NoteState, after: NoteState, outcome: "applied" | "dry-run"): void => {
      if (predicate.trace === undefined) return;
      if (noteStatesEqual(before, after)) messages?.push("Actions produced no change: already satisfied or skipped for an unavailable/unsupported value.");
      if (rule.stopOnMatch === true) messages?.push("stopOnMatch ends this reconciliation after this rule.");
      onRuleEvaluated?.({ iteration, ruleId: rule.id, ruleName: rule.name, outcome, predicate: predicate.trace, before, after, messages: messages ?? [] });
    };

    // Captures belong only to the branches that actually satisfied this rule.
    const { captures, contentCaptures } = predicate;
    const ctx: TemplateContext = {
      frontmatter: nextState.frontmatter,
      basename: nextState.basename,
      captures,
      contentCaptures,
      now,
      path: nextState.path,
      folder: folderOf(nextState.path),
      extension: nextState.extension,
      formatDate: dateFormatter,
      ...(messages === undefined ? {} : { skippedActions: messages }),
    };

    // Dry-run rules produce a hypothetical plan without influencing live state
    // or the predicates evaluated by subsequent rules.
    if (rule.dryRun === true) {
      appendUnique(dryRunRuleIds, [rule.id]);
      const hypothetical = applyRuleActions(nextState, rule, ctx);
      traceResult(nextState, hypothetical, "dry-run");
      dryRunMatches.push({
        ruleId: rule.id,
        desired: hypothetical,
        mutations: buildMutations(nextState, hypothetical, [rule.id], [rule.id], [rule.id]),
      });
      if (rule.stopOnMatch === true) {
        stoppedOnMatch = true;
        break;
      }
      continue;
    }

    appliedRuleIds.push(rule.id);
    const beforeRule = nextState;
    nextState = applyRuleActions(nextState, rule, ctx);
    traceResult(beforeRule, nextState, "applied");

    if (hasFolderChanged(beforeRule, nextState)) {
      appendUnique(moveRuleIds, [rule.id]);
    }
    if (hasBasenameChanged(beforeRule, nextState)) {
      appendUnique(renameRuleIds, [rule.id]);
    }
    if (!noteFrontmattersEqual(beforeRule, nextState)) {
      appendUnique(frontmatterRuleIds, [rule.id]);
    }

    // stopOnMatch: stop processing further rules once this rule fires (regardless of change)
    if (rule.stopOnMatch === true) {
      stoppedOnMatch = true;
      break;
    }
  }

  return {
    state: nextState,
    appliedRuleIds,
    dryRunRuleIds,
    dryRunMatches,
    moveRuleIds,
    renameRuleIds,
    frontmatterRuleIds,
    stoppedOnMatch,
  };
}

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

function predicateMatches(predicate: RulePredicate, state: NoteState, now: number, compile: (pattern: string) => RuleRegex = compileRuleRegex): boolean {
  switch (predicate.type) {
    case "tag": {
      const expectedTagKey = tagComparisonKey(predicate.tag);
      return expectedTagKey.length > 0 && state.tags.some((tag) => tagComparisonKey(tag) === expectedTagKey);
    }
    case "pathGlob":
      return globMatches(predicate.glob, state.path);
    case "basename":
      return basenameMatches(predicate.pattern, state.basename, compile);
    case "frontmatterValue":
      return frontmatterValueMatches(predicate.property, predicate.value, state.frontmatter);
    case "frontmatterExists":
      return frontmatterPropertyExists(predicate.property, state);
    case "frontmatterMissing":
      return !frontmatterPropertyExists(predicate.property, state);
    case "frontmatterContains":
      return frontmatterContainsValue(predicate.property, predicate.value, state.frontmatter);
    case "sourceUrl":
      return sourceUrlMatches(predicate.property, predicate.host, state.frontmatter);
    case "fileAge":
      return fileAgeMatches(predicate.field, predicate.olderThanDays, predicate.newerThanDays, state.stat, now);
    case "bodyH1":
      return state.bodyH1 !== undefined && basenameMatches(predicate.pattern, state.bodyH1, compile);
    case "contentContains":
      return state.bodyContent !== undefined && state.bodyContent.includes(predicate.text);
    case "all":
      return predicate.predicates.every((child) => predicateMatches(child, state, now));
    case "any":
      return predicate.predicates.some((child) => predicateMatches(child, state, now));
    case "not":
      if (state.bodyContent === undefined && predicateNeedsBodyContent(predicate.predicate)) {
        return false;
      }
      return !predicateMatches(predicate.predicate, state, now);
    case "frontmatterRegex": {
      const fmrValue = state.frontmatter[predicate.property];
      if (fmrValue === undefined || fmrValue === null) {
        return false;
      }
      try {
        const text = typeof fmrValue === "object" ? JSON.stringify(fmrValue) : String(fmrValue);
        return compile(predicate.pattern).test(text);
      } catch {
        return false;
      }
    }
    case "frontmatterDateAge": {
      const fdaValue = state.frontmatter[predicate.property];
      if (fdaValue === undefined || fdaValue === null) {
        return false;
      }
      let ts: number;
      if (typeof fdaValue === "number") {
        ts = fdaValue;
      } else if (typeof fdaValue === "string") {
        ts = new Date(fdaValue).getTime();
        if (!Number.isFinite(ts)) {
          return false;
        }
      } else {
        return false;
      }
      const fdaAgeDays = (now - ts) / MS_PER_DAY;
      if (predicate.olderThanDays !== undefined && fdaAgeDays <= predicate.olderThanDays) {
        return false;
      }
      if (predicate.newerThanDays !== undefined && fdaAgeDays >= predicate.newerThanDays) {
        return false;
      }
      return true;
    }
    case "wordCount": {
      if (state.bodyContent === undefined) {
        return false;
      }
      const content = state.bodyContent;
      const trimmed = content.trim();
      const count = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
      if (predicate.moreThan !== undefined && count <= predicate.moreThan) {
        return false;
      }
      if (predicate.lessThan !== undefined && count >= predicate.lessThan) {
        return false;
      }
      return true;
    }
    case "tagPrefix": {
      const normalizedPrefix = tagComparisonKey(predicate.prefix);
      return normalizedPrefix.length > 0 && state.tags.some((tag) => tagComparisonKey(tag).startsWith(normalizedPrefix));
    }
    case "contentRegex": {
      if (state.bodyContent === undefined) {
        return false;
      }
      try {
        return compile(predicate.pattern).test(state.bodyContent);
      } catch {
        return false;
      }
    }
  }
}

function frontmatterPropertyExists(property: string, state: NoteState): boolean {
  if (property in state.frontmatter) {
    return state.frontmatter[property] !== undefined && state.frontmatter[property] !== null;
  }
  return stateFrontmatterKeys(state).includes(property);
}

function frontmatterContainsValue(property: string, searchValue: string, frontmatter: Frontmatter): boolean {
  const value = frontmatter[property];
  if (value === undefined || value === null) {
    return false;
  }

  const lowerSearch = searchValue.toLowerCase();

  if (typeof value === "string") {
    return value.toLowerCase().includes(lowerSearch);
  }

  if (Array.isArray(value)) {
    return value.some((item) => String(item).toLowerCase().includes(lowerSearch));
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase().includes(lowerSearch);
  }

  // Record<string, JsonScalar>
  return Object.values(value).some((item) => String(item).toLowerCase().includes(lowerSearch));
}

function fileAgeMatches(
  field: "ctime" | "mtime",
  olderThanDays: number | undefined,
  newerThanDays: number | undefined,
  stat: NoteState["stat"],
  now: number,
): boolean {
  if (stat === undefined) {
    return false;
  }

  const ts = field === "ctime" ? stat.ctime : stat.mtime;
  if (!Number.isFinite(ts) || ts < 0) {
    return false;
  }

  const ageDays = (now - ts) / MS_PER_DAY;

  if (olderThanDays !== undefined && ageDays <= olderThanDays) {
    return false;
  }

  if (newerThanDays !== undefined && ageDays >= newerThanDays) {
    return false;
  }

  return true;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rule action application
// ---------------------------------------------------------------------------

function applyRuleActions(state: NoteState, rule: Rule, ctx: TemplateContext): NoteState {
  let nextState = state;

  if (rule.then.moveTo !== undefined) {
    nextState = moveState(nextState, rule.then.moveTo, ctx, rule.then.moveToKind);
  }

  if (rule.then.renameTo !== undefined) {
    nextState = renameState(nextState, rule.then.renameTo, ctx);
  }

  if (rule.then.addTags !== undefined && rule.then.addTags.length > 0) {
    nextState = addTagsToState(nextState, rule.then.addTags);
  }

  if (rule.then.removeTags !== undefined && rule.then.removeTags.length > 0) {
    nextState = removeTagsFromState(nextState, rule.then.removeTags);
  }

  if (rule.then.replaceTags !== undefined) {
    nextState = replaceTagsOnState(nextState, rule.then.replaceTags);
  }

  if (rule.then.setProperties !== undefined) {
    nextState = setPropertiesOnState(nextState, rule.then.setProperties);
  }

  if (rule.then.initProperties !== undefined) {
    nextState = initPropertiesOnState(nextState, rule.then.initProperties);
  }

  if (rule.then.appendToProperty !== undefined) {
    nextState = appendToPropertyOnState(nextState, rule.then.appendToProperty);
  }

  if (rule.then.deleteProperties !== undefined && rule.then.deleteProperties.length > 0) {
    nextState = deletePropertiesFromState(nextState, rule.then.deleteProperties);
  }

  return nextState;
}

// ---------------------------------------------------------------------------
// Move action
// ---------------------------------------------------------------------------

function moveState(state: NoteState, destination: string, ctx: TemplateContext, kind: "auto" | "folder" | "file" = "auto"): NoteState {
  const parsed = resolveMoveDestination(state, destination, ctx, kind);
  if (parsed === null) {
    return state; // template expansion failed (missing property)
  }

  if (state.path === parsed.path && state.basename === parsed.basename && state.extension === parsed.extension) {
    return state;
  }

  return {
    ...state,
    path: parsed.path,
    basename: parsed.basename,
    extension: parsed.extension,
  };
}

function resolveMoveDestination(state: NoteState, destination: string, ctx: TemplateContext, kind: "auto" | "folder" | "file"): ParsedPath | null {
  // Expand template variables in the destination (frontmatter, date, basename, captures)
  const expanded = expandPathTemplate(destination, ctx);
  if (expanded === null) {
    return null; // template expansion failed
  }

  const normalizedDestination = normalizePath(expanded);
  const folderLike = kind === "folder" || (kind === "auto" && isFolderLikeDestination(expanded));

  if (folderLike) {
    const folder = stripTrailingSlash(normalizedDestination);
    const filename = buildFilename(state.basename, state.extension);
    const path = folder.length > 0 ? `${folder}/${filename}` : filename;
    return {
      path,
      basename: state.basename,
      extension: state.extension,
    };
  }

  return parsePath(normalizedDestination);
}

function isFolderLikeDestination(destination: string): boolean {
  const normalized = destination.trim().replace(/\\/g, "/");
  if (normalized.length === 0 || normalized.endsWith("/")) {
    return true;
  }

  const finalSegment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return !finalSegment.includes(".");
}

function parsePath(path: string): ParsedPath {
  const normalizedPath = normalizePath(path);
  const filename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const dotIndex = filename.lastIndexOf(".");

  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return {
      path: normalizedPath,
      basename: filename,
      extension: "",
    };
  }

  return {
    path: normalizedPath,
    basename: filename.slice(0, dotIndex),
    extension: filename.slice(dotIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// Rename action (basename-only, keeps folder and extension)
// ---------------------------------------------------------------------------

function renameState(state: NoteState, template: string, ctx: TemplateContext): NoteState {
  const newBasename = expandBasenameTemplate(template, ctx);
  if (newBasename === null || newBasename === state.basename) {
    return state;
  }

  const currentPath = state.path;
  const separatorIndex = currentPath.lastIndexOf("/");
  const folderPrefix = separatorIndex === -1 ? "" : currentPath.slice(0, separatorIndex + 1);
  const newFilename = buildFilename(newBasename, state.extension);
  const newPath = folderPrefix + newFilename;

  return {
    ...state,
    path: newPath,
    basename: newBasename,
  };
}

// ---------------------------------------------------------------------------
// Template expansion
// ---------------------------------------------------------------------------

/**
 * Expand a basename (rename) template. Result is sanitized: path separators removed, trimmed.
 * Returns null if a required {property} or {N} capture is missing.
 */
function expandBasenameTemplate(template: string, ctx: TemplateContext): string | null {
  const raw = expandTemplateCore(template, ctx, true);
  if (raw === null) {
    return null;
  }

  const sanitized = raw.replace(/[/\\]/g, "").trim();
  return sanitized.length === 0 ? null : sanitized;
}

/**
 * Expand a path (moveTo) template. Path separators are preserved.
 * Returns null if a required {property} or {N} capture is missing.
 */
function expandPathTemplate(template: string, ctx: TemplateContext): string | null {
  const raw = expandTemplateCore(template, ctx, false);
  if (raw === null) {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function expandTemplateCore(template: string, ctx: TemplateContext, isBasename: boolean): string | null {
  let result = "";
  let index = 0;

  while (index < template.length) {
    const ch = template[index];

    if (ch === "}") {
      if (template[index + 1] === "}") {
        result += "}";
        index += 2;
        continue;
      }
      result += ch;
      index += 1;
      continue;
    }

    if (ch !== "{") {
      result += ch;
      index += 1;
      continue;
    }

    // ch === "{"
    if (template[index + 1] === "{") {
      result += "{";
      index += 2;
      continue;
    }

    const closingIndex = template.indexOf("}", index + 1);
    if (closingIndex === -1) {
      // Unclosed brace — treat rest as literal
      result += template.slice(index);
      break;
    }

    const key = template.slice(index + 1, closingIndex).trim();
    index = closingIndex + 1;

    if (key.length === 0) {
      result += "{}";
      continue;
    }

    // {basename} — literal keyword
    if (key === "basename") {
      result += ctx.basename;
      continue;
    }

    // {folder} — parent folder of the note (empty string at root)
    if (key === "folder") {
      result += ctx.folder;
      continue;
    }

    // {path} — full note path without extension
    if (key === "path") {
      const ext = ctx.extension;
      const fullPath = ctx.path;
      result += ext.length > 0 ? fullPath.slice(0, fullPath.length - ext.length - 1) : fullPath;
      continue;
    }

    // {extension} — file extension without leading dot
    if (key === "extension") {
      result += ctx.extension;
      continue;
    }

    // {1} {2} … — regex capture groups from basename or contentRegex predicate
    const captureMatch = /^(\d+)$/.exec(key);
    if (captureMatch !== null) {
      const captureIndex = parseInt(captureMatch[1], 10);
      if (captureIndex >= 1 && captureIndex <= ctx.captures.length) {
        result += ctx.captures[captureIndex - 1] ?? "";
        continue;
      }
      // Fall back to contentCaptures
      if (captureIndex >= 1 && captureIndex <= ctx.contentCaptures.length) {
        result += ctx.contentCaptures[captureIndex - 1] ?? "";
        continue;
      }
      // Missing capture — skip action
      ctx.skippedActions?.push(`Template action skipped: capture {${key}} is unavailable from the matching branch.`);
      return null;
    }

    // {date:FORMAT} — current date with explicit format (colon distinguishes from frontmatter key)
    if (key.startsWith("date:")) {
      result += ctx.formatDate(ctx.now, key.slice(5));
      continue;
    }

    // {now} or {now:FORMAT} — current date ("now" is unlikely to be a frontmatter key)
    // Check frontmatter first to allow override, but fall back to current date.
    if (key === "now" || key.startsWith("now:")) {
      const fmNow = ctx.frontmatter["now"];
      if (key === "now" && fmNow !== undefined && fmNow !== null && typeof fmNow !== "object") {
        result += String(fmNow);
        continue;
      }
      const fmt = key.startsWith("now:") ? key.slice(4) : "YYYY-MM-DD";
      result += ctx.formatDate(ctx.now, fmt);
      continue;
    }

    // {today} or {today:FORMAT} — current date, same pattern as {now}
    if (key === "today" || key.startsWith("today:")) {
      const fmToday = ctx.frontmatter["today"];
      if (key === "today" && fmToday !== undefined && fmToday !== null && typeof fmToday !== "object") {
        result += String(fmToday);
        continue;
      }
      const fmt = key.startsWith("today:") ? key.slice(6) : "YYYY-MM-DD";
      result += ctx.formatDate(ctx.now, fmt);
      continue;
    }

    // {property} — frontmatter lookup (includes plain {date} → uses frontmatter "date" key)
    const fmValue = ctx.frontmatter[key];
    if (fmValue === undefined || fmValue === null || typeof fmValue === "object") {
      // Missing or non-scalar — skip action
      ctx.skippedActions?.push(`Template action skipped: property {${key}} is missing, null, or non-scalar.`);
      return null;
    }

    result += String(fmValue);
  }

  // For basename mode, path separators are stripped by caller
  // For path mode, they're preserved
  if (!isBasename) {
    // Sanitize only the path-unsafe characters (not slashes)
    return result;
  }

  return result;
}

/**
 * Format a timestamp using moment.js-style tokens (YYYY MM DD HH mm ss x).
 * Uses a placeholder approach to avoid double-replacement.
 */
function formatDate(timestamp: number, format: string): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();

  // Process tokens longest-first to avoid partial matches, using null-char placeholders
  const tokens: Array<[RegExp, string]> = [
    [/YYYY/g, String(year)],
    [/YY/g, String(year).slice(-2)],
    [/MM/g, String(month).padStart(2, "0")],
    [/M/g, String(month)],
    [/DD/g, String(day).padStart(2, "0")],
    [/D/g, String(day)],
    [/HH/g, String(hours).padStart(2, "0")],
    [/H/g, String(hours)],
    [/mm/g, String(minutes).padStart(2, "0")],
    [/m/g, String(minutes)],
    [/ss/g, String(seconds).padStart(2, "0")],
    [/s/g, String(seconds)],
    [/x/g, String(timestamp)],
  ];

  let result = format;
  const placeholders = new Map<string, string>();
  let i = 0;
  for (const [regex, value] of tokens) {
    const ph = `\x00${i++}\x00`;
    result = result.replace(regex, ph);
    placeholders.set(ph, value);
  }

  for (const [ph, value] of placeholders) {
    result = result.split(ph).join(value);
  }

  return result;
}

export interface PredicateEvaluation {
  readonly matched: boolean;
  readonly captures: readonly string[];
  readonly contentCaptures: readonly string[];
  readonly trace?: PredicateTrace;
}

/** `any` takes its first successful branch; `all` takes the first nonempty
 * capture set of each kind from successful children. Negation exports none. */
interface PredicateContext {
  readonly compile?: (pattern: string) => RuleRegex;
  readonly owner?: object;
  readonly lookbehind?: boolean;
  readonly bodyMatcher?: (pattern: string, lookbehind: boolean) => boolean | undefined;
  readonly missingBody?: () => never;
  readonly captures?: boolean;
  readonly bodyCache?: Map<RulePredicate, Map<(pattern: string) => RuleRegex, { readonly result: PredicateEvaluation; readonly capturesComplete: boolean }>>;
}

export function evaluatePredicate(predicate: RulePredicate, state: NoteState, now: number, trace = false, context: PredicateContext = {}): PredicateEvaluation {
  const compile = context.compile ?? compileRuleRegex;
  const bodyLeaf = predicate.type === "contentContains" || predicate.type === "contentRegex" || predicate.type === "wordCount";
  if (bodyLeaf && state.bodyContent === undefined) context.missingBody?.();
  const cached = !trace && bodyLeaf ? context.bodyCache?.get(predicate)?.get(compile) : undefined;
  if (cached !== undefined) {
    if (context.captures === false) return { ...cached.result, captures: [], contentCaptures: [] };
    if (cached.capturesComplete) return cached.result;
    if (predicate.type === "contentRegex") {
      const result = { ...cached.result, contentCaptures: compile(predicate.pattern).captures(state.bodyContent ?? "") };
      context.bodyCache?.get(predicate)?.set(compile, { result, capturesComplete: true });
      return result;
    }
  }
  const children: PredicateTrace[] | undefined = trace ? [] : undefined;
  const finish = (matched: boolean, captures: readonly string[] = [], contentCaptures: readonly string[] = []): PredicateEvaluation => ({
    matched, captures, contentCaptures,
    ...(trace ? { trace: { predicate, matched, captures, contentCaptures, children } } : {}),
  });
  const evaluate = (child: RulePredicate): PredicateEvaluation => {
    const result = evaluatePredicate(child, state, now, trace, context);
    if (result.trace !== undefined) children?.push(result.trace);
    return result;
  };
  if (predicate.type === "any") {
    for (const child of predicate.predicates) {
      const result = evaluate(child);
      if (result.matched) return finish(true, result.captures, result.contentCaptures);
    }
    return finish(false);
  }
  if (predicate.type === "all") {
    let captures: readonly string[] = [];
    let contentCaptures: readonly string[] = [];
    for (const child of predicate.predicates) {
      const result = evaluate(child);
      if (!result.matched) return finish(false);
      if (captures.length === 0) captures = result.captures;
      if (contentCaptures.length === 0) contentCaptures = result.contentCaptures;
    }
    return finish(true, captures, contentCaptures);
  }
  if (predicate.type === "not") {
    if (context.missingBody === undefined && state.bodyContent === undefined && predicateNeedsBodyContent(predicate.predicate)) return finish(false);
    return finish(!evaluate(predicate.predicate).matched);
  }
  const matched = (predicate.type === "contentRegex" && state.bodyContent !== undefined ? context.bodyMatcher?.(predicate.pattern, context.lookbehind === true) : undefined)
    ?? predicateMatches(predicate, state, now, compile);
  let result = finish(matched);
  if (matched && predicate.type === "basename" && context.captures !== false) result = finish(true, compile(predicate.pattern).captures(state.basename));
  // Capture extraction stays lazy; a shared body predicate can upgrade its
  // cached boolean result if a later rule actually needs the captures.
  if (matched && predicate.type === "contentRegex" && context.captures !== false) result = finish(true, [], compile(predicate.pattern).captures(state.bodyContent ?? ""));
  if (!trace && bodyLeaf && context.bodyCache !== undefined) {
    const entries = context.bodyCache.get(predicate) ?? new Map<(pattern: string) => RuleRegex, { readonly result: PredicateEvaluation; readonly capturesComplete: boolean }>();
    entries.set(compile, { result, capturesComplete: predicate.type !== "contentRegex" || !matched || context.captures !== false }); context.bodyCache.set(predicate, entries);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tags actions
// ---------------------------------------------------------------------------

function addTagsToState(state: NoteState, tags: readonly string[]): NoteState {
  const existingTagKeys = new Set(state.tags.map(tagComparisonKey));
  const additions = tags.filter((tag) => {
    const key = tagComparisonKey(tag);
    if (key.length === 0 || existingTagKeys.has(key)) {
      return false;
    }
    existingTagKeys.add(key);
    return true;
  });
  const nextFrontmatterTags = normalizeTags([...stateFrontmatterTags(state), ...additions]);
  return withUpdatedFrontmatterTags(state, nextFrontmatterTags);
}

function replaceTagsOnState(state: NoteState, tags: readonly string[]): NoteState {
  return withUpdatedFrontmatterTags(state, normalizeTags(tags));
}

function removeTagsFromState(state: NoteState, tags: readonly string[]): NoteState {
  const tagKeysToRemove = new Set(tags.map(tagComparisonKey).filter((tag) => tag.length > 0));
  const nextFrontmatterTags = stateFrontmatterTags(state)
    .filter((tag) => !tagKeysToRemove.has(tagComparisonKey(tag)));
  return withUpdatedFrontmatterTags(state, nextFrontmatterTags);
}

function withUpdatedFrontmatterTags(state: NoteState, frontmatterTagsValue: readonly string[]): NoteState {
  const nextFrontmatterTags = normalizeTags(frontmatterTagsValue);
  const nextTags = normalizeTags([...stateInlineTags(state), ...nextFrontmatterTags]);
  const nextFrontmatter = withFrontmatterTags(state.frontmatter, nextFrontmatterTags);
  const nextFrontmatterKeys = new Set(stateFrontmatterKeys(state));
  if (nextFrontmatterTags.length > 0) nextFrontmatterKeys.add("tags");
  else nextFrontmatterKeys.delete("tags");
  const normalizedKeys = normalizeFrontmatterKeys([...nextFrontmatterKeys]);

  if (arraysEqual(state.tags, nextTags)
    && arraysEqual(stateFrontmatterTags(state), nextFrontmatterTags)
    && arraysEqual(stateFrontmatterKeys(state), normalizedKeys)
    && frontmattersEqual(state.frontmatter, nextFrontmatter)) {
    return state;
  }

  return {
    ...state,
    tags: nextTags,
    frontmatterTags: nextFrontmatterTags,
    frontmatter: nextFrontmatter,
    frontmatterKeys: normalizedKeys,
  };
}

// ---------------------------------------------------------------------------
// Properties actions
// ---------------------------------------------------------------------------

function setPropertiesOnState(state: NoteState, properties: Readonly<Record<string, FrontmatterValue>>): NoteState {
  let frontmatter = cloneFrontmatter(state.frontmatter);
  let frontmatterTagsValue = stateFrontmatterTags(state);
  const frontmatterKeys = new Set(stateFrontmatterKeys(state));

  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (isUnsafeObjectKey(key)) {
      continue;
    }
    if (key === "tags") {
      frontmatterTagsValue = normalizeTags([...frontmatterTagsValue, ...frontmatterTagsFromValue(value)]);
      frontmatter = withFrontmatterTags(frontmatter, frontmatterTagsValue);
      if (frontmatterTagsValue.length > 0) frontmatterKeys.add(key);
      else frontmatterKeys.delete(key);
    } else {
      frontmatter[key] = cloneFrontmatterValue(value);
      frontmatterKeys.add(key);
    }
  }

  const normalizedFrontmatter = normalizeFrontmatter(frontmatter, frontmatterTagsValue);
  const normalizedKeys = normalizeFrontmatterKeys([...frontmatterKeys]);
  const tags = normalizeTags([...stateInlineTags(state), ...frontmatterTagsValue]);
  if (arraysEqual(state.tags, tags)
    && arraysEqual(stateFrontmatterKeys(state), normalizedKeys)
    && frontmattersEqual(state.frontmatter, normalizedFrontmatter)) {
    return state;
  }

  return {
    ...state,
    tags,
    frontmatterTags: frontmatterTagsValue,
    frontmatter: normalizedFrontmatter,
    frontmatterKeys: normalizedKeys,
  };
}

function deletePropertiesFromState(state: NoteState, keys: readonly string[]): NoteState {
  let frontmatter = cloneFrontmatter(state.frontmatter);
  let frontmatterTagsValue = stateFrontmatterTags(state);
  const frontmatterKeys = new Set(stateFrontmatterKeys(state));

  for (const key of keys) {
    if (isUnsafeObjectKey(key)) {
      continue;
    }
    frontmatterKeys.delete(key);
    if (key === "tags") {
      frontmatter = omitFrontmatterKey(frontmatter, "tags");
      frontmatterTagsValue = [];
    } else {
      frontmatter = omitFrontmatterKey(frontmatter, key);
    }
  }

  const normalizedFrontmatter = normalizeFrontmatter(frontmatter, frontmatterTagsValue);
  const normalizedKeys = normalizeFrontmatterKeys([...frontmatterKeys]);
  const tags = normalizeTags([...stateInlineTags(state), ...frontmatterTagsValue]);
  if (arraysEqual(state.tags, tags)
    && arraysEqual(stateFrontmatterKeys(state), normalizedKeys)
    && frontmattersEqual(state.frontmatter, normalizedFrontmatter)) {
    return state;
  }

  return {
    ...state,
    tags,
    frontmatterTags: frontmatterTagsValue,
    frontmatter: normalizedFrontmatter,
    frontmatterKeys: normalizedKeys,
  };
}

function omitFrontmatterKey(frontmatter: Frontmatter, keyToOmit: string): Frontmatter {
  const next = Object.create(null) as Frontmatter;
  for (const key of Object.keys(frontmatter)) {
    if (key !== keyToOmit) {
      next[key] = frontmatter[key];
    }
  }
  return next;
}

function initPropertiesOnState(state: NoteState, properties: Readonly<Record<string, FrontmatterValue>>): NoteState {
  let frontmatter = cloneFrontmatter(state.frontmatter);
  let frontmatterTagsValue = stateFrontmatterTags(state);
  const frontmatterKeys = new Set(stateFrontmatterKeys(state));

  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (isUnsafeObjectKey(key)) {
      continue;
    }
    const knownValue = frontmatter[key];
    const unsupportedExistingValue = frontmatterKeys.has(key) && !(key in frontmatter);
    if (unsupportedExistingValue || (knownValue !== undefined && knownValue !== null)) {
      continue;
    }
    if (key === "tags") {
      frontmatterTagsValue = normalizeTags([...frontmatterTagsValue, ...frontmatterTagsFromValue(value)]);
      frontmatter = withFrontmatterTags(frontmatter, frontmatterTagsValue);
      if (frontmatterTagsValue.length > 0) frontmatterKeys.add(key);
      else frontmatterKeys.delete(key);
    } else {
      frontmatter[key] = cloneFrontmatterValue(value);
      frontmatterKeys.add(key);
    }
  }

  const normalizedFrontmatter = normalizeFrontmatter(frontmatter, frontmatterTagsValue);
  const normalizedKeys = normalizeFrontmatterKeys([...frontmatterKeys]);
  const tags = normalizeTags([...stateInlineTags(state), ...frontmatterTagsValue]);
  if (arraysEqual(state.tags, tags)
    && arraysEqual(stateFrontmatterKeys(state), normalizedKeys)
    && frontmattersEqual(state.frontmatter, normalizedFrontmatter)) {
    return state;
  }

  return {
    ...state,
    tags,
    frontmatterTags: frontmatterTagsValue,
    frontmatter: normalizedFrontmatter,
    frontmatterKeys: normalizedKeys,
  };
}

function appendToPropertyOnState(state: NoteState, properties: Readonly<Record<string, string>>): NoteState {
  const frontmatter = cloneFrontmatter(state.frontmatter);
  const frontmatterKeys = new Set(stateFrontmatterKeys(state));

  for (const key of Object.keys(properties)) {
    const appendValue = properties[key];
    if (isUnsafeObjectKey(key)) {
      continue;
    }
    const existing = frontmatter[key];
    if (existing === undefined && frontmatterKeys.has(key)) {
      continue;
    }
    if (existing === undefined || existing === null) {
      frontmatter[key] = appendValue;
      frontmatterKeys.add(key);
    } else if (typeof existing === "string") {
      frontmatter[key] = existing + " " + appendValue;
    }
    // non-string: skip
  }

  const frontmatterTagsValue = frontmatterTags(frontmatter);
  const tags = normalizeTags([...stateInlineTags(state), ...frontmatterTagsValue]);
  const normalizedFrontmatter = normalizeFrontmatter(frontmatter, frontmatterTagsValue);
  const normalizedKeys = normalizeFrontmatterKeys([...frontmatterKeys]);
  if (arraysEqual(state.tags, tags)
    && arraysEqual(stateFrontmatterKeys(state), normalizedKeys)
    && frontmattersEqual(state.frontmatter, normalizedFrontmatter)) {
    return state;
  }

  return {
    ...state,
    tags,
    frontmatterTags: frontmatterTagsValue,
    frontmatter: normalizedFrontmatter,
    frontmatterKeys: normalizedKeys,
  };
}

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

function basenameMatches(pattern: string, basename: string, compile: (pattern: string) => RuleRegex = compileRuleRegex): boolean {
  try {
    const regex = compile(pattern);
    return regex.test(basename);
  } catch {
    return false;
  }
}

function frontmatterValueMatches(property: string, expected: JsonScalar, frontmatter: Frontmatter): boolean {
  if (!Object.prototype.hasOwnProperty.call(frontmatter, property)) {
    return false;
  }

  const value = frontmatter[property];

  if (value === null) {
    return expected === null;
  }

  if (typeof value === "object" || Array.isArray(value)) {
    return false;
  }

  return value === expected;
}

function sourceUrlMatches(property: string, host: string, frontmatter: Frontmatter): boolean {
  const value = frontmatter[property];
  if (typeof value !== "string") {
    return false;
  }

  const normalizedHost = normalizeHost(host);
  if (normalizedHost.length === 0) {
    return false;
  }

  const hostname = hostnameFromAbsoluteUrl(value);
  return hostname !== null && hostname === normalizedHost;
}

function hostnameFromAbsoluteUrl(value: string): string | null {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return null;
  }

  try {
    const url = new URL(trimmedValue);
    const hostname = normalizeHost(url.hostname);
    return hostname.length === 0 ? null : hostname;
  } catch {
    return null;
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function globMatches(glob: string, path: string): boolean {
  const regex = compilePathGlob(normalizePath(glob));
  const normalizedPath = normalizePath(path);
  return regex.test(normalizedPath) || regex.test(stripMarkdownExtension(normalizedPath));
}

function stripMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

// ---------------------------------------------------------------------------
// Mutation building
// ---------------------------------------------------------------------------

function buildMutations(
  baseline: NoteState,
  desired: NoteState,
  moveRuleIds: readonly RuleId[],
  renameRuleIds: readonly RuleId[],
  frontmatterRuleIds: readonly RuleId[],
): readonly PlannedMutation[] {
  const mutations: PlannedMutation[] = [];

  if (hasFolderChanged(baseline, desired)) {
    mutations.push({ kind: "move", ruleIds: [...moveRuleIds] });
  }

  if (hasBasenameChanged(baseline, desired)) {
    mutations.push({ kind: "rename", ruleIds: [...renameRuleIds] });
  }

  if (!noteFrontmattersEqual(baseline, desired)) {
    mutations.push({ kind: "frontmatter", ruleIds: [...frontmatterRuleIds] });
  }

  return mutations;
}

function hasFolderChanged(left: NoteState, right: NoteState): boolean {
  return folderOf(left.path) !== folderOf(right.path);
}

function hasBasenameChanged(left: NoteState, right: NoteState): boolean {
  return left.basename !== right.basename;
}

function folderOf(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? "" : path.slice(0, separatorIndex);
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeComparableInput(state: NoteState): NoteState {
  return normalizeNoteState(state);
}

function normalizeNoteState(state: NoteState): NoteState {
  const frontmatterTagsValue = normalizeTags(state.frontmatterTags ?? frontmatterTags(state.frontmatter));
  const frontmatterKeysValue = normalizeFrontmatterKeys([
    ...(state.frontmatterKeys ?? []),
    ...Object.keys(state.frontmatter),
  ]);
  const frontmatterTagKeys = new Set(frontmatterTagsValue.map(tagComparisonKey));
  const inlineTagsValue = normalizeTags(state.inlineTags ?? state.tags.filter((tag) => !frontmatterTagKeys.has(tagComparisonKey(tag))));
  const tags = normalizeTags([...inlineTagsValue, ...frontmatterTagsValue]);
  return {
    path: normalizePath(state.path),
    basename: state.basename,
    extension: normalizeExtension(state.extension),
    frontmatter: normalizeFrontmatter(state.frontmatter, frontmatterTagsValue),
    frontmatterKeys: frontmatterKeysValue,
    ...(state.rawFrontmatter === undefined ? {} : { rawFrontmatter: state.rawFrontmatter }),
    tags,
    frontmatterTags: frontmatterTagsValue,
    inlineTags: inlineTagsValue,
    ...(state.stat !== undefined ? { stat: state.stat } : {}),
    ...(state.bodyH1 !== undefined ? { bodyH1: state.bodyH1 } : {}),
    ...(state.bodyContent !== undefined ? { bodyContent: state.bodyContent } : {}),
  };
}

function normalizeExtension(extension: string): string {
  return extension.startsWith(".") ? extension.slice(1) : extension;
}

function normalizeFrontmatter(frontmatter: Frontmatter, tags: readonly string[]): Frontmatter {
  const next = Object.create(null) as Frontmatter;
  const keys = Object.keys(frontmatter).sort();

  for (const key of keys) {
    if (isUnsafeObjectKey(key)) {
      continue;
    }
    if (key === "tags") {
      next[key] = [...normalizeTags(tags)];
    } else {
      next[key] = cloneFrontmatterValue(frontmatter[key]);
    }
  }

  return next;
}

function withFrontmatterTags(frontmatter: Frontmatter, tags: readonly string[]): Frontmatter {
  const next = cloneFrontmatter(frontmatter);
  if (tags.length > 0) {
    next.tags = [...tags];
  } else {
    delete next.tags;
  }
  return normalizeFrontmatter(next, tags);
}

function stateFrontmatterKeys(state: NoteState): readonly string[] {
  return normalizeFrontmatterKeys([
    ...(state.frontmatterKeys ?? []),
    ...Object.keys(state.frontmatter),
  ]);
}

function normalizeFrontmatterKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys.filter((key) => !isUnsafeObjectKey(key)))].sort();
}

function stateFrontmatterTags(state: NoteState): readonly string[] {
  return normalizeTags(state.frontmatterTags ?? frontmatterTags(state.frontmatter));
}

function stateInlineTags(state: NoteState): readonly string[] {
  if (state.inlineTags !== undefined) {
    return normalizeTags(state.inlineTags);
  }
  const storedTagKeys = new Set(stateFrontmatterTags(state).map(tagComparisonKey));
  return normalizeTags(state.tags).filter((tag) => !storedTagKeys.has(tagComparisonKey(tag)));
}

function frontmatterTags(frontmatter: Frontmatter): readonly string[] {
  const value = frontmatter.tags;
  if (value === undefined) {
    return [];
  }
  return frontmatterTagsFromValue(value);
}

function frontmatterTagsFromValue(value: FrontmatterValue): readonly string[] {
  if (typeof value === "string") {
    return normalizeTags(value.split(/[\s,]+/));
  }

  if (Array.isArray(value)) {
    const tags: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        tags.push(item);
      }
    }
    return normalizeTags(tags);
  }

  return [];
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  const normalizedByKey = new Map<string, string>();
  for (const tag of tags) {
    const nextTag = normalizeTag(tag);
    const key = tagComparisonKey(nextTag);
    if (nextTag.length > 0 && !normalizedByKey.has(key)) {
      normalizedByKey.set(key, nextTag);
    }
  }
  return [...normalizedByKey.values()].sort((left, right) => {
    const keyComparison = tagComparisonKey(left).localeCompare(tagComparisonKey(right));
    return keyComparison === 0 ? left.localeCompare(right) : keyComparison;
  });
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "");
}

function tagComparisonKey(tag: string): string {
  return normalizeTag(tag).toLocaleLowerCase();
}

function normalizePath(path: string): string {
  return stripTrailingSlash(path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/"));
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

function buildFilename(basename: string, extension: string): string {
  if (extension.length === 0) {
    return basename;
  }

  return extension.startsWith(".") ? `${basename}${extension}` : `${basename}.${extension}`;
}

// ---------------------------------------------------------------------------
// Equality / comparison helpers
// ---------------------------------------------------------------------------

function noteStatesEqual(left: NoteState, right: NoteState): boolean {
  return left.path === right.path
    && left.basename === right.basename
    && left.extension === right.extension
    && arraysEqual(left.tags, right.tags)
    && noteFrontmattersEqual(left, right);
}

function noteFrontmattersEqual(left: NoteState, right: NoteState): boolean {
  return arraysEqual(stateFrontmatterKeys(left), stateFrontmatterKeys(right))
    && frontmattersEqual(left.frontmatter, right.frontmatter);
}

function frontmattersEqual(left: Frontmatter, right: Frontmatter): boolean {
  return stableStringifyFrontmatter(left) === stableStringifyFrontmatter(right);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function appendUnique(target: RuleId[], values: readonly RuleId[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

function upsertDryRunMatches(target: DryRunRuleMatch[], values: readonly DryRunRuleMatch[]): void {
  for (const value of values) {
    const existingIndex = target.findIndex((match) => match.ruleId === value.ruleId);
    if (existingIndex === -1) {
      target.push(value);
    } else {
      target[existingIndex] = value;
    }
  }
}

function cloneFrontmatter(frontmatter: Frontmatter): Frontmatter {
  const next = Object.create(null) as Frontmatter;
  for (const key of Object.keys(frontmatter)) {
    next[key] = cloneFrontmatterValue(frontmatter[key]);
  }
  return next;
}

function cloneFrontmatterValue(value: FrontmatterValue): FrontmatterValue {
  if (Array.isArray(value)) {
    return [...value];
  }

  if (value !== null && typeof value === "object") {
    const next = Object.create(null) as Record<string, JsonScalar>;
    for (const key of Object.keys(value)) {
      if (!isUnsafeObjectKey(key)) {
        next[key] = value[key];
      }
    }
    return next;
  }

  return value;
}

function stableStringifyNoteState(state: NoteState): string {
  // Intentionally excludes stat, bodyH1, bodyContent — they're read-only inputs,
  // not part of the mutable desired state used for cycle detection.
  return JSON.stringify({
    path: state.path,
    basename: state.basename,
    extension: state.extension,
    frontmatter: sortValue(state.frontmatter),
    frontmatterKeys: stateFrontmatterKeys(state),
    tags: state.tags,
    frontmatterTags: stateFrontmatterTags(state),
  });
}

function stableStringifyFrontmatter(frontmatter: Frontmatter): string {
  return canonicalValue(frontmatter);
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

// ---------------------------------------------------------------------------
// Exported utility (used by settings.ts to check if a predicate needs content)
// ---------------------------------------------------------------------------

export function predicateNeedsBodyContent(predicate: RulePredicate): boolean {
  switch (predicate.type) {
    case "contentContains":
    case "contentRegex":
    case "wordCount":
      return true;
    case "all":
    case "any":
      return predicate.predicates.some(predicateNeedsBodyContent);
    case "not":
      return predicateNeedsBodyContent(predicate.predicate);
    default:
      return false;
  }
}
