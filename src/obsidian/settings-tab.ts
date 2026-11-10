import {
  ConfirmationModal,
  FuzzySuggestModal,
  Modal,
  Notice,
  PluginSettingTab,
  prepareFuzzySearch,
  Setting,
  type App,
  type Plugin,
  type SettingDefinitionItem,
  type TFolder,
} from "obsidian";
import type { Rule } from "../engine";
import { MIN_SWEEP_INTERVAL_MS } from "./periodic-schedule";
import { ruleConvergenceWarnings } from "./rule-warnings";
import {
  createDefaultRuleDraft,
  createRuleFromDraft,
  deleteRuleById,
  draftFromRule,
  reindexRules,
  setRuleEnabled,
  summarizeRule,
  updateRuleById,
  type EditablePredicateType,
  type RuleEditResult,
  type VisualConditionNode,
  type VisualCriterionDraft,
  type VisualRuleDraft,
} from "./rule-editor-model";
import { formatRuleExport, formatRuleImportReport, MAX_RULE_IMPORT_TEXT_LENGTH, parseRuleImport, type RuleImportDetails } from "./rule-io";
import { sanitizeRules, type CollisionPolicy, type VaultFlowSettings } from "./settings";
import { mergeRuleEdit } from "./rule-edits";
import { readRuleFixtures, runRuleFixtures } from "../engine/rule-fixtures";
import { formatSemanticChanges, semanticRuleChanges } from "./rule-semantic-diff";

export interface VaultFlowSettingsHost {
  getSettings(): VaultFlowSettings;
  updateSettings(settings: Partial<VaultFlowSettings>): Promise<void>;
  runAllRulesNow?(): void;
  isAutomationPaused?(): boolean;
  setAutomationPaused?(paused: boolean): void;
}

export type VaultFlowSettingsPlugin = VaultFlowSettingsHost & Plugin;

type MutableCriterionDraft = {
  predicateType: EditablePredicateType;
  negated: boolean;
  tag: string;
  pathGlob: string;
  basenamePattern: string;
  frontmatterValueProperty: string;
  frontmatterValueValue: string;
  frontmatterContainsSearchValue: string;
  sourceUrlProperty: string;
  sourceUrlHost: string;
  fileAgeField: "ctime" | "mtime";
  fileAgeOlderThanDays: string;
  fileAgeNewerThanDays: string;
  contentContainsText: string;
  frontmatterRegexPattern: string;
  frontmatterDateAgeProperty: string;
  wordCountMoreThan: string;
  wordCountLessThan: string;
  tagPrefixValue: string;
  contentRegexPattern: string;
};

type MutableConditionGroup = {
  mode: "all" | "any";
  conditions: MutableCriterionDraft[];
  negated: boolean;
};

type MutableConditionNode =
  | { kind: "criterion"; criterion: MutableCriterionDraft }
  | { kind: "group"; group: MutableConditionGroup };

type MutableRuleDraft = {
  name: string;
  enabled: boolean;
  priority: string;
  order: string;
  criteriaMode: "all" | "any";
  criteria: MutableCriterionDraft[];
  conditionNodes: MutableConditionNode[];
  stopOnMatch: boolean;
  dryRun: boolean;
  runOn: "always" | "live" | "sweep" | "manual";
  moveTo: string;
  moveToKind: "auto" | "folder" | "file";
  renameTo: string;
  addTags: string;
  removeTags: string;
  replaceTags: string;
  replaceTagsEnabled: boolean;
  setPropertiesJson: string;
  initPropertiesJson: string;
  appendToPropertyJson: string;
  deletePropertiesList: string;
};

