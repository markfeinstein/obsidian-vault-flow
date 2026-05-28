import {
  BasesView,
  BooleanValue,
  NumberValue,
  debounce,
  FileValue,
  getLinkpath,
  Keymap,
  LinkValue,
  parseLinktext,
  StringValue,
  type BasesEntry,
  type BasesEntryGroup,
  type BasesPropertyId,
  type HoverParent,
  type HoverPopover,
  type QueryController,
  type TFile,
  type Value,
} from "obsidian";
import type { JsonScalar, Rule, RuleActionSet } from "../engine";
import { sanitizeRules } from "./settings";
import { renderFrontmatterDiff } from "./frontmatter-diff";
import { mapWithConcurrency } from "./concurrency";
import { planReconciliationForFile, type DryRunPreviewPlan } from "./dry-run-preview";
import { countFrontmatterChanges } from "./note-state";
import type { VaultFlowSettings } from "./settings";
import { VaultPreviewModal, type VaultPreviewApplyCallbacks, type VaultPreviewEntry } from "./vault-preview-modal";

export const VAULT_FLOW_BASES_VIEW_TYPE = "vault-flow-plan";
export type BasesPlanningMode = "rules" | "destination" | "rename" | "property";

export interface VaultFlowBasesViewHost {
  readonly getSettings: () => VaultFlowSettings;
  readonly getSettingsRevision: () => number;
  readonly previewCallbacks: VaultPreviewApplyCallbacks;
}

export interface PlannedBasesGroup {
  readonly label: string | null;
  readonly entries: readonly VaultPreviewEntry[];
}

interface CachedBasesPlan {
  readonly key: string;
  readonly plan: DryRunPreviewPlan;
}

export class VaultFlowBasesView extends BasesView implements HoverParent {
  public readonly type = VAULT_FLOW_BASES_VIEW_TYPE;
  public hoverPopover: HoverPopover | null = null;
  private readonly containerEl: HTMLElement;
  private readonly scheduleRefresh = debounce(() => { void this.refreshPlansSafely(); }, 100, true);
  private readonly planCache = new Map<string, CachedBasesPlan>();
  private dataRevision = 0;
  private refreshGeneration = 0;
  private plannedSettingsRevision = 0;
  private plannedDataRevision = 0;
  private entries: VaultPreviewEntry[] = [];
  private groups: readonly PlannedBasesGroup[] = [];
  private selectedPaths = new Set<string>();
  private currentPage = 0;

  public constructor(
    controller: QueryController,
    parentEl: HTMLElement,
    private readonly host: VaultFlowBasesViewHost,
  ) {
    super(controller);
    this.containerEl = parentEl.createDiv({ cls: "vf-bases-view" });
  }

  public override onDataUpdated(): void {
    this.dataRevision += 1;
    // Invalidate in-flight work immediately, not when the debounce eventually fires.
    this.refreshGeneration += 1;
    this.renderLoading();
    this.scheduleRefresh();
  }

  public override onunload(): void {
    this.scheduleRefresh.cancel();
    this.refreshGeneration += 1;
    this.planCache.clear();
    this.containerEl.empty();
  }

  private async refreshPlansSafely(options: { readonly clearCache?: boolean } = {}): Promise<void> {
    const expectedGeneration = this.refreshGeneration + 1;
    try {
      await this.refreshPlans(options);
    } catch (error) {
      if (expectedGeneration !== this.refreshGeneration) return;
      this.entries = [];
      this.selectedPaths.clear();
      this.containerEl.empty();
      this.containerEl.createEl("p", { text: `Could not plan Vault Flow changes: ${error instanceof Error ? error.message : String(error)}`, attr: { role: "alert" } });
      this.containerEl.createEl("button", { text: "Retry" }).addEventListener("click", () => {
        void this.refreshPlansSafely({ clearCache: true });
      });
    }
  }

