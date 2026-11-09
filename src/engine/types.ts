export type JsonScalar = string | number | boolean | null;
export type FrontmatterValue = JsonScalar | JsonScalar[] | Record<string, JsonScalar>;
export type Frontmatter = Record<string, FrontmatterValue>;

export interface NoteStat {
  readonly ctime: number;
  readonly mtime: number;
}

export interface NoteState {
  readonly path: string;
  readonly basename: string;
  readonly extension: string;
  readonly frontmatter: Frontmatter;
  /** All raw frontmatter keys, including properties whose YAML values are not rule-editable. */
  readonly frontmatterKeys?: readonly string[];
  /** Complete source frontmatter snapshot used only for optimistic write validation. */
  readonly rawFrontmatter?: Readonly<Record<string, unknown>>;
  /** All tags visible to Obsidian, including inline body tags and frontmatter tags. */
  readonly tags: readonly string[];
  /** Tags stored specifically in the frontmatter `tags` property. */
  readonly frontmatterTags?: readonly string[];
  /** Tags found specifically in the Markdown body. */
  readonly inlineTags?: readonly string[];
  /** File creation / modification timestamps. Required by fileAge predicates. */
  readonly stat?: NoteStat;
  /** First H1 heading from the note body, if available. */
  readonly bodyH1?: string;
  /** Full body content string, used by contentContains predicate. Loaded on demand. */
  readonly bodyContent?: string;
  /** Compact reviewed previews retain a SHA-256 baseline rather than the note body. */
  readonly bodyFingerprint?: string;
}

export type RuleId = string;

export type RuleRunOn = "always" | "live" | "sweep" | "manual";

export interface Rule {
  readonly id: RuleId;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly order: number;
  readonly when: RulePredicate;
  readonly then: RuleActionSet;
  /** When true, stop evaluating further rules once this rule fires. Default: false. */
  readonly stopOnMatch?: boolean;
  /**
   * Controls which triggers cause this rule to run.
   * - "always"  (default) – run on every trigger
   * - "live"    – only when a note changes while Obsidian is open
   * - "sweep"   – only during startup sweep or periodic sweep
   * - "manual"  – only when triggered by a command
   */
  readonly runOn?: RuleRunOn;
  /**
   * When true, the rule evaluates normally (conditions are checked) but its actions are NOT applied.
   * The rule's ID is reported in ReconciliationConverged.dryRunRuleIds.
   */
  readonly dryRun?: boolean;
}

export type RulePredicate =
  | { readonly type: "tag"; readonly tag: string }
  | { readonly type: "pathGlob"; readonly glob: string }
  | { readonly type: "basename"; readonly pattern: string }
  | { readonly type: "frontmatterValue"; readonly property: string; readonly value: JsonScalar }
  | { readonly type: "frontmatterExists"; readonly property: string }
  | { readonly type: "frontmatterMissing"; readonly property: string }
  | { readonly type: "frontmatterContains"; readonly property: string; readonly value: string }
  | { readonly type: "sourceUrl"; readonly property: string; readonly host: string }
  | { readonly type: "fileAge"; readonly field: "ctime" | "mtime"; readonly olderThanDays?: number; readonly newerThanDays?: number }
  | { readonly type: "bodyH1"; readonly pattern: string }
  | { readonly type: "contentContains"; readonly text: string }
  | { readonly type: "all"; readonly predicates: readonly RulePredicate[] }
  | { readonly type: "any"; readonly predicates: readonly RulePredicate[] }
  | { readonly type: "not"; readonly predicate: RulePredicate }
  | { readonly type: "frontmatterRegex"; readonly property: string; readonly pattern: string }
  | { readonly type: "frontmatterDateAge"; readonly property: string; readonly olderThanDays?: number; readonly newerThanDays?: number }
  | { readonly type: "wordCount"; readonly moreThan?: number; readonly lessThan?: number }
  | { readonly type: "tagPrefix"; readonly prefix: string }
  | { readonly type: "contentRegex"; readonly pattern: string };