export class VaultFlowSettingTab extends PluginSettingTab {
  public constructor(
    app: App,
    private readonly host: VaultFlowSettingsPlugin,
  ) {
    super(app, host);
    this.icon = "workflow";
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = this.host.getSettings();
    const orderedRules = orderedRulesForDisplay(settings.rules);

    return [
      {
        type: "page",
        name: "Automation",
        desc: "Configure startup, periodic, and live reconciliation behavior.",
        items: [
          {
            name: "Pause writes for this session",
            desc: "Park queued work and block new apply/undo transactions on this device. In-flight writes finish or roll back.",
            control: { type: "toggle", key: "automationPaused" },
          },
          {
            name: "Sweep on startup",
        desc: "After the workspace is ready, process monitored notes whose modification time is new or changed.",
        control: { type: "toggle", key: "sweepOnStartup" },
      },
      {
        name: "Periodic sweep",
        desc: "Periodically check for changes missed while Vault Flow was inactive.",
        control: { type: "toggle", key: "periodicSweepEnabled" },
      },
      {
        name: "Sweep interval",
        desc: "Minutes between periodic sweeps.",
        visible: () => this.host.getSettings().periodicSweepEnabled,
        control: {
          type: "number",
          key: "sweepIntervalMinutes",
          min: Math.max(1, formatMinutes(MIN_SWEEP_INTERVAL_MS)),
          step: 1,
          validate: (value) => value * 60_000 < MIN_SWEEP_INTERVAL_MS
            ? `Use at least ${formatMinutes(MIN_SWEEP_INTERVAL_MS)} minute(s).`
            : undefined,
        },
      },
        ],
      },
      {
        type: "page",
        name: "Scope and safety",
        desc: "Choose which notes Vault Flow may process and how path collisions are handled.",
        items: [
          {
            type: "list",
            heading: "Monitored folders",
        emptyState: "The entire vault is monitored.",
        items: settings.monitoredFolders.map((folder) => ({
          id: `monitored-folder:${folder}`,
          name: folder,
          desc: "Vault Flow includes this folder and its descendants.",
        })),
        onDelete: (index) => {
          const folder = settings.monitoredFolders[index];
          if (folder !== undefined) void this.removeMonitoredFolder(folder);
        },
        addItem: {
          name: "Add monitored folder",
          action: () => {
            new FolderSuggestModal(this.app, (folder) => {
              void this.addMonitoredFolder(folder.path);
            }).open();
          },
        },
      },
      {
        type: "group",
        heading: "Scope and safety",
        items: [
          {
            name: "Exclusion patterns",
            desc: "One glob per line. Matching files and folders are never processed.",
            control: {
              type: "textarea",
              key: "exclusionPatternsText",
              rows: 4,
              placeholder: "Templates/**\nArchive/**",
            },
          },
          {
            name: "Per-file disable key",
            desc: "A truthy value in this frontmatter property disables Vault Flow for the note.",
            control: {
              type: "text",
              key: "disableFrontmatterKey",
              placeholder: "vault-flow-disable",
              validate: (value) => value.trim().length === 0 ? "Enter a property name." : undefined,
            },
          },
          {
            name: "Path collision policy",
            desc: "Choose what happens when the destination already exists.",
            control: {
              type: "dropdown",
              key: "collisionPolicy",
              options: {
                skip: "Skip and log a warning",
                "rename-with-suffix": "Use an available numeric suffix",
              },
            },
          },
        ],
      },
        ],
      },
      {
        type: "page",
        name: "Rules",
        desc: "Create, search, reorder, import, and export reconciliation rules.",
        displayValue: () => `${this.host.getSettings().rules.length} rule${this.host.getSettings().rules.length === 1 ? "" : "s"}`,
        items: [
          {
            type: "list",
            heading: "Rules",
        emptyState: "No rules are configured.",
        search: {
          placeholder: "Search rules",
          match: (definition, query) => {
            const searchable = [definition.name, definition.desc, ...(definition.aliases ?? [])]
              .map((value) => typeof value === "string" ? value : value?.textContent ?? "")
              .join(" ");
            const normalizedQuery = query.trim();
            return normalizedQuery.length === 0 || prepareFuzzySearch(normalizedQuery)(searchable) !== null;
          },
        },
        extraButtons: [
          (button) => button.setIcon("list-plus").setTooltip("Add preset rule").onClick(() => {
            new PresetRulesModal(this.app, this.host, () => { this.update(); }).open();
          }),
          (button) => button.setIcon("import").setTooltip("Import rules from JSON").onClick(() => {
            this.openImportModal();
          }),
          (button) => button.setIcon("file-up").setTooltip("Import rules from file").onClick(() => {
            this.importFromFile();
          }),
          (button) => button.setIcon("copy").setTooltip("Export all rules").onClick(() => {
            this.openExportModal(settings.rules);
          }),
        ],
        items: orderedRules.map((rule) => {
          const summary = summarizeRule(rule);
          const stats = settings.ruleStats[rule.id];
          const warningsText = ruleConvergenceWarnings(rule).map((warning) => ` Warning: ${warning}`).join("");
          const statsText = stats === undefined || stats.matchCount === 0
            ? ""
            : ` ${stats.matchCount} recorded match${stats.matchCount === 1 ? "" : "es"}.`;
          return {
            // Public since 1.14; the 1.14.4 npm typings do not declare it yet.
            id: rule.id,
            name: summary.name,
            aliases: [summary.id, summary.predicate, summary.actions],
            desc: `When ${summary.predicate}. Then ${summary.actions}.${statsText}${warningsText}`,
            render: (setting) => {
              setting
                .setName(summary.name)
                .setDesc(`When ${summary.predicate}. Then ${summary.actions}.${statsText}${warningsText}`)
                .addToggle((toggle) => {
                  toggle
                    .setTooltip(rule.enabled ? "Disable rule" : "Enable rule")
                    .setValue(rule.enabled)
                    .onChange((enabled) => {
                      void this.setRuleEnabled(rule.id, enabled);
                    });
                })
                .addButton((button) => {
                  button.setButtonText("Edit").onClick(() => { this.openRuleEditor(rule); });
                });
            },
          };
        }),
        onReorder: (oldIndex, newIndex) => {
          void this.reorderRules(orderedRules, oldIndex, newIndex);
        },
        onDelete: (index) => {
          const rule = orderedRules[index];
          if (rule !== undefined) void this.confirmDeleteRule(rule);
        },
        addItem: {
          name: "Add rule",
          action: () => { this.openRuleEditor(null); },
        },
      },
        ],
      },
      {
        type: "page",
        name: "Advanced",
        desc: "Configure dry-run behavior, queue timing, convergence limits, and manual execution.",
        items: [
          {
            type: "group",
            heading: "Advanced",
        items: [
          {
            name: "Dry-run mode",
            desc: "Plan and log changes without modifying notes or paths.",
            control: { type: "toggle", key: "dryRun" },
          },
          {
            name: "Debounce delay",
            desc: "Milliseconds to wait after a note changes before reconciling it.",
            control: {
              type: "number",
              key: "debounceMs",
              min: 50,
              max: 60_000,
              step: 50,
            },
          },
          {
            name: "Maximum iterations",
            desc: "Maximum reconciliation passes before reporting non-convergence.",
            control: {
              type: "number",
              key: "maxIterations",
              min: 1,
              max: 100,
              step: 1,
            },
          },
          {
            name: "Maximum writes per minute",
            desc: "Pause all writes when this many transactions start in a rolling minute. Resume explicitly after reviewing diagnostics.",
            control: { type: "number", key: "maxWritesPerMinute", min: 1, step: 1 },
          },
          {
            name: "Maximum batch writes",
            desc: "Maximum selected rows in a reviewed apply batch. Narrow the selection or explicitly raise this limit.",
            control: { type: "number", key: "maxBatchWrites", min: 1, step: 1 },
          },
          {
            name: "Run monitored rules now",
            desc: "Enqueue every currently monitored Markdown note with the manual trigger.",
            action: () => { this.host.runAllRulesNow?.(); },
          },
        ],
      },
    ],
  },
    ];
  }