  private async refreshPlans(options: { readonly clearCache?: boolean } = {}): Promise<void> {
    const generation = this.refreshGeneration + 1;
    this.refreshGeneration = generation;
    const dataRevision = this.dataRevision;
    if (options.clearCache === true) {
      this.planCache.clear();
    }
    this.renderLoading();

    const mode = this.mode();
    const destinationProperty = this.config.getAsPropertyId("destinationProperty");
    const destinationDisplayName = destinationProperty === null ? "Source value" : this.config.getDisplayName(destinationProperty);
    const actionOptions = {
      destinationKind: this.config.get("destinationKind") === "file" ? "file" as const : this.config.get("destinationKind") === "folder" ? "folder" as const : "auto" as const,
      propertyName: typeof this.config.get("propertyName") === "string" ? String(this.config.get("propertyName")).trim() : "",
    };
    const now = Date.now();
    const settings = this.host.getSettings();
    const settingsRevision = this.host.getSettingsRevision();
    const groupedEntries = this.data.groupedData.map((group) => ({
      source: group,
      entries: group.entries.filter((entry) => entry.file.extension.toLowerCase() === "md"),
    }));
    const markdownEntries = groupedEntries.flatMap((group) => group.entries);
    const plans = await mapWithConcurrency(markdownEntries, 4, async (entry) => {
      const cacheKey = `${basesPlanCacheKey(entry, mode, destinationProperty, settingsRevision, now)}\u0000${JSON.stringify(actionOptions)}`;
      const cached = this.planCache.get(entry.file.path);
      if (cached?.key === cacheKey) {
        return cached.plan;
      }
      const plan = await planBasesEntry(
        this.app,
        entry,
        settings,
        mode,
        destinationProperty,
        destinationDisplayName,
        now,
        actionOptions,
      );
      if (generation === this.refreshGeneration && dataRevision === this.dataRevision) {
        // Metadata/content availability and destination collisions can recover
        // without changing this note's stats. Never make those failures sticky.
        if (plan.preview.outcome === "error" || plan.preview.outcome === "skipped") this.planCache.delete(entry.file.path);
        else this.planCache.set(entry.file.path, { key: cacheKey, plan });
      }
      return plan;
    }, { isCancelled: () => generation !== this.refreshGeneration || dataRevision !== this.dataRevision });

    if (generation !== this.refreshGeneration || dataRevision !== this.dataRevision) {
      return;
    }
    if (settingsRevision !== this.host.getSettingsRevision()) {
      void this.refreshPlansSafely();
      return;
    }

    const plansByPath = new Map(plans.map((plan) => [plan.current.path, previewEntry(plan)]));
    this.plannedSettingsRevision = settingsRevision;
    this.plannedDataRevision = dataRevision;
    this.groups = groupedEntries.map((group) => ({
      label: basesGroupLabel(group.source),
      entries: group.entries
        .map((entry) => plansByPath.get(entry.file.path))
        .filter((entry): entry is VaultPreviewEntry => entry !== undefined),
    })).filter((group) => group.entries.length > 0);
    this.entries = this.groups.flatMap((group) => group.entries);
    const validPaths = new Set(this.entries.filter(isApplyableEntry).map((entry) => entry.path));
    this.selectedPaths = new Set([...this.selectedPaths].filter((path) => validPaths.has(path)));
    const pageCount = Math.max(1, Math.ceil(this.entries.length / this.pageSize()));
    this.currentPage = Math.min(this.currentPage, pageCount - 1);
    const currentPaths = new Set(markdownEntries.map((entry) => entry.file.path));
    for (const path of this.planCache.keys()) {
      if (!currentPaths.has(path)) this.planCache.delete(path);
    }
    this.render();
  }

  private renderLoading(): void {
    this.containerEl.empty();
    this.containerEl.createDiv({ cls: "vf-bases-loading", text: "Planning Vault Flow changes…" });
  }