export interface RuleActionSet {
  readonly moveTo?: string;
  /** Explicit destination intent. Omitted/auto retains the legacy dot/trailing-slash heuristic. */
  readonly moveToKind?: "auto" | "folder" | "file";
  /**
   * Template string for renaming the note's basename. Supports:
   * - {property}     – frontmatter value
   * - {basename}     – current basename
   * - {date}         – frontmatter `date` value, when present
   * - {date:FORMAT}  – today's date in moment-style format (YYYY MM DD HH mm ss)
   * - {1} {2} …      – capture groups from the matching basename regex predicate
   * - {{             – literal {
   * If any referenced property is missing or non-scalar the action is silently skipped.
   */
  readonly renameTo?: string;
  readonly addTags?: readonly string[];
  /** Tags to remove. Only removes from the frontmatter `tags` field; inline body tags are unaffected. */
  readonly removeTags?: readonly string[];
  readonly setProperties?: Readonly<Record<string, FrontmatterValue>>;
  /** Frontmatter property keys to delete entirely. */
  readonly deleteProperties?: readonly string[];
  /**
   * Replace the entire tag list with exactly these tags.
   * Unlike addTags (which merges), this removes all existing frontmatter tags not in the list.
   * Note: inline body tags cannot be removed; they remain visible but are excluded from
   * rule matching on subsequent reads.
   */
  readonly replaceTags?: readonly string[];
  /** Set properties only if they are not already present in the note's frontmatter. */
  readonly initProperties?: Readonly<Record<string, FrontmatterValue>>;
  /** Append a string to a frontmatter property (space-separated). If missing, sets it. Skips non-string existing values. */
  readonly appendToProperty?: Readonly<Record<string, string>>;
}

export interface PredicateTrace {
  readonly predicate: RulePredicate;
  readonly matched: boolean;
  readonly captures: readonly string[];
  readonly contentCaptures: readonly string[];
  /** Only evaluated children are present; later short-circuited children are omitted. */
  readonly children?: readonly PredicateTrace[];
}

export interface RuleEvaluationTrace {
  readonly iteration: number;
  readonly ruleId: RuleId;
  readonly ruleName: string;
  readonly outcome: "not-matched" | "applied" | "dry-run";
  readonly predicate: PredicateTrace;
  readonly before: NoteState;
  readonly after: NoteState;
  readonly messages: readonly string[];
}

export interface ReconciliationOptions {
  readonly maxIterations: number;
  /** Current timestamp (ms since epoch). Defaults to Date.now() if omitted. Used for date templates and fileAge. */
  readonly now?: number;
  /** Trigger context(s) used to filter rules by their runOn field. */
  readonly triggerContext?: RuleRunOn | readonly RuleRunOn[];
  /** Optional platform date formatter. Obsidian integrations should provide Moment.js formatting. */
  readonly formatDate?: (timestamp: number, format: string) => string;
  /** Opt-in, read-only diagnostics. Normal reconciliation does not construct traces. */
  readonly onRuleEvaluated?: (trace: RuleEvaluationTrace) => void;
  /** Planning probe: stop only if evaluation actually reaches an unavailable body input. */
  readonly onMissingBodyContent?: () => never;
}

export interface ReconciliationInput {
  readonly file: NoteState;
  readonly rules: readonly Rule[];
  readonly options: ReconciliationOptions;
}

export interface PlannedMutation {
  readonly kind: "move" | "rename" | "frontmatter";
  readonly ruleIds: readonly RuleId[];
}

export interface DryRunRuleMatch {
  readonly ruleId: RuleId;
  readonly desired: NoteState;
  readonly mutations: readonly PlannedMutation[];
}

export interface ReconciliationConverged {
  readonly status: "converged";
  readonly desired: NoteState;
  readonly mutations: readonly PlannedMutation[];
  readonly appliedRuleIds: readonly RuleId[];
  readonly iterations: number;
  readonly changed: boolean;
  /** Rule IDs for rules with dryRun:true that matched during this reconciliation. Their actions were not applied. */
  readonly dryRunRuleIds: readonly RuleId[];
  /** Hypothetical per-rule plans for matching dry-run rules. */
  readonly dryRunMatches?: readonly DryRunRuleMatch[];
}

export interface ReconciliationCycleDetected {
  readonly status: "cycle-detected";
  readonly iterations: number;
  readonly involvedRuleIds: readonly RuleId[];
  readonly states: readonly NoteState[];
}

export interface ReconciliationMaxIterationsExceeded {
  readonly status: "max-iterations-exceeded";
  readonly iterations: number;
  readonly involvedRuleIds: readonly RuleId[];
  readonly states: readonly NoteState[];
}

export type ReconciliationResult = ReconciliationConverged | ReconciliationCycleDetected | ReconciliationMaxIterationsExceeded;