  override getControlValue(key: string): unknown {
    const settings = this.host.getSettings();
    switch (key) {
      case "automationPaused":
        return this.host.isAutomationPaused?.() ?? false;
      case "sweepIntervalMinutes":
        return msToMinutes(settings.sweepIntervalMs);
      case "exclusionPatternsText":
        return settings.exclusionPatterns.join("\n");
      default:
        return (settings as unknown as Record<string, unknown>)[key];
    }
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case "automationPaused":
        if (typeof value === "boolean") this.host.setAutomationPaused?.(value);
        break;
      case "sweepIntervalMinutes":
        if (typeof value === "number") {
          await this.host.updateSettings({ sweepIntervalMs: minutesToMs(value) });
        }
        break;
      case "exclusionPatternsText":
        if (typeof value === "string") {
          await this.host.updateSettings({ exclusionPatterns: splitFolderList(value) });
        }
        break;
      case "sweepOnStartup":
      case "periodicSweepEnabled":
        if (typeof value === "boolean") {
          await this.host.updateSettings({ [key]: value });
        }
        break;
      case "dryRun":
        if (typeof value === "boolean") {
          if (!value && this.host.getSettings().dryRun) {
            const confirmed = await confirmAction(
              this.app,
              "Disable dry-run mode",
              "Vault Flow will be allowed to move notes and write frontmatter during live, sweep, and manual reconciliation.",
              "Disable dry-run",
            );
            if (!confirmed) break;
          }
          await this.host.updateSettings({ dryRun: value });
        }
        break;
      case "collisionPolicy":
        if (typeof value === "string" && isCollisionPolicy(value)) {
          await this.host.updateSettings({ collisionPolicy: value });
        }
        break;
      case "disableFrontmatterKey":
        if (typeof value === "string" && value.trim().length > 0) {
          await this.host.updateSettings({ disableFrontmatterKey: value.trim() });
        }
        break;
      case "debounceMs":
      case "maxIterations":
      case "maxWritesPerMinute":
      case "maxBatchWrites":
        if (typeof value === "number" && Number.isInteger(value) && value > 0) {
          await this.host.updateSettings({ [key]: value });
        }
        break;
    }
    this.refreshDomState();
  }

  private async addMonitoredFolder(path: string): Promise<void> {
    const folders = [...this.host.getSettings().monitoredFolders];
    if (!folders.includes(path)) {
      folders.push(path);
      await this.host.updateSettings({ monitoredFolders: folders });
      this.update();
    }
  }

  private async removeMonitoredFolder(path: string): Promise<void> {
    await this.host.updateSettings({
      monitoredFolders: this.host.getSettings().monitoredFolders.filter((folder) => folder !== path),
    });
    this.update();
  }

  private async setRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
    await this.host.updateSettings({ rules: setRuleEnabled(this.host.getSettings().rules, ruleId, enabled) });
    this.update();
  }

  private async reorderRules(rules: readonly Rule[], oldIndex: number, newIndex: number): Promise<void> {
    if (oldIndex === newIndex || oldIndex < 0 || newIndex < 0 || oldIndex >= rules.length || newIndex >= rules.length) {
      return;
    }
    const reordered = [...rules];
    const [rule] = reordered.splice(oldIndex, 1);
    if (rule === undefined) return;
    reordered.splice(newIndex, 0, rule);
    await this.host.updateSettings({ rules: reindexRules(reordered) });
    this.update();
  }

  private async confirmDeleteRule(rule: Rule): Promise<void> {
    const confirmed = await confirmAction(
      this.app,
      "Delete rule",
      `Delete “${rule.name}”? This cannot be undone.`,
      "Delete",
    );
    if (!confirmed) return;
    await this.host.updateSettings({ rules: deleteRuleById(this.host.getSettings().rules, rule.id) });
    this.update();
  }

  private openRuleEditor(existingRule: Rule | null): void {
    const baseline = this.host.getSettings().rules;
    new RuleEditorModal(
      this.app,
      existingRule,
      baseline,
      async (result) => {
        if (result.status !== "ok") return false;
        const merged = mergeRuleEdit(this.host.getSettings().rules, baseline, result.rules);
        if (merged.status === "error") { new Notice(merged.error); return false; }
        await this.host.updateSettings({ rules: merged.rules });
        this.update();
        return true;
      },
    ).open();
  }

  private openImportModal(): void {
    new RuleImportModal(
      this.app,
      async (rules) => {
        await this.host.updateSettings({ rules });
        this.update();
      },
    ).open();
  }

  private importFromFile(): void {
    const ownerDocument = this.containerEl.ownerDocument;
    const input = ownerDocument.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.className = "vf-hidden-file-input";
    ownerDocument.body.appendChild(input);
    const removeInput = (): void => { input.remove(); };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file === undefined || file === null) {
        removeInput();
        return;
      }
      if (file.size > MAX_RULE_IMPORT_TEXT_LENGTH) {
        removeInput();
        new Notice("Vault Flow import error: Rule import is too large.");
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        removeInput();
        const text = event.target?.result;
        if (typeof text !== "string") {
          new Notice("Vault Flow could not read the selected file.");
          return;
        }
        void this.applyRuleImportText(text, "file");
      };
      reader.onerror = () => {
        removeInput();
        new Notice("Vault Flow could not read the selected file.");
      };
      reader.readAsText(file);
    }, { once: true });
    input.click();
  }

  private async applyRuleImportText(text: string, source: "file" | "text"): Promise<boolean> {
    const result = parseRuleImport(text);
    if (result.status === "error") {
      new Notice(`Vault Flow import error: ${result.error}`);
      return false;
    }
    const confirmed = await confirmRuleImport(this.app, result.details);
    if (!confirmed) return false;
    await this.host.updateSettings({ rules: result.rules });
    this.update();
    new Notice(`Vault Flow imported ${result.rules.length} rule(s) from ${source === "file" ? "file" : "JSON"}.`);
    return true;
  }

  private openExportModal(rules: readonly Rule[]): void {
    new RuleExportModal(this.app, rules, this.host.manifest.version).open();
  }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  public constructor(app: App, private readonly onChoose: (folder: TFolder) => void) {
    super(app);
    this.setPlaceholder("Choose a monitored folder");
  }

  override getItems(): TFolder[] {
    return this.app.vault.getAllFolders(true);
  }

  override getItemText(folder: TFolder): string {
    return folder.isRoot() ? "/" : folder.path;
  }

  override onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

function orderedRulesForDisplay(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((left, right) => left.priority - right.priority || left.order - right.order);
}


// ---------------------------------------------------------------------------
// Rule editor modal
// ---------------------------------------------------------------------------

class RuleEditorModal extends Modal {
  private draft: MutableRuleDraft;
  private rawRuleText: string | null;
  private fixturesText: string;

  public constructor(
    app: App,
    private readonly existingRule: Rule | null,
    private readonly allRules: readonly Rule[],
    private readonly onSave: (result: RuleEditResult) => Promise<boolean | void>,
  ) {
    super(app);
    const visualDraft = existingRule === null ? createDefaultRuleDraft(allRules) : draftFromRule(existingRule);
    this.rawRuleText = existingRule !== null && visualDraft === null ? JSON.stringify(existingRule, null, 2) : null;
    this.fixturesText = JSON.stringify(existingRule?.fixtures ?? [], null, 2);
    const base = visualDraft ?? createDefaultRuleDraft(allRules);
    const firstCriterion = base.criteria?.[0] ?? criterionFromBase(base);

    // Build initial conditionNodes from base.conditionNodes (when available) or fall back to criteria/single criterion
    const conditionNodes: MutableConditionNode[] = base.conditionNodes !== undefined && base.conditionNodes.length > 0
      ? base.conditionNodes.map(nodeToMutable)
      : base.criteria !== undefined && base.criteria.length > 0
        ? base.criteria.map((c) => ({ kind: "criterion" as const, criterion: criterionToMutable(c) }))
        : [{ kind: "criterion" as const, criterion: criterionToMutable(firstCriterion) }];

    this.draft = {
      name: base.name,
      enabled: base.enabled,
      priority: base.priority,
      order: base.order,
      criteriaMode: base.criteriaMode ?? "all",
      criteria: [{ ...criterionToMutable(firstCriterion) }],
      conditionNodes,
      stopOnMatch: base.stopOnMatch,
      dryRun: base.dryRun,
      runOn: base.runOn,
      moveTo: base.moveTo,
      moveToKind: base.moveToKind ?? "auto",
      renameTo: base.renameTo,
      addTags: base.addTags,
      removeTags: base.removeTags,
      replaceTags: base.replaceTags,
      replaceTagsEnabled: base.replaceTagsEnabled,
      setPropertiesJson: base.setPropertiesJson,
      initPropertiesJson: base.initPropertiesJson,
      appendToPropertyJson: base.appendToPropertyJson,
      deletePropertiesList: base.deletePropertiesList,
    };
  }