  private render(): void {
    this.containerEl.empty();
    const actions = this.containerEl.createDiv({ cls: "vf-bases-actions" });
    actions.createEl("button", { text: "Refresh" }).addEventListener("click", () => {
      void this.refreshPlansSafely({ clearCache: true });
    });
    const previewButton = actions.createEl("button", { text: "Open apply preview", cls: "mod-cta" });
    previewButton.addEventListener("click", () => {
      const entries = this.entries.map((entry) => ({
        ...entry,
        selected: this.selectedPaths.has(entry.path),
      }));
      const expectedRevision = this.plannedSettingsRevision;
      const expectedDataRevision = this.plannedDataRevision;
      const baseAssertCanApply = this.host.previewCallbacks.assertCanApply;
      const basePreflightApply = this.host.previewCallbacks.preflightApply;
      new VaultPreviewModal(this.app, entries, {
        ...this.host.previewCallbacks,
        preflightApply: () => {
          basePreflightApply?.();
          if (this.dataRevision !== expectedDataRevision) {
            throw new Error("The Base results or configuration changed after this plan was generated. Refresh the view before applying.");
          }
          if (this.host.getSettingsRevision() !== expectedRevision) {
            throw new Error("Vault Flow settings changed after this Bases plan was generated. Refresh the view before applying.");
          }
        },
        assertCanApply: () => {
          baseAssertCanApply?.();
          if (this.host.getSettingsRevision() !== expectedRevision) {
            throw new Error("Vault Flow settings changed after this Bases plan was generated. Refresh the view before applying.");
          }
        },
      }).open();
    });
    const summary = actions.createSpan({ cls: "vf-muted vf-small-text" });
    const updateSelectionSummary = (): void => {
      previewButton.disabled = this.selectedPaths.size === 0;
      summary.setText(`${this.entries.length} Markdown result${this.entries.length === 1 ? "" : "s"} in the current filtered, sorted, and limited Base result set; ${this.selectedPaths.size} selected`);
    };
    updateSelectionSummary();

    if (this.entries.length === 0) {
      this.containerEl.createDiv({ cls: "vf-bases-empty", text: "No Markdown files match this Base view." });
      return;
    }

    const pageSize = this.pageSize();
    const pageCount = Math.max(1, Math.ceil(this.entries.length / pageSize));
    const pagination = actions.createDiv({ cls: "vf-bases-pagination" });
    const previousButton = pagination.createEl("button", { text: "Previous" });
    previousButton.disabled = this.currentPage === 0;
    previousButton.addEventListener("click", () => {
      this.currentPage = Math.max(0, this.currentPage - 1);
      this.render();
    });
    pagination.createSpan({ text: `Page ${this.currentPage + 1} of ${pageCount}`, cls: "vf-muted vf-small-text" });
    const nextButton = pagination.createEl("button", { text: "Next" });
    nextButton.disabled = this.currentPage >= pageCount - 1;
    nextButton.addEventListener("click", () => {
      this.currentPage = Math.min(pageCount - 1, this.currentPage + 1);
      this.render();
    });

    const table = this.containerEl.createEl("table", { cls: "vf-preview-table vf-bases-table" });
    const header = table.createEl("thead").createEl("tr");
    for (const name of ["Apply", "Status", "File", "New path", "Property changes"]) {
      header.createEl("th", { text: name, cls: "vf-preview-header-cell", attr: { scope: "col" } });
    }

    const body = table.createEl("tbody");
    const pageGroups = paginateBasesGroups(this.groups, this.currentPage, pageSize);
    for (const group of pageGroups) {
      if (group.label !== null) {
        const groupRow = body.createEl("tr", { cls: "vf-bases-group-row" });
        groupRow.createEl("th", { text: group.label, attr: { colspan: "5", scope: "rowgroup" } });
      }
      for (const entry of group.entries) {
        const row = body.createEl("tr");
        const selectionCell = row.createEl("td", { cls: "vf-preview-cell" });
        const checkbox = selectionCell.createEl("input", {
          type: "checkbox",
          attr: { "aria-label": `Apply planned change for ${entry.path}` },
        });
        const applyable = isApplyableEntry(entry);
        checkbox.disabled = !applyable;
        checkbox.checked = applyable && this.selectedPaths.has(entry.path);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selectedPaths.add(entry.path);
          else this.selectedPaths.delete(entry.path);
          updateSelectionSummary();
        });

        row.createEl("td", { cls: "vf-preview-cell vf-preview-status", text: entry.preview.preview.outcome });
        const fileCell = row.createEl("td", { cls: "vf-preview-cell vf-preview-path" });
        const fileLink = fileCell.createEl("a", { text: entry.path, href: "#" });
        fileLink.onClickEvent((event) => {
          if (event.button !== 0 && event.button !== 1) return;
          event.preventDefault();
          void this.app.workspace.openLinkText(entry.path, "", Keymap.isModEvent(event));
        });
        fileLink.addEventListener("mouseover", (event) => {
          this.app.workspace.trigger("hover-link", {
            event,
            source: VAULT_FLOW_BASES_VIEW_TYPE,
            hoverParent: this,
            targetEl: fileLink,
            linktext: entry.path,
          });
        });
        row.createEl("td", {
          cls: `vf-preview-cell vf-preview-path${entry.desiredPath === undefined ? " vf-muted" : ""}`,
          text: entry.desiredPath ?? "—",
        });
        row.createEl("td", {
          cls: `vf-preview-cell vf-preview-count${entry.propertyChangeCount === 0 ? " vf-muted" : ""}`,
          text: entry.propertyChangeCount === 0 ? "—" : String(entry.propertyChangeCount),
        });
        if (entry.preview.result !== null && entry.propertyChangeCount > 0) {
          const detailRow = body.createEl("tr");
          const detailCell = detailRow.createEl("td", { attr: { colspan: "5" } });
          renderFrontmatterDiff(detailCell, entry.preview.current, entry.preview.result.desired);
        }
        if (entry.preview.preview.outcome === "error" || entry.preview.preview.outcome === "skipped") {
          const messageRow = body.createEl("tr");
          messageRow.createEl("td", { text: entry.preview.preview.message, attr: { colspan: "5" } });
        }
      }
    }
  }

  private mode(): BasesPlanningMode {
    const mode = this.config.get("mode");
    return mode === "destination" || mode === "rename" || mode === "property" ? mode : "rules";
  }

  private pageSize(): number {
    const value = this.config.get("pageSize");
    return typeof value === "number" && Number.isFinite(value)
      ? Math.min(500, Math.max(25, Math.round(value)))
      : 100;
  }
}