  override onOpen(): void {
    this.setTitle(this.existingRule !== null ? "Edit rule" : "Add rule");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    if (this.rawRuleText !== null) {
      this.renderRawRuleEditor();
      return;
    }
    const d = this.draft;

    new Setting(this.contentEl)
      .setName("Rule name")
      .addText((text) => {
        text
          .setPlaceholder("My rule")
          .setValue(d.name)
          .onChange((value) => { d.name = value; });
      });

    new Setting(this.contentEl)
      .setName("Enabled")
      .addToggle((toggle) => {
        toggle
          .setValue(d.enabled)
          .onChange((value) => { d.enabled = value; });
      });

    new Setting(this.contentEl)
      .setName("Stop on match")
      .setDesc("When this rule fires, stop evaluating any remaining rules. Useful for mutually exclusive rule branches.")
      .addToggle((toggle) => {
        toggle
          .setValue(d.stopOnMatch)
          .onChange((value) => { d.stopOnMatch = value; });
      });

    new Setting(this.contentEl)
      .setName("Dry-run this rule")
      .setDesc("Rule conditions are checked and match count tracked, but actions are never applied. Overrides the global dry-run setting for this rule.")
      .addToggle((toggle) => {
        toggle
          .setValue(d.dryRun)
          .onChange((value) => { d.dryRun = value; });
      });

    new Setting(this.contentEl)
      .setName("Run on")
      .setDesc("Controls which triggers cause this rule to run.")
      .addDropdown((dd) => {
        dd
          .addOption("always", "Always (default)")
          .addOption("live", "Live changes only")
          .addOption("sweep", "Sweep only (startup / periodic)")
          .addOption("manual", "Manual commands only")
          .setValue(d.runOn)
          .onChange((value) => { d.runOn = value as MutableRuleDraft["runOn"]; });
      });

    // --- Condition section ---
    this.contentEl.createEl("h3", { text: "Condition" });

    // Criteria mode (all/any) — only meaningful with 2+ top-level conditions
    if (d.conditionNodes.length > 1) {
      new Setting(this.contentEl)
        .setName("Match mode")
        .setDesc("How multiple conditions are combined.")
        .addDropdown((dd) => {
          dd
            .addOption("all", "All conditions must match (AND)")
            .addOption("any", "Any condition must match (OR)")
            .setValue(d.criteriaMode)
            .onChange((value) => {
              d.criteriaMode = value as "all" | "any";
            });
        });
    }

    // Render all condition nodes (criteria + groups)
    this.renderConditionNodes(d);

    // --- Actions section ---
    this.contentEl.createEl("h3", { text: "Actions" });

    new Setting(this.contentEl)
      .setName("Move to folder/path")
      .setDesc("Supports property, date, and capture templates. Choose Folder for dotted folder names; Auto preserves legacy path inference.")
      .addText((text) => {
        text
          .setPlaceholder("Projects/{type}/")
          .setValue(d.moveTo)
          .onChange((value) => { d.moveTo = value; });
      });

    new Setting(this.contentEl)
      .setName("Move destination type")
      .addDropdown((dropdown) => dropdown
        .addOptions({ auto: "Auto (legacy)", folder: "Folder", file: "Complete file path" })
        .setValue(d.moveToKind)
        .onChange((value) => { if (value === "auto" || value === "folder" || value === "file") d.moveToKind = value; }));

    new Setting(this.contentEl)
      .setName("Rename to")
      .setDesc("Template for the new basename. Use {property}, {basename}, {now}, {now:FORMAT}, {date:FORMAT}, {1} {2}… for captures. {{ = literal {.")
      .addText((text) => {
        text
          .setPlaceholder("{date} {title}")
          .setValue(d.renameTo)
          .onChange((value) => { d.renameTo = value; });
      });

    new Setting(this.contentEl)
      .setName("Add tags")
      .setDesc("Comma- or space-separated tags to add (without #).")
      .addText((text) => {
        text
          .setPlaceholder("project, active")
          .setValue(d.addTags)
          .onChange((value) => { d.addTags = value; });
      });

    new Setting(this.contentEl)
      .setName("Remove tags")
      .setDesc("Comma- or space-separated tags to remove from frontmatter (without #).")
      .addText((text) => {
        text
          .setPlaceholder("wip, draft")
          .setValue(d.removeTags)
          .onChange((value) => { d.removeTags = value; });
      });

    new Setting(this.contentEl)
      .setName("Replace tags")
      .setDesc("When enabled, replaces ALL frontmatter tags with exactly the list below. Leave the list empty to remove all tags.")
      .addToggle((toggle) => {
        toggle
          .setValue(d.replaceTagsEnabled)
          .onChange((value) => {
            d.replaceTagsEnabled = value;
            this.render();
          });
      });

    if (d.replaceTagsEnabled) {
      new Setting(this.contentEl)
        .setName("Replacement tag list")
        .setDesc("Comma- or space-separated tags (without #). Leave blank to remove all frontmatter tags.")
        .addText((text) => {
          text
            .setPlaceholder("archived, done")
            .setValue(d.replaceTags)
            .onChange((value) => { d.replaceTags = value; });
        });
    }

    new Setting(this.contentEl)
      .setName("Set properties (JSON)")
      .setDesc('JSON object of frontmatter properties to set. Prefer Obsidian Properties types: text, numbers, checkboxes, dates, links, tags, and scalar lists.')
      .addTextArea((text) => {
        text
          .setPlaceholder('{"status": "active"}')
          .setValue(d.setPropertiesJson)
          .onChange((value) => { d.setPropertiesJson = value; });
        text.inputEl.rows = 4;
      });

    new Setting(this.contentEl)
      .setName("Initialize properties (JSON)")
      .setDesc('JSON object of properties to set only when missing. Nested objects remain source-mode YAML because Obsidian Properties does not edit them.')
      .addTextArea((text) => {
        text
          .setPlaceholder('{"status": "new"}')
          .setValue(d.initPropertiesJson)
          .onChange((value) => { d.initPropertiesJson = value; });
        text.inputEl.rows = 4;
      });

    new Setting(this.contentEl)
      .setName("Append to string properties (JSON)")
      .setDesc('JSON object whose string values are appended, e.g. {"notes": "reviewed"}. Guard the changed property to avoid repeated appends. stopOnMatch only stops one reconciliation, not later live runs.')
      .addTextArea((text) => {
        text
          .setPlaceholder('{"notes": "reviewed"}')
          .setValue(d.appendToPropertyJson)
          .onChange((value) => { d.appendToPropertyJson = value; });
        text.inputEl.rows = 4;
      });

    new Setting(this.contentEl)
      .setName("Delete properties")
      .setDesc('JSON string array or comma-separated property names. Spaces inside names are preserved, e.g. ["due date", "legacy_field"].')
      .addText((text) => {
        text
          .setPlaceholder("legacy_field, old_status")
          .setValue(d.deletePropertiesList)
          .onChange((value) => { d.deletePropertiesList = value; });
      });

    new Setting(this.contentEl)
      .setName("Synthetic rule fixtures (JSON)")
      .setDesc("Up to 20 deterministic examples. Stored/exported with the rule; use synthetic content, not sensitive real notes. No vault writes.")
      .addTextArea((text) => { text.setValue(this.fixturesText).onChange((value) => { this.fixturesText = value; }); text.inputEl.rows = 6; })
      .addButton((button) => button.setButtonText("Run rule fixtures").onClick(() => {
        const result = this.visualResult();
        if (result.status === "error") { new Notice(result.error); return; }
        const candidate = this.candidateFromResult(result);
        const results = candidate === undefined ? [] : runRuleFixtures(candidate);
        new Notice(results.length === 0 ? "No fixtures configured." : results.map((test) => `${test.passed ? "PASS" : "FAIL"} ${test.name}${test.failures.length === 0 ? "" : ": " + test.failures.join("; ")}`).join("\n"), 15_000);
      }));

    // --- Save / Cancel ---
    new Setting(this.contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const result = this.visualResult();

            if (result.status === "error") {
              new Notice(`Vault Flow: ${result.error}`);
              return;
            }

            const candidate = this.candidateFromResult(result);
            if (candidate === undefined || !(await this.reviewCandidate(candidate))) return;
            if (await this.onSave(result) !== false) this.close();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Cancel")
          .onClick(() => { this.close(); });
      });
  }

  private visualResult(): RuleEditResult {
    let parsed: unknown;
    try { parsed = JSON.parse(this.fixturesText.trim() || "[]"); }
    catch { return { status: "error", error: "Fixture JSON is invalid." }; }
    const fixtures = readRuleFixtures(parsed);
    if (fixtures === null) return { status: "error", error: "Fixtures must be valid synthetic examples (at most 20 and 200 KB total)." };
    const draft = { ...buildVisualDraft(this.draft), ...(fixtures.length === 0 && this.existingRule?.fixtures === undefined ? {} : { fixtures }) };
    return this.existingRule === null ? createRuleFromDraft(this.allRules, draft) : updateRuleById(this.allRules, this.existingRule.id, draft);
  }

  private candidateFromResult(result: RuleEditResult): Rule | undefined {
    return result.status === "error" ? undefined : result.rules.find((rule) => this.existingRule === null
      ? !this.allRules.some((existing) => existing.id === rule.id) : rule.id === this.existingRule.id);
  }

  private async reviewCandidate(candidate: Rule): Promise<boolean> {
    const warnings = [...ruleConvergenceWarnings(candidate), ...runRuleFixtures(candidate).filter((test) => !test.passed).map((test) => `Fixture failed: ${test.name}: ${test.failures.join("; ")}`)];
    const changes = semanticRuleChanges(this.existingRule, candidate);
    if (warnings.length === 0 && changes.length === 0) return true;
    return confirmAction(this.app, "Review rule semantics before saving", [formatSemanticChanges(changes), ...warnings].filter(Boolean).join("\n\n"), warnings.length > 0 ? "Save despite warnings" : "Save rule");
  }

  private renderRawRuleEditor(): void {
    this.contentEl.createEl("p", {
      text: "This rule uses nesting that the visual editor cannot represent. Edit the complete JSON below; Vault Flow will reject any save that would sanitize or drop data.",
    });

    const textarea = this.contentEl.createEl("textarea", { cls: "vf-json-textarea" });
    textarea.rows = 20;
    textarea.value = this.rawRuleText ?? "";
    textarea.addEventListener("input", () => { this.rawRuleText = textarea.value; });

    new Setting(this.contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("Save JSON")
          .setCta()
          .onClick(async () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(this.rawRuleText ?? "");
            } catch {
              new Notice("Vault Flow: rule JSON is invalid.");
              return;
            }

            const result = sanitizeRules([parsed], []);
            const parsedRule = result.rules[0];
            if (parsedRule === undefined || result.sanitized) {
              new Notice("Vault Flow: rule JSON is unsupported or would lose data, so it was not saved.");
              return;
            }
            if (this.existingRule === null) {
              return;
            }

            const replacement = { ...parsedRule, id: this.existingRule.id };
            if (!(await this.reviewCandidate(replacement))) return;
            if (await this.onSave({
              status: "ok",
              rules: this.allRules.map((rule) => rule.id === this.existingRule?.id ? replacement : rule),
            }) !== false) this.close();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => { this.close(); });
      });
  }

  // ---------------------------------------------------------------------------
  // Condition node rendering
  // ---------------------------------------------------------------------------

  private renderConditionNodes(d: MutableRuleDraft): void {
    d.conditionNodes.forEach((node, nodeIndex) => {
      if (node.kind === "criterion") {
        const criterionEl = this.contentEl.createDiv({ cls: "vf-criterion" });

        this.renderCriterionRow(
          criterionEl,
          node.criterion,
          nodeIndex === 0 ? "Condition" : `Condition ${nodeIndex + 1}`,
          d.conditionNodes.length > 1,
          () => { d.conditionNodes.splice(nodeIndex, 1); this.render(); },
        );
      } else {
        // Group node
        const group = node.group;
        const groupEl = this.contentEl.createDiv({ cls: "vf-condition-group" });

        // Group header row
        const groupHeader = new Setting(groupEl)
          .setName("Condition group");

        // NOT toggle for the whole group
        groupHeader.addButton((btn) => {
          btn.setButtonText("NOT");
          btn.buttonEl.title = group.negated
            ? "Group is negated — click to remove NOT"
            : "Click to negate this entire group";
          applyNotButtonStyle(btn.buttonEl, group.negated);
          btn.onClick(() => { group.negated = !group.negated; this.render(); });
        });

        // Mode dropdown for the group
        groupHeader.addDropdown((dd) => {
          dd
            .addOption("all", "ALL match (AND)")
            .addOption("any", "ANY match (OR)")
            .setValue(group.mode)
            .onChange((value) => { group.mode = value as "all" | "any"; });
        });

        // Remove group button
        groupHeader.addButton((btn) => {
          btn
            .setButtonText("Remove group")
            .onClick(() => { d.conditionNodes.splice(nodeIndex, 1); this.render(); });
        });

        // Render each condition inside the group
        group.conditions.forEach((crit, condIndex) => {
          const condEl = groupEl.createDiv({ cls: "vf-criterion" });

          this.renderCriterionRow(
            condEl,
            crit,
            condIndex === 0 ? "Condition" : `Condition ${condIndex + 1}`,
            group.conditions.length > 1,
            () => { group.conditions.splice(condIndex, 1); this.render(); },
          );
        });

        // Add condition to group
        new Setting(groupEl)
          .addButton((btn) => {
            btn
              .setButtonText("+ Add condition to group")
              .onClick(() => {
                group.conditions.push(makeDefaultMutableCriterion());
                this.render();
              });
          });
      }
    });

    // Add condition / Add condition group buttons
    new Setting(this.contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("+ Add condition")
          .onClick(() => {
            d.conditionNodes.push({ kind: "criterion", criterion: makeDefaultMutableCriterion() });
            this.render();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText("+ Add condition group")
          .onClick(() => {
            d.conditionNodes.push({
              kind: "group",
              group: { mode: "all", conditions: [makeDefaultMutableCriterion()], negated: false },
            });
            this.render();
          });
      });
  }

  /**
   * Renders a single criterion header row (NOT toggle + type dropdown + optional remove button)
   * followed by the predicate-specific fields.
   */
  private renderCriterionRow(
    containerEl: HTMLElement,
    criterion: MutableCriterionDraft,
    label: string,
    showRemove: boolean,
    onRemove: () => void,
  ): void {
    const headerSetting = new Setting(containerEl).setName(label);

    // NOT toggle
    headerSetting.addButton((btn) => {
      btn.setButtonText("NOT");
      btn.buttonEl.title = criterion.negated
        ? "Condition is negated — click to remove NOT"
        : "Click to negate this condition";
      applyNotButtonStyle(btn.buttonEl, criterion.negated);
      btn.onClick(() => { criterion.negated = !criterion.negated; this.render(); });
    });

    // Predicate type dropdown
    headerSetting.addDropdown((dd) => {
      dd
        .addOption("tag", "Has tag")
        .addOption("pathGlob", "Path matches glob")
        .addOption("basename", "Basename matches regex")
        .addOption("frontmatterValue", "Property equals value")
        .addOption("frontmatterExists", "Property exists")
        .addOption("frontmatterMissing", "Property is missing")
        .addOption("frontmatterContains", "Property contains")
        .addOption("sourceUrl", "Source URL host")
        .addOption("fileAge", "File age")
        .addOption("bodyH1", "H1 heading matches regex")
        .addOption("contentContains", "Content contains text")
        .addOption("frontmatterRegex", "Property matches regex")
        .addOption("frontmatterDateAge", "Property date age")
        .addOption("wordCount", "Word count")
        .addOption("tagPrefix", "Tag starts with prefix")
        .addOption("contentRegex", "Content matches regex")
        .setValue(criterion.predicateType)
        .onChange((value) => {
          criterion.predicateType = value as EditablePredicateType;
          this.render();
        });
    });

    if (showRemove) {
      headerSetting.addButton((btn) => {
        btn.setButtonText("Remove").onClick(onRemove);
      });
    }

    this.renderCriterionFields(containerEl, criterion);
  }

  private renderCriterionFields(containerEl: HTMLElement, criterion: MutableCriterionDraft): void {
    switch (criterion.predicateType) {
      case "tag":
        new Setting(containerEl)
          .setName("Tag")
          .setDesc("Without the # prefix.")
          .addText((text) => {
            text
              .setPlaceholder("programming")
              .setValue(criterion.tag)
              .onChange((value) => { criterion.tag = value; });
          });
        break;

      case "pathGlob":
        new Setting(containerEl)
          .setName("Path glob")
          .setDesc("Use * for any characters in a segment, ** for any path depth. E.g. Projects/*.md")
          .addText((text) => {
            text
              .setPlaceholder("Projects/**")
              .setValue(criterion.pathGlob)
              .onChange((value) => { criterion.pathGlob = value; });
          });
        break;

      case "basename":
        new Setting(containerEl)
          .setName("Basename regex")
          .setDesc("Case-insensitive, linear-time RE2 regex against the filename (without extension). No lookarounds or backreferences; maximum 512 characters. Capture groups are available as {1} {2}… in action templates.")
          .addText((text) => {
            text
              .setPlaceholder("^Meeting.*")
              .setValue(criterion.basenamePattern)
              .onChange((value) => { criterion.basenamePattern = value; });
          });
        break;

      case "frontmatterValue":
        new Setting(containerEl)
          .setName("Property name")
          .addText((text) => {
            text
              .setPlaceholder("type")
              .setValue(criterion.frontmatterValueProperty)
              .onChange((value) => { criterion.frontmatterValueProperty = value; });
          });
        new Setting(containerEl)
          .setName("Expected value")
          .setDesc("Enter a string, number, true/false, or null.")
          .addText((text) => {
            text
              .setPlaceholder("meeting")
              .setValue(criterion.frontmatterValueValue)
              .onChange((value) => { criterion.frontmatterValueValue = value; });
          });
        break;

      case "frontmatterExists":
      case "frontmatterMissing":
        new Setting(containerEl)
          .setName("Property name")
          .setDesc(criterion.predicateType === "frontmatterExists" ? "Matches when this property is present and non-null." : "Matches when this property is absent or null.")
          .addText((text) => {
            text
              .setPlaceholder("status")
              .setValue(criterion.frontmatterValueProperty)
              .onChange((value) => { criterion.frontmatterValueProperty = value; });
          });
        break;

      case "frontmatterContains":
        new Setting(containerEl)
          .setName("Property name")
          .addText((text) => {
            text
              .setPlaceholder("description")
              .setValue(criterion.frontmatterValueProperty)
              .onChange((value) => { criterion.frontmatterValueProperty = value; });
          });
        new Setting(containerEl)
          .setName("Contains (substring)")
          .setDesc("Case-insensitive substring match. For arrays, matches any element.")
          .addText((text) => {
            text
              .setPlaceholder("urgent")
              .setValue(criterion.frontmatterContainsSearchValue)
              .onChange((value) => { criterion.frontmatterContainsSearchValue = value; });
          });
        break;

      case "sourceUrl":
        new Setting(containerEl)
          .setName("Frontmatter property")
          .setDesc("Property containing the source URL (e.g. source).")
          .addText((text) => {
            text
              .setPlaceholder("source")
              .setValue(criterion.sourceUrlProperty)
              .onChange((value) => { criterion.sourceUrlProperty = value; });
          });
        new Setting(containerEl)
          .setName("URL host")
          .setDesc("Exact hostname to match (e.g. github.com).")
          .addText((text) => {
            text
              .setPlaceholder("github.com")
              .setValue(criterion.sourceUrlHost)
              .onChange((value) => { criterion.sourceUrlHost = value; });
          });
        break;

      case "fileAge":
        new Setting(containerEl)
          .setName("Date field")
          .setDesc("Which timestamp to use.")
          .addDropdown((dd) => {
            dd
              .addOption("mtime", "Last modified (mtime)")
              .addOption("ctime", "Created (ctime)")
              .setValue(criterion.fileAgeField)
              .onChange((value) => {
                criterion.fileAgeField = value as "ctime" | "mtime";
               
              });
          });
        new Setting(containerEl)
          .setName("Older than (days)")
          .setDesc("Match notes older than this many days. Leave blank to skip this constraint.")
          .addText((text) => {
            text
              .setPlaceholder("30")
              .setValue(criterion.fileAgeOlderThanDays)
              .onChange((value) => { criterion.fileAgeOlderThanDays = value; });
          });
        new Setting(containerEl)
          .setName("Newer than (days)")
          .setDesc("Match notes newer than this many days. Leave blank to skip this constraint.")
          .addText((text) => {
            text
              .setPlaceholder("7")
              .setValue(criterion.fileAgeNewerThanDays)
              .onChange((value) => { criterion.fileAgeNewerThanDays = value; });
          });
        break;

      case "bodyH1":
        new Setting(containerEl)
          .setName("H1 heading regex")
          .setDesc("Case-insensitive, linear-time RE2 regex against the first H1. No lookarounds or backreferences; maximum 512 characters.")
          .addText((text) => {
            text
              .setPlaceholder("^Meeting:.*")
              .setValue(criterion.basenamePattern)
              .onChange((value) => { criterion.basenamePattern = value; });
          });
        break;

      case "contentContains":
        new Setting(containerEl)
          .setName("Text to find")
          .setDesc("Case-sensitive substring that must appear anywhere in the note body. Note: this predicate reads the full file content on each evaluation and is slower than other predicates.")
          .addText((text) => {
            text
              .setPlaceholder("#project-x")
              .setValue(criterion.contentContainsText)
              .onChange((value) => { criterion.contentContainsText = value; });
          });
        break;

      case "frontmatterRegex":
        new Setting(containerEl)
          .setName("Property name")
          .addText((text) => {
            text
              .setPlaceholder("type")
              .setValue(criterion.frontmatterValueProperty)
              .onChange((value) => { criterion.frontmatterValueProperty = value; });
          });
        new Setting(containerEl)
          .setName("Regex pattern")
          .setDesc("Case-insensitive, linear-time RE2 regex against the property value as a string. No lookarounds or backreferences; maximum 512 characters.")
          .addText((text) => {
            text
              .setPlaceholder("^meeting.*")
              .setValue(criterion.frontmatterRegexPattern)
              .onChange((value) => { criterion.frontmatterRegexPattern = value; });
          });
        break;

      case "frontmatterDateAge":
        new Setting(containerEl)
          .setName("Property name")
          .setDesc("Frontmatter property containing a date value.")
          .addText((text) => {
            text
              .setPlaceholder("created")
              .setValue(criterion.frontmatterDateAgeProperty)
              .onChange((value) => { criterion.frontmatterDateAgeProperty = value; });
          });
        new Setting(containerEl)
          .setName("Older than (days)")
          .setDesc("Match notes whose date property is older than this many days. Leave blank to skip.")
          .addText((text) => {
            text
              .setPlaceholder("30")
              .setValue(criterion.fileAgeOlderThanDays)
              .onChange((value) => { criterion.fileAgeOlderThanDays = value; });
          });
        new Setting(containerEl)
          .setName("Newer than (days)")
          .setDesc("Match notes whose date property is newer than this many days. Leave blank to skip.")
          .addText((text) => {
            text
              .setPlaceholder("7")
              .setValue(criterion.fileAgeNewerThanDays)
              .onChange((value) => { criterion.fileAgeNewerThanDays = value; });
          });
        break;

      case "wordCount":
        new Setting(containerEl)
          .setName("More than (words)")
          .setDesc("Match notes with more than this many words. Leave blank to skip.")
          .addText((text) => {
            text
              .setPlaceholder("500")
              .setValue(criterion.wordCountMoreThan)
              .onChange((value) => { criterion.wordCountMoreThan = value; });
          });
        new Setting(containerEl)
          .setName("Less than (words)")
          .setDesc("Match notes with fewer than this many words. Leave blank to skip.")
          .addText((text) => {
            text
              .setPlaceholder("100")
              .setValue(criterion.wordCountLessThan)
              .onChange((value) => { criterion.wordCountLessThan = value; });
          });
        break;

      case "tagPrefix":
        new Setting(containerEl)
          .setName("Tag prefix")
          .setDesc("Without the # prefix. Matches any tag that starts with this string (e.g. 'project' matches #project/alpha).")
          .addText((text) => {
            text
              .setPlaceholder("project")
              .setValue(criterion.tagPrefixValue)
              .onChange((value) => { criterion.tagPrefixValue = value; });
          });
        break;

      case "contentRegex":
        new Setting(containerEl)
          .setName("Regex pattern")
          .setDesc("Case-insensitive, linear-time RE2 regex against the full Markdown body. No lookarounds or backreferences; maximum 512 characters. Broad automatic rules can still be costly on large notes; prefer literal contains checks when possible.")
          .addText((text) => {
            text
              .setPlaceholder("TODO:.*")
              .setValue(criterion.contentRegexPattern)
              .onChange((value) => { criterion.contentRegexPattern = value; });
          });
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Preset rules modal
// ---------------------------------------------------------------------------

const PRESET_RULES: readonly Rule[] = [
  {
    id: "preset-move-tagged",
    name: "Move tagged notes",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "tag", tag: "inbox" },
    then: { moveTo: "Inbox" },
  },
  {
    id: "preset-archive-old",
    name: "Archive old notes",
    enabled: true,
    priority: 0,
    order: 1,
    when: { type: "fileAge", field: "ctime", olderThanDays: 365 },
    then: { moveTo: "Archive" },
  },
  {
    id: "preset-organize-by-category",
    name: "Organize by category",
    enabled: true,
    priority: 0,
    order: 2,
    when: { type: "frontmatterExists", property: "category" },
    then: { moveTo: "{category}" },
  },
  {
    id: "preset-rename-with-date",
    name: "Rename with date prefix",
    enabled: true,
    priority: 0,
    order: 3,
    when: { type: "frontmatterExists", property: "date" },
    then: { renameTo: "{date:YYYY-MM-DD} {basename}" },
  },
  {
    id: "preset-auto-tag-from-folder",
    name: "Auto-tag from folder",
    enabled: true,
    priority: 0,
    order: 4,
    when: { type: "pathGlob", glob: "Projects/**" },
    then: { addTags: ["project"] },
  },
  {
    id: "preset-move-untagged",
    name: "Move untagged to Inbox",
    enabled: true,
    priority: 0,
    order: 5,
    when: { type: "frontmatterMissing", property: "tags" },
    then: { moveTo: "Inbox/Untagged" },
  },
];

class PresetRulesModal extends Modal {
  public constructor(
    app: App,
    private readonly host: VaultFlowSettingsHost,
    private readonly onAdded: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Add preset rule");
    this.contentEl.empty();

    this.contentEl.createEl("p", {
      text: "Click a preset to append it to your rules list. You can edit or delete it afterwards.",
      cls: "vf-muted",
    });

    for (const preset of PRESET_RULES) {
      const row = this.contentEl.createDiv({ cls: "vf-preset-row" });

      const info = row.createDiv();
      info.createEl("strong", { text: preset.name });
      info.createDiv({
        text: `When: ${summarizeRule(preset).predicate} → Then: ${summarizeRule(preset).actions}`,
        cls: "vf-small-text",
      });

      const addBtn = row.createEl("button", { text: "Add" });
      addBtn.addEventListener("click", () => {
        void (async () => {
          const currentRules = this.host.getSettings().rules;
        const usedIds = new Set(currentRules.map((r) => r.id));
        let newId = preset.id;
        let suffix = 2;
        while (usedIds.has(newId)) {
          newId = `${preset.id}-${suffix}`;
          suffix += 1;
        }
        const newPreset: Rule = {
          ...preset,
          id: newId,
          priority: currentRules.length === 0 ? 0 : Math.max(...currentRules.map((rule) => rule.priority)) + 1,
          order: currentRules.length === 0 ? 0 : Math.max(...currentRules.map((rule) => rule.order)) + 1,
        };
        await this.host.updateSettings({ rules: [...currentRules, newPreset] });
          new Notice(`Vault Flow: added preset "${preset.name}".`);
          this.onAdded();
        })();
      });
    }

    new Setting(this.contentEl)
      .addButton((btn) => {
        btn.setButtonText("Close").onClick(() => { this.close(); });
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Import / Export modals
// ---------------------------------------------------------------------------

class RuleImportModal extends Modal {
  private text = "";

  public constructor(
    app: App,
    private readonly onImport: (rules: readonly Rule[]) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Import rules from JSON");
    this.contentEl.empty();

    this.contentEl.createEl("p", { text: "Paste a JSON array of rules, or an object with a rules array. This replaces all existing rules." });

    const textarea = this.contentEl.createEl("textarea");
    textarea.rows = 12;
    textarea.addClass("vf-json-textarea");
    textarea.addEventListener("input", () => { this.text = textarea.value; });

    new Setting(this.contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("Import")
          .setCta()
          .onClick(async () => {
            const result = parseRuleImport(this.text);
            if (result.status === "error") {
              new Notice(`Vault Flow import error: ${result.error}`);
              return;
            }

            if (!(await confirmRuleImport(this.app, result.details))) {
              return;
            }

            await this.onImport(result.rules);
            this.close();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => { this.close(); });
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

function confirmRuleImport(app: App, details: RuleImportDetails): Promise<boolean> {
  return confirmAction(
    app,
    "Replace all rules",
    `${formatRuleImportReport(details)}\n\nImporting replaces every existing rule.`,
    "Replace rules",
  );
}

function confirmAction(app: App, title: string, message: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new ConfirmationModal(app);
    modal.setTitle(title);
    modal.setContent(message);
    modal.addButton((button) => {
      button
        .setButtonText(confirmText)
        .setDestructive()
        .setCta()
        .setInitialFocus()
        .onClick(() => {
          settled = true;
          resolve(true);
        });
    });
    modal.addCancelButton();
    modal.setCloseCallback(() => {
      if (!settled) resolve(false);
    });
    modal.open();
  });
}

class RuleExportModal extends Modal {
  public constructor(
    app: App,
    private readonly rules: readonly Rule[],
    private readonly pluginVersion: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Export rules as JSON");
    this.contentEl.empty();

    this.contentEl.createEl("p", {
      text: `Exporting ${this.rules.length} rule(s). You can paste this back via "Import JSON" on any vault.`,
    });

    const textarea = this.contentEl.createEl("textarea");
    textarea.rows = 16;
    textarea.addClass("vf-json-textarea");
    textarea.value = formatRuleExport(this.rules, this.pluginVersion);
    textarea.readOnly = true;
    textarea.select();

    new Setting(this.contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("Copy to clipboard")
          .onClick(async () => {
            try {
              const clipboard = this.contentEl.ownerDocument.defaultView?.navigator.clipboard;
              if (clipboard === undefined) {
                throw new Error("Clipboard access is unavailable.");
              }
              await clipboard.writeText(textarea.value);
              new Notice("Rules copied to clipboard.");
            } catch (error) {
              new Notice(`Vault Flow could not copy rules: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Close").onClick(() => { this.close(); });
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function criterionFromBase(base: VisualRuleDraft): VisualCriterionDraft {
  return {
    predicateType: base.predicateType,
    negated: false,
    tag: base.tag,
    pathGlob: base.pathGlob,
    basenamePattern: base.basenamePattern,
    frontmatterValueProperty: base.frontmatterValueProperty,
    frontmatterValueValue: base.frontmatterValueValue,
    frontmatterContainsSearchValue: base.frontmatterContainsSearchValue,
    sourceUrlProperty: base.sourceUrlProperty,
    sourceUrlHost: base.sourceUrlHost,
    fileAgeField: base.fileAgeField,
    fileAgeOlderThanDays: base.fileAgeOlderThanDays,
    fileAgeNewerThanDays: base.fileAgeNewerThanDays,
    contentContainsText: base.contentContainsText,
    frontmatterRegexPattern: base.frontmatterRegexPattern,
    frontmatterDateAgeProperty: base.frontmatterDateAgeProperty,
    wordCountMoreThan: base.wordCountMoreThan,
    wordCountLessThan: base.wordCountLessThan,
    tagPrefixValue: base.tagPrefixValue,
    contentRegexPattern: base.contentRegexPattern,
  };
}

function makeDefaultMutableCriterion(): MutableCriterionDraft {
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

function buildVisualDraft(draft: MutableRuleDraft): VisualRuleDraft {
  // Derive the first criterion for the top-level compat fields from conditionNodes
  const firstNode = draft.conditionNodes[0];
  const criterion: MutableCriterionDraft = (() => {
    if (firstNode?.kind === "criterion") return firstNode.criterion;
    if (firstNode?.kind === "group" && firstNode.group.conditions.length > 0) {
      return firstNode.group.conditions[0] ?? makeDefaultMutableCriterion();
    }
    return draft.criteria[0] ?? makeDefaultMutableCriterion();
  })();

  return {
    name: draft.name,
    enabled: draft.enabled,
    priority: draft.priority,
    order: draft.order,
    criteriaMode: draft.criteriaMode,
    criteria: draft.criteria,
    conditionNodes: draft.conditionNodes,
    stopOnMatch: draft.stopOnMatch,
    dryRun: draft.dryRun,
    runOn: draft.runOn,
    predicateType: criterion.predicateType,
    tag: criterion.tag,
    pathGlob: criterion.pathGlob,
    basenamePattern: criterion.basenamePattern,
    frontmatterValueProperty: criterion.frontmatterValueProperty,
    frontmatterValueValue: criterion.frontmatterValueValue,
    frontmatterContainsSearchValue: criterion.frontmatterContainsSearchValue,
    sourceUrlProperty: criterion.sourceUrlProperty,
    sourceUrlHost: criterion.sourceUrlHost,
    fileAgeField: criterion.fileAgeField,
    fileAgeOlderThanDays: criterion.fileAgeOlderThanDays,
    fileAgeNewerThanDays: criterion.fileAgeNewerThanDays,
    contentContainsText: criterion.contentContainsText,
    frontmatterRegexPattern: criterion.frontmatterRegexPattern,
    frontmatterDateAgeProperty: criterion.frontmatterDateAgeProperty,
    wordCountMoreThan: criterion.wordCountMoreThan,
    wordCountLessThan: criterion.wordCountLessThan,
    tagPrefixValue: criterion.tagPrefixValue,
    contentRegexPattern: criterion.contentRegexPattern,
    moveTo: draft.moveTo,
    moveToKind: draft.moveToKind,
    renameTo: draft.renameTo,
    addTags: draft.addTags,
    removeTags: draft.removeTags,
    replaceTags: draft.replaceTags,
    replaceTagsEnabled: draft.replaceTagsEnabled,
    setPropertiesJson: draft.setPropertiesJson,
    initPropertiesJson: draft.initPropertiesJson,
    appendToPropertyJson: draft.appendToPropertyJson,
    deletePropertiesList: draft.deletePropertiesList,
  };
}

function isCollisionPolicy(value: string): value is CollisionPolicy {
  return value === "skip" || value === "rename-with-suffix";
}

/** Apply active/inactive style to a NOT toggle button. */
function applyNotButtonStyle(el: HTMLElement, active: boolean): void {
  el.toggleClass("is-active", active);
}

/** Deep-copy a VisualCriterionDraft to a mutable object. */
function criterionToMutable(c: VisualCriterionDraft): MutableCriterionDraft {
  return {
    predicateType: c.predicateType,
    negated: c.negated ?? false,
    tag: c.tag,
    pathGlob: c.pathGlob,
    basenamePattern: c.basenamePattern,
    frontmatterValueProperty: c.frontmatterValueProperty,
    frontmatterValueValue: c.frontmatterValueValue,
    frontmatterContainsSearchValue: c.frontmatterContainsSearchValue,
    sourceUrlProperty: c.sourceUrlProperty,
    sourceUrlHost: c.sourceUrlHost,
    fileAgeField: c.fileAgeField,
    fileAgeOlderThanDays: c.fileAgeOlderThanDays,
    fileAgeNewerThanDays: c.fileAgeNewerThanDays,
    contentContainsText: c.contentContainsText,
    frontmatterRegexPattern: c.frontmatterRegexPattern,
    frontmatterDateAgeProperty: c.frontmatterDateAgeProperty,
    wordCountMoreThan: c.wordCountMoreThan,
    wordCountLessThan: c.wordCountLessThan,
    tagPrefixValue: c.tagPrefixValue,
    contentRegexPattern: c.contentRegexPattern,
  };
}

/** Deep-copy a VisualConditionNode to a mutable node. */
function nodeToMutable(node: VisualConditionNode): MutableConditionNode {
  if (node.kind === "criterion") {
    return { kind: "criterion", criterion: criterionToMutable(node.criterion) };
  }
  return {
    kind: "group",
    group: {
      mode: node.group.mode,
      conditions: node.group.conditions.map(criterionToMutable),
      negated: node.group.negated ?? false,
    },
  };
}

function msToMinutes(ms: number): number {
  return Math.floor(ms / 60000);
}

function minutesToMs(minutes: number): number {
  return minutes * 60000;
}

function formatMinutes(ms: number): number {
  return msToMinutes(ms);
}

function splitFolderList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((folder) => folder.trim())
    .filter((folder) => folder.length > 0);
}