function basesPlanCacheKey(
  entry: BasesEntry,
  mode: BasesPlanningMode,
  destinationProperty: BasesPropertyId | null,
  settingsRevision: number,
  now: number,
): string {
  const destinationValue = mode !== "rules" && destinationProperty !== null
    ? basesValueFingerprint(entry.getValue(destinationProperty))
    : "rules";
  const timeBucket = Math.floor(now / 60_000);
  return [
    entry.file.path,
    entry.file.stat.ctime,
    entry.file.stat.mtime,
    settingsRevision,
    mode,
    destinationProperty ?? "",
    destinationValue,
    timeBucket,
  ].join("\u0000");
}

function basesValueFingerprint(value: Value | null): string {
  if (value === null) return "null";
  return `${value.constructor.name}:${value.isTruthy() ? "1" : "0"}:${value.toString()}`;
}

function basesGroupLabel(group: BasesEntryGroup): string | null {
  if (!group.hasKey() || group.key === undefined) {
    return null;
  }
  const label = group.key.toString().trim();
  return label.length === 0 ? "No value" : label;
}

function isApplyableEntry(entry: VaultPreviewEntry): boolean {
  return entry.preview.result !== null && entry.preview.preview.outcome === "changed";
}

export function paginateBasesGroups(
  groups: readonly PlannedBasesGroup[],
  page: number,
  pageSize: number,
): readonly PlannedBasesGroup[] {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const start = Math.max(0, Math.floor(page)) * safePageSize;
  const end = start + safePageSize;
  let offset = 0;
  const pageGroups: PlannedBasesGroup[] = [];
  for (const group of groups) {
    const groupStart = offset;
    const groupEnd = offset + group.entries.length;
    offset = groupEnd;
    if (groupEnd <= start || groupStart >= end) continue;
    const sliceStart = Math.max(0, start - groupStart);
    const sliceEnd = Math.min(group.entries.length, end - groupStart);
    pageGroups.push({ label: group.label, entries: group.entries.slice(sliceStart, sliceEnd) });
  }
  return pageGroups;
}

export async function planBasesEntry(
  app: VaultFlowBasesView["app"],
  entry: BasesEntry,
  settings: VaultFlowSettings,
  mode: BasesPlanningMode,
  destinationProperty: BasesPropertyId | null,
  destinationDisplayName: string,
  now: number,
  options: { readonly destinationKind?: "auto" | "folder" | "file"; readonly propertyName?: string } = {},
): Promise<DryRunPreviewPlan> {
  if (mode === "rules") {
    return planReconciliationForFile(app, entry.file, settings, { now, triggerContext: "manual" });
  }
  if (destinationProperty === null) {
    return basesErrorPlan(app, entry.file, settings, "Choose a destination property in the view settings.", now);
  }

  const value = entry.getValue(destinationProperty);
  let actions: RuleActionSet;
  if (mode === "property") {
    const property = options.propertyName?.trim() ?? "";
    if (property.length === 0) return basesErrorPlan(app, entry.file, settings, "Choose a target property name.", now);
    const converted = scalarFromBasesValue(value);
    if (converted.status === "error") return basesErrorPlan(app, entry.file, settings, converted.message, now);
    actions = { setProperties: { [property]: converted.value } };
  } else if (mode === "rename") {
    if (!(value instanceof StringValue) || value instanceof LinkValue || value.toString().trim().length === 0) {
      return basesErrorPlan(app, entry.file, settings, "Rename values must be nonempty text. Use a text-valued formula.", now);
    }
    actions = { renameTo: literalTemplate(value.toString()) };
  } else {
    const destinationResult = destinationFromBasesValue(value, options.destinationKind === "file");
    if (destinationResult.status === "error") {
      return basesErrorPlan(app, entry.file, settings, `The ${destinationDisplayName} value ${destinationResult.message}`, now);
    }
    actions = { moveTo: literalTemplate(destinationResult.destination), moveToKind: options.destinationKind ?? "auto" };
  }

  const destinationRule: Rule = {
    id: "bases-derived",
    name: "Bases derived action",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "pathGlob", glob: "**" },
    then: actions,
    stopOnMatch: true,
    runOn: "manual",
  };
  if (sanitizeRules([destinationRule]).rules.length !== 1) {
    return basesErrorPlan(app, entry.file, settings, "The derived action has an unsafe target property or path.", now);
  }
  return planReconciliationForFile(
    app,
    entry.file,
    { ...settings, rules: [destinationRule] },
    { now, triggerContext: "manual" },
  );
}

function literalTemplate(value: string): string {
  return value.split("{").join("{{").split("}").join("}}");
}

export function scalarFromBasesValue(value: Value | null): { readonly status: "ready"; readonly value: JsonScalar } | { readonly status: "error"; readonly message: string } {
  if (value instanceof StringValue) return { status: "ready", value: value.toString() };
  if (value instanceof BooleanValue) return { status: "ready", value: value.isTruthy() };
  if (value instanceof NumberValue) {
    const number = Number(value.toString());
    if (Number.isFinite(number)) return { status: "ready", value: number };
  }
  return { status: "error", message: "Property values must be text, finite numbers, or booleans. Format other values as text in a formula." };
}

export type BasesDestinationResult =
  | { readonly status: "ready"; readonly destination: string }
  | { readonly status: "error"; readonly message: string };

export function destinationFromBasesValue(value: Value | null, preserveExtension = false): BasesDestinationResult {
  if (value === null || !value.isTruthy()) {
    return { status: "error", message: "is empty or invalid." };
  }

  if (value instanceof LinkValue) {
    const linkPath = linkPathFromBasesValue(value.toString(), preserveExtension);
    return linkPath.length === 0
      ? { status: "error", message: "does not contain a valid link destination." }
      : { status: "ready", destination: linkPath };
  }

  if (value instanceof StringValue || value instanceof FileValue) {
    const destination = value.toString().trim();
    return destination.length === 0
      ? { status: "error", message: "is empty." }
      : { status: "ready", destination };
  }

  return {
    status: "error",
    message: `has unsupported type ${value.constructor.name || "Value"}; use a text, link, or file-valued property or formula.`,
  };
}

function linkPathFromBasesValue(value: string, preserveExtension: boolean): string {
  const trimmed = value.trim();
  const wikilinkMatch = /^!?\[\[([\s\S]*)\]\]$/u.exec(trimmed);
  const linktextWithAlias = wikilinkMatch?.[1] ?? trimmed;
  const aliasSeparator = linktextWithAlias.indexOf("|");
  const linktext = aliasSeparator === -1 ? linktextWithAlias : linktextWithAlias.slice(0, aliasSeparator);
  const path = getLinkpath(parseLinktext(linktext.trim()).path).trim();
  return preserveExtension ? path : path.replace(/\.md$/iu, "");
}

async function basesErrorPlan(
  app: VaultFlowBasesView["app"],
  file: TFile,
  settings: VaultFlowSettings,
  message: string,
  now: number,
): Promise<DryRunPreviewPlan> {
  const basePlan = await planReconciliationForFile(
    app,
    file,
    { ...settings, rules: [] },
    { now, triggerContext: "manual" },
  );
  if (basePlan.preview.outcome === "excluded" || basePlan.preview.outcome === "error") {
    return basePlan;
  }
  return {
    ...basePlan,
    result: null,
    preview: {
      outcome: "error",
      path: basePlan.current.path,
      appliedRuleIds: [],
      involvedRuleIds: [],
      mutationKinds: [],
      iterations: 0,
      message,
    },
  };
}

function previewEntry(plan: DryRunPreviewPlan): VaultPreviewEntry {
  return {
    path: plan.preview.path,
    desiredPath: plan.preview.desiredPath,
    propertyChangeCount: plan.result === null ? 0 : countFrontmatterChanges(plan.current, plan.result.desired),
    preview: plan,
  };
}
