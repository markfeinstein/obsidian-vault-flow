import { ConfirmationModal, Modal, moment, normalizePath, Notice, Platform, Plugin, ProgressBarComponent, TFile, TFolder, Vault } from "obsidian";
import type { BasesAllOptions, TAbstractFile } from "obsidian";
import { isMarkdownFile, isProcessableFile as isSupportedNote, validateVaultPath, type AppliedReconciliationTransaction } from "./obsidian/adapter";
import { TransactionJournal, type JournalEntry, type PendingNoteMutation } from "./obsidian/transaction-journal";
import { RecoveryModal } from "./obsidian/recovery-modal";
import { WorkInboxModal } from "./obsidian/work-inbox-modal";
import { buildWorkInbox, type WorkInboxItem } from "./obsidian/work-inbox";
import type { RuleRunOn } from "./engine";
import { mapWithConcurrency } from "./obsidian/concurrency";
import { compactPreviewPlan } from "./obsidian/preview-snapshot";
import { unknownValuesEqual } from "./engine/value-utils";
import { cliError, cliPlanSummary, formatCliDiagnostics, formatCliPlan, formatCliStatus, parseCliTrigger } from "./obsidian/cli";
import { planCliPaths } from "./obsidian/cli-many";
import { runRuleFixtures } from "./engine/rule-fixtures";
import { VAULT_FLOW_BASES_VIEW_TYPE, VaultFlowBasesView } from "./obsidian/bases-view";
import { DiagnosticLogModal } from "./obsidian/diagnostic-log-modal";
import { createTransactionId, type ReconciliationDecision } from "./obsidian/diagnostics";
import { RuleDebuggerModal } from "./obsidian/rule-debugger-modal";
import { planReconciliationForFile } from "./obsidian/dry-run-preview";
import { UndoHistoryModal } from "./obsidian/undo-history-modal";
import { diagnosticSummary, pruneTransactionHistory } from "./obsidian/transaction-history";
import { VaultPreviewModal } from "./obsidian/vault-preview-modal";
import { DryRunPreviewModal } from "./obsidian/dry-run-preview-modal";
import { VAULT_FLOW_DIAGNOSTICS_VIEW_TYPE, VaultFlowDiagnosticsView } from "./obsidian/diagnostics-view";
import { markdownFilesInSameFolder, selectedMarkdownFiles } from "./obsidian/markdown-selection";
import { MutationCoordinator } from "./obsidian/mutation-coordinator";
import { WriteSafety } from "./obsidian/write-safety";
import { sanitizeBatchHistory, type BatchReceipt } from "./obsidian/batch-history";
import { BatchHistoryModal } from "./obsidian/batch-history-modal";
import { countFrontmatterChanges } from "./obsidian/note-state";
import { captureNoteIdentity, sameNoteIdentity } from "./obsidian/note-identity";
import { computeJitteredSweepIntervalMs, MIN_SWEEP_INTERVAL_MS, shouldRunPeriodicSweep } from "./obsidian/periodic-schedule";
import { ReconciliationQueue, type ReconciliationQueueSnapshot } from "./obsidian/queue";
import { collectSourceUrlProperties, findDuplicateSourceUrls } from "./obsidian/source-duplicates";
import { SourceDuplicatesModal } from "./obsidian/source-duplicates-modal";
import { VaultFlowSettingTab } from "./obsidian/settings-tab";
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  sanitizeVaultFlowRuntimeState,
  sanitizeVaultFlowSettings,
  type VaultFlowRuntimeState,
  type VaultFlowSettings,
} from "./obsidian/settings";
import { evaluateFileEligibility } from "./obsidian/eligibility";
import { formatVaultFlowStatus } from "./obsidian/status";
import { planMtimeSweep, pruneTrackedMtimesToFiles, removeTrackedMtimePath, timeDependentSweepDue, type MtimeMapUpdate } from "./obsidian/sweep";

const RUNTIME_STORAGE_KEY = "vault-flow:runtime-state:v1";
const DECISION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DECISION_MAX_ENTRIES = 2_000;
const RUNTIME_SAVE_DEBOUNCE_MS = 250;

export default class VaultFlowPlugin extends Plugin {
  public override settings: VaultFlowSettings = DEFAULT_SETTINGS;
  private queue: ReconciliationQueue | null = null;
  private statusBarItemEl: HTMLElement | null = null;
  private periodicSweepIntervalId: number | null = null;
  private loaded = false;
  private startupSweepRequestId = 0;
  private vaultLifecycleEventsRegistered = false;
  private settingsSaveChain: Promise<void> = Promise.resolve();
  private runtimeSaveTimer: number | null = null;
  private settingsReadOnly = false;
  private readonly mutationCoordinator = new MutationCoordinator();
  private settingsRevision = 0;
  private readonly writeSafety = new WriteSafety((reason) => {
    this.settingsRevision += 1;
    this.updateStatusBar();
    new Notice(reason === null ? "Vault Flow writes resumed." : `Vault Flow writes paused: ${reason}.`);
    if (reason === null) this.queue?.resumeDeferred();
  });
  private lastSweepRevision = -1;
  private lastSweepAt: number | null = null;
  private readonly sweepEvaluationTimes = new Map<string, number>();
  private pendingSweepPaths = new Set<string>();
  private transactions: readonly ReconciliationDecision[] = [];
  private batches: readonly BatchReceipt[] = [];
  private trackedMtimeCache: Map<string, number> | null = null;
  private trackedMtimesDirty = false;
  private diagnosticsRefreshTimer: number | null = null;
  private runtimeSaveFailed = false;
  private journal: TransactionJournal | null = null;

  override async onload(): Promise<void> {
    this.loaded = true;
    const rawData: unknown = await this.loadData();
    const sanitizedSettings = sanitizeVaultFlowSettings(rawData, DEFAULT_SETTINGS);
    this.settingsReadOnly = sanitizedSettings.incompatibleVersion !== undefined || sanitizedSettings.regexErrors !== undefined || sanitizedSettings.scopeErrors !== undefined || sanitizedSettings.ruleErrors !== undefined;

    const legacyRuntime: VaultFlowRuntimeState = {
      trackedMtimes: sanitizedSettings.settings.trackedMtimes,
      recentDecisions: sanitizedSettings.settings.recentDecisions,
      ruleStats: sanitizedSettings.settings.ruleStats,
    };
    const storedRuntime: unknown = this.app.loadLocalStorage(RUNTIME_STORAGE_KEY);
    const runtimeResult = sanitizeVaultFlowRuntimeState(storedRuntime, legacyRuntime);
    this.transactions = runtimeResult.runtimeState.transactions ?? [];
    this.batches = runtimeResult.runtimeState.batches ?? [];
    this.settings = {
      ...sanitizedSettings.settings,
      trackedMtimes: runtimeResult.runtimeState.trackedMtimes,
      ruleStats: runtimeResult.runtimeState.ruleStats,
      recentDecisions: pruneDecisions(runtimeResult.runtimeState.recentDecisions.map(diagnosticSummary)),
    };
    this.settingsRevision = 1;
    this.journal = new TransactionJournal(this.app);
    if (!this.settingsReadOnly) {
      const recorded = new Set([...this.transactions, ...this.settings.recentDecisions.filter((decision) => decision.outcome === "undone")].map((decision) => decision.transactionId));
      try { for (const entry of this.journal.entries()) if (recorded.has(entry.transactionId)) this.journal.acknowledge(entry.transactionId); }
      catch { new Notice("Vault Flow could not acknowledge already recorded recovery entries."); }
    }
    if (this.journal.blockedReason !== null || this.journal.entries().length > 0) {
      this.writeSafety.pause(this.journal.blockedReason ?? "Pending writes need recovery inspection");
      new Notice("Vault Flow paused writes. Open “Inspect pending-write recovery” before explicitly resuming.");
    }

    if (this.settingsReadOnly) {
      new Notice(sanitizedSettings.ruleErrors !== undefined
        ? `Vault Flow automation is disabled: ${sanitizedSettings.ruleErrors.join(" ")} Settings were not overwritten. Correct data.json and reload the plugin.`
        : sanitizedSettings.scopeErrors !== undefined
        ? `Vault Flow automation is disabled: invalid scope settings (${sanitizedSettings.scopeErrors.join(", ")}). Settings were not overwritten. Correct data.json and reload the plugin.`
        : sanitizedSettings.regexErrors !== undefined
        ? `Vault Flow automation is disabled: unsupported regex or glob in ${sanitizedSettings.regexErrors.join(", ")}. Settings were not overwritten. Update these patterns in data.json and reload the plugin.`
        : `Vault Flow settings use newer schema version ${sanitizedSettings.incompatibleVersion}; automation is disabled until a compatible plugin version is installed.`);
    } else {
      if (sanitizedSettings.sanitized) {
        new Notice("Vault Flow settings contained invalid values and were sanitized.");
        await this.saveSettings();
      }
      if (storedRuntime === null || runtimeResult.sanitized || hasLegacyRuntimeState(rawData)) {
        this.saveRuntimeStateNow();
      }
      if (hasLegacyRuntimeState(rawData)) {
        await this.saveSettings();
      }
    }

    this.queue = new ReconciliationQueue(
      this.app,
      () => ({
        debounceMs: this.settings.debounceMs,
        maxIterations: this.settings.maxIterations,
        useRegexSet: this.settings.useRegexSet,
        dryRun: this.settings.dryRun,
        collisionPolicy: this.settings.collisionPolicy,
        rules: this.settings.rules,
        monitoredFolders: this.settings.monitoredFolders,
        exclusionPatterns: this.settings.exclusionPatterns,
        disableFrontmatterKey: this.settings.disableFrontmatterKey,
        revision: this.settingsRevision,
        maxConcurrent: 4,
        automationEnabled: !this.settingsReadOnly && !this.writeSafety.paused,
      }),
      {
        recordDecision: async (decision) => {
          await this.recordDecision(decision);
        },
        onSnapshotChange: (snapshot) => {
          this.updateStatusBar(snapshot);
        },
        shouldDeferLiveWrite: (file) => this.isActiveFile(file),
        onReconciled: async (file, context) => {
          // A live/manual pass says nothing about sweep-only rules.
          if (context.triggerContexts.includes("sweep") && context.revision === this.settingsRevision) {
            this.sweepEvaluationTimes.delete(context.path);
            this.sweepEvaluationTimes.set(normalizePath(file.path), context.evaluatedAt);
            this.trackSweepMtime(file);
          }
        },
        onFailed: (_file, context) => {
          if (context.mutationStarted) this.pauseAfterMutationFailure();
        },
        runExclusive: async (operation) => this.mutationCoordinator.runExclusive(operation),
        onMutationStarted: (pending) => this.startJournal(pending),
        onMutationFinished: (transaction) => this.finishJournal(transaction),
      },
    );

    if (!Platform.isMobileApp) {
      this.statusBarItemEl = this.addStatusBarItem();
      this.updateStatusBar();
    }

    this.addSettingTab(new VaultFlowSettingTab(this.app, this));

    this.registerView(
      VAULT_FLOW_DIAGNOSTICS_VIEW_TYPE,
      (leaf) => new VaultFlowDiagnosticsView(
        leaf,
        () => this.settings.recentDecisions,
        () => this.settings.rules,
      ),
    );

    this.registerHoverLinkSource(VAULT_FLOW_BASES_VIEW_TYPE, { display: "Vault Flow", defaultMod: true });
    this.registerBasesView(VAULT_FLOW_BASES_VIEW_TYPE, {
      name: "Vault Flow plan",
      icon: "workflow",
      factory: (controller, containerEl) => new VaultFlowBasesView(controller, containerEl, {
        getSettings: () => this.settings,
        getSettingsRevision: () => this.settingsRevision,
        previewCallbacks: {
          collisionPolicy: () => this.settings.collisionPolicy,
          recordDecision: async (decision) => this.recordDecision({ ...decision, triggerContexts: ["manual"] }),
          runExclusive: async (operation) => this.mutationCoordinator.runExclusive(operation),
          recordBatch: (receipt) => this.recordBatch(receipt),
          assertCanApply: () => this.assertAutomationEnabled(),
          maxBatchWrites: () => this.settings.maxBatchWrites,
          onMutationStarted: (pending) => this.startJournal(pending),
          onMutationFinished: (transaction) => this.finishJournal(transaction),
          onMutationFailed: () => this.pauseAfterMutationFailure(),
        },
      }),
      options: (config): BasesAllOptions[] => [
        {
          type: "dropdown",
          key: "mode",
          displayName: "Planning mode",
          default: "rules",
          options: {
            rules: "Run Vault Flow manual rules",
            destination: "Move using a Base property or formula",
            rename: "Rename using a Base text property or formula",
            property: "Set a property using a Base value or formula",
          },
        },
        {
          type: "property",
          key: "destinationProperty",
          displayName: "Source property or formula",
          placeholder: "Choose a note, file, or formula property",
          shouldHide: () => config.get("mode") === "rules" || config.get("mode") === undefined,
        },
        {
          type: "dropdown",
          key: "destinationKind",
          displayName: "Destination type",
          default: "auto",
          options: { auto: "Auto (legacy)", folder: "Folder", file: "Complete file path" },
          shouldHide: () => config.get("mode") !== "destination",
        },
        {
          type: "text",
          key: "propertyName",
          displayName: "Target property name",
          default: "",
          shouldHide: () => config.get("mode") !== "property",
        },
        {
          type: "slider",
          key: "pageSize",
          displayName: "Rows per page",
          default: 100,
          min: 25,
          max: 500,
          step: 25,
        },
      ],
    });

    this.registerCliHandlers();

    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (!this.settingsReadOnly && this.app.workspace.layoutReady && this.isProcessableFile(file)) {
        this.queue?.enqueue(file, "live");
        if (this.pendingSweepPaths.delete(normalizePath(file.path))) this.queue?.enqueue(file, "sweep");
      }
    }));
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      if (this.loaded && !this.settingsReadOnly && this.app.workspace.layoutReady && this.pendingSweepPaths.size > 0) void this.runMtimeSweep();
    }));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.handleVaultRename(file, oldPath);
    }));

    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.queue?.resumeDeferred();
    }));

    this.app.workspace.onLayoutReady(() => {
      if (!this.loaded) {
        return;
      }

      this.registerVaultLifecycleEvents();
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (this.settingsReadOnly || !selectedMarkdownFiles([file]).some((selected) => this.isProcessableFile(selected))) {
        return;
      }
      menu.addItem((item) => {
        item
          .setTitle("Reconcile selected Markdown files")
          .setIcon("workflow")
          .setSection("action")
          .onClick(() => {
            this.enqueueSelectedMarkdownFiles([file], "manual");
          });
      });
    }));

    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => {
      if (this.settingsReadOnly || !selectedMarkdownFiles(files).some((selected) => this.isProcessableFile(selected))) {
        return;
      }
      menu.addItem((item) => {
        item
          .setTitle("Reconcile selected Markdown files")
          .setIcon("workflow")
          .setSection("action")
          .onClick(() => {
            this.enqueueSelectedMarkdownFiles(files, "manual");
          });
      });
    }));

    this.addCommand({
      id: "inspect-write-recovery",
      name: "Inspect pending-write recovery",
      callback: () => this.openWriteRecovery(),
    });

    this.addCommand({
      id: "show-work-inbox",
      name: "Show failed-work inbox",
      callback: () => this.openWorkInbox(),
    });

    this.addCommand({
      id: "toggle-automation-pause",
      name: "Pause or resume writes (this device session)",
      callback: () => this.setAutomationPaused(!this.writeSafety.paused),
    });

    this.addCommand({
      id: "reconcile-active-note",
      name: "Reconcile active note",
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (this.settingsReadOnly || file === null || !this.isProcessableFile(file)) {
          return false;
        }

        if (!checking) {
          this.enqueueIfProcessable(file, "manual");
        }

        return true;
      },
    });

    this.addCommand({
      id: "preview-active-note",
      name: "Preview active note changes",
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (this.settingsReadOnly || file === null || !this.isProcessableFile(file)) {
          return false;
        }

        if (!checking) {
          void planReconciliationForFile(this.app, file, this.settings).then((plan) => {
            if (this.loaded) new DryRunPreviewModal(this.app, plan.preview, plan).open();
          }).catch((error: unknown) => {
            new Notice(`Vault Flow preview failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }

        return true;
      },
    });

    this.addCommand({
      id: "reconcile-vault",
      name: "Reconcile entire vault",
      callback: () => {
        void this.enqueueAllWithConfirmation();
      },
    });

    this.addCommand({
      id: "reconcile-current-folder",
      name: "Reconcile current folder",
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (this.settingsReadOnly || file === null) {
          return false;
        }

        if (checking) {
          return true;
        }

        const folderFiles = markdownFilesInSameFolder(file);
        if (folderFiles === null) {
          new Notice("Vault Flow could not find a folder for the active note.");
          return;
        }

        void this.queue?.enqueueMany(folderFiles.filter((folderFile) => this.isProcessableFile(folderFile)), "manual");

        return true;
      },
    });

    this.addCommand({
      id: "explain-this-note",
      name: "Explain this note",
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (file === null) {
          return false;
        }

        if (!checking) {
          new RuleDebuggerModal(this.app, file, this.settings).open();
        }

        return true;
      },
    });

    this.addCommand({
      id: "show-diagnostic-log",
      name: "Show diagnostic log",
      callback: () => {
        new DiagnosticLogModal(this.app, this.settings.recentDecisions).open();
      },
    });

    this.addCommand({
      id: "open-diagnostics",
      name: "Open diagnostics",
      callback: () => {
        void this.openDiagnosticsView();
      },
    });

    this.addCommand({
      id: "find-duplicate-source-urls",
      name: "Find duplicate source URLs",
      callback: () => {
        const sourceProperties = collectSourceUrlProperties(this.settings.rules);
        if (sourceProperties.length === 0) {
          new Notice("Vault Flow has no configured source URL properties.");
          return;
        }

        const duplicates = findDuplicateSourceUrls(
          this.includedMarkdownFiles().map((file) => ({
            path: file.path,
            frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
          })),
          sourceProperties,
        );
        if (duplicates.length === 0) {
          new Notice("Vault Flow found no duplicate source URLs.");
          return;
        }

        new SourceDuplicatesModal(this.app, duplicates).open();
      },
    });

    this.addCommand({
      id: "preview-vault",
      name: "Preview vault changes",
      callback: () => {
        if (this.settingsReadOnly) {
          new Notice("Vault Flow cannot preview rules while settings from a newer schema are loaded.");
          return;
        }
        void this.openVaultPreview(this.includedMarkdownFiles());
      },
    });

    this.addCommand({
      id: "show-undo-history",
      name: "Show undo history",
      callback: () => {
        new UndoHistoryModal(
          this.app,
          () => this.transactions,
          async (decision) => {
            await this.undoLastMoveOrRename(decision);
          },
          async (batchId) => {
            const count = this.transactions.filter((decision) => decision.batchId === batchId).length;
            if (await confirmBatchUndo(this.app, count)) await this.undoBatch(batchId);
          },
        ).open();
      },
    });

    this.addCommand({
      id: "show-batch-history",
      name: "Show apply batch receipts",
      callback: () => { new BatchHistoryModal(this.app, this.batches).open(); },
    });

    this.addCommand({
      id: "export-diagnostics",
      name: "Export diagnostics to Markdown",
      callback: () => {
        void this.exportDiagnostics();
      },
    });

    this.addCommand({
      id: "export-settings",
      name: "Export settings to clipboard",
      callback: () => {
        const data = settingsDataForSave(this.settings);
        const json = JSON.stringify(data, null, 2);
        void writeClipboardText(
          this.app.workspace.containerEl.ownerDocument.defaultView?.navigator,
          json,
          "Vault Flow settings copied to clipboard.",
          "Vault Flow could not copy settings to clipboard",
        );
      },
    });

    this.configurePeriodicSweep();
    this.scheduleStartupSweep();
  }

  private registerCliHandlers(): void {
    this.registerCliHandler("vault-flow:plan-many", "Plan bounded exact paths without writes; return JSON summaries", {
      paths: { value: "<json-array|newline-list>", description: "Exact relative vault paths; JSON preserves spaces", required: true },
      limit: { value: "<1-200>", description: "Maximum distinct paths (default 100)" },
      trigger: { value: "<manual|live|sweep>", description: "Rule trigger context (default manual)" },
    }, async (params) => {
      if (this.settingsReadOnly) return cliError("Vault Flow cannot plan while incompatible settings are loaded.");
      const settings = this.settings, revision = this.settingsRevision, now = Date.now();
      return planCliPaths(params, async (path, trigger) => {
        const file = this.app.vault.getFileByPath(path);
        if (file === null) throw new Error(`No vault file exists at ${path}.`);
        return cliPlanSummary(await planReconciliationForFile(this.app, file, settings, { now, triggerContext: trigger }), trigger);
      }, { settingsRevision: revision, stillValid: () => this.loaded && this.settingsRevision === revision });
    });
    this.registerCliHandler("vault-flow:test-rule", "Run one rule’s synthetic fixtures without reading or writing vault notes", {
      rule: { value: "<rule-id>", description: "Exact configured rule ID", required: true },
    }, (params) => {
      if (this.settingsReadOnly) return cliError("Fixture checks require compatible settings.");
      const rule = this.settings.rules.find((candidate) => candidate.id === params.rule);
      if (rule === undefined) return cliError("No configured rule has that exact ID.");
      const results = runRuleFixtures(rule);
      return JSON.stringify({ status: results.every((result) => result.passed) ? "ok" : "failed", ruleId: rule.id, count: results.length, results }, null, 2);
    });
    this.registerCliHandler(
      "vault-flow:status",
      "Show Vault Flow dry-run, pause, queue, and latest-decision status as JSON",
      null,
      () => formatCliStatus({
        dryRun: this.settings.dryRun,
        paused: this.writeSafety.paused,
        pauseReason: this.writeSafety.reason,
        settingsReadOnly: this.settingsReadOnly,
        settingsRevision: this.settingsRevision,
        queue: this.queue?.snapshot() ?? { pendingCount: 0, runningCount: 0 },
        latestDecision: this.settings.recentDecisions[this.settings.recentDecisions.length - 1] ?? null,
      }),
    );
    this.registerCliHandler(
      "vault-flow:diagnostics",
      "Return bounded device-local Vault Flow diagnostics as JSON",
      {
        limit: { value: "<1-200>", description: "Maximum recent matching decisions (default 20)" },
        outcome: { value: "<outcome>", description: "Filter by outcome (default all)" },
      },
      (params) => formatCliDiagnostics(this.settings.recentDecisions, params),
    );
    this.registerCliHandler(
      "vault-flow:plan",
      "Plan one exact vault path without writing and return a bounded JSON summary",
      {
        path: { value: "<vault-path>", description: "Exact Markdown path from the vault root", required: true },
        trigger: { value: "<manual|live|sweep>", description: "Rule trigger context (default manual)" },
      },
      async (params) => {
        if (this.settingsReadOnly) return cliError("Vault Flow cannot plan while incompatible settings are loaded.");
        const path = typeof params.path === "string" ? normalizePath(params.path.trim()) : "";
        if (path.length === 0) return cliError("path must be a nonempty exact vault path.");
        const trigger = parseCliTrigger(params.trigger);
        if (trigger === null) return cliError("trigger must be manual, live, or sweep.");
        const file = this.app.vault.getFileByPath(path);
        if (file === null) return cliError(`No vault file exists at ${path}.`);
        try {
          const plan = await planReconciliationForFile(this.app, file, this.settings, { now: Date.now(), triggerContext: trigger });
          return formatCliPlan(plan, trigger);
        } catch (error) {
          return cliError(`Planning failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );
  }

  override async onExternalSettingsChange(): Promise<void> {
    const rawData: unknown = await this.loadData();
    const sanitized = sanitizeVaultFlowSettings(rawData, DEFAULT_SETTINGS);
    const runtimeState: VaultFlowRuntimeState = {
      trackedMtimes: this.settings.trackedMtimes,
      recentDecisions: this.settings.recentDecisions,
      ruleStats: this.settings.ruleStats,
    };
    this.settingsReadOnly = sanitized.incompatibleVersion !== undefined || sanitized.regexErrors !== undefined || sanitized.scopeErrors !== undefined || sanitized.ruleErrors !== undefined;
    this.settings = { ...sanitized.settings, ...runtimeState };
    this.settingsRevision += 1;
    this.configurePeriodicSweep();
    this.updateStatusBar();
    if (this.settingsReadOnly) {
      new Notice(sanitized.ruleErrors !== undefined
        ? `Vault Flow automation is disabled: ${sanitized.ruleErrors.join(" ")} Settings were not overwritten.`
        : sanitized.scopeErrors !== undefined
        ? `Vault Flow automation is disabled: invalid scope settings (${sanitized.scopeErrors.join(", ")}). Settings were not overwritten.`
        : sanitized.regexErrors !== undefined
        ? `Vault Flow automation is disabled: unsupported regex or glob in ${sanitized.regexErrors.join(", ")}. Settings were not overwritten. Update these patterns in data.json and reload the plugin.`
        : `Vault Flow settings changed to unsupported schema version ${sanitized.incompatibleVersion}; automation is disabled.`);
    } else {
      if (sanitized.sanitized) new Notice("Vault Flow reloaded externally changed settings after sanitizing invalid values.");
      this.queue?.resumeDeferred();
    }
  }

  override onunload(): void {
    this.loaded = false;
    this.startupSweepRequestId += 1;
    this.vaultLifecycleEventsRegistered = false;
    this.clearPeriodicSweepInterval();
    if (this.diagnosticsRefreshTimer !== null) window.clearTimeout(this.diagnosticsRefreshTimer);
    this.diagnosticsRefreshTimer = null;
    this.flushRuntimeStateSave();
    this.queue?.clear();
    this.pendingSweepPaths.clear();
    this.queue = null;
    this.statusBarItemEl = null;
  }

  public getSettings(): VaultFlowSettings {
    return this.settings;
  }

  public isAutomationPaused(): boolean { return this.writeSafety.paused; }

  public setAutomationPaused(paused: boolean): void { this.writeSafety.setPaused(paused); }

  public runAllRulesNow(): void {
    void this.enqueueAllWithConfirmation();
  }

  public async updateSettings(settings: Partial<VaultFlowSettings>): Promise<void> {
    if (this.settingsReadOnly) {
      new Notice("Vault Flow settings are read-only because they contain an unsupported schema or pattern. Fix the settings file and reload the plugin.");
      return;
    }
    const previousSettings = this.settings;
    const sanitizedSettings = sanitizeVaultFlowSettings({ ...this.settings, ...settings }, DEFAULT_SETTINGS);
    if (sanitizedSettings.ruleErrors !== undefined) {
      new Notice(`Vault Flow did not save settings: ${sanitizedSettings.ruleErrors.join(" ")}`);
      return;
    }
    if (sanitizedSettings.scopeErrors !== undefined) {
      new Notice(`Vault Flow did not save invalid scope settings: ${sanitizedSettings.scopeErrors.join(", ")}.`);
      return;
    }
    if (sanitizedSettings.regexErrors !== undefined) {
      new Notice(`Vault Flow did not save settings: unsupported regex or glob in ${sanitizedSettings.regexErrors.join(", ")}.`);
      return;
    }
    this.settings = sanitizedSettings.settings;
    this.settingsRevision += 1;
    if (sanitizedSettings.sanitized) {
      new Notice("Vault Flow ignored one or more invalid setting values.");
    }
    await this.saveSettings();
    this.updateStatusBar();
    this.configurePeriodicSweep();
    if (previousSettings.sweepOnStartup && !this.settings.sweepOnStartup) {
      this.startupSweepRequestId += 1;
    }
    if (!previousSettings.sweepOnStartup && this.settings.sweepOnStartup) {
      this.scheduleStartupSweep();
    }
  }

  private async enqueueAllWithConfirmation(): Promise<void> {
    if (this.settingsReadOnly) {
      new Notice("Vault Flow automation is disabled because incompatible settings are loaded.");
      return;
    }
    const files = this.includedMarkdownFiles();
    if (!this.settings.dryRun) {
      const confirmed = await confirmVaultWideWrite(this.app, files.length);
      if (!confirmed) {
        return;
      }
    }
    await this.queue?.enqueueMany(files, "manual");
    new Notice(`Vault Flow enqueued ${files.length} monitored Markdown file${files.length === 1 ? "" : "s"}.`);
  }

  private scheduleStartupSweep(): void {
    if (this.settingsReadOnly || !this.settings.sweepOnStartup) {
      return;
    }

    const requestId = this.startupSweepRequestId + 1;
    this.startupSweepRequestId = requestId;
    this.app.workspace.onLayoutReady(() => {
      if (!this.loaded || this.settingsReadOnly || !this.settings.sweepOnStartup || requestId !== this.startupSweepRequestId) {
        return;
      }

      void this.runMtimeSweep();
    });
  }

  private configurePeriodicSweep(): void {
    this.clearPeriodicSweepInterval();
    if (this.settingsReadOnly || !this.settings.periodicSweepEnabled) {
      return;
    }

    this.periodicSweepIntervalId = window.setInterval(() => {
      const documentHidden = this.app.workspace.containerEl.ownerDocument.hidden;
      if (shouldRunPeriodicSweep({ isMobileApp: Platform.isMobileApp, documentHidden })) {
        void this.runMtimeSweep();
      }
    }, computeJitteredSweepIntervalMs(this.settings.sweepIntervalMs, undefined, MIN_SWEEP_INTERVAL_MS));
    this.registerInterval(this.periodicSweepIntervalId);
  }

  private enqueueSelectedMarkdownFiles(files: readonly TAbstractFile[], triggerContext: "live" | "sweep" | "manual" = "manual"): void {
    if (this.settingsReadOnly) {
      new Notice("Vault Flow automation is disabled because incompatible settings are loaded.");
      return;
    }
    const markdownFiles = selectedMarkdownFiles(files);
    if (markdownFiles.length === 0) {
      new Notice("Vault Flow found no selected Markdown files to reconcile.");
      return;
    }

    void this.queue?.enqueueMany(markdownFiles.filter((file) => this.isProcessableFile(file)), triggerContext);
  }

  private isActiveFile(file: TFile): boolean {
    const activeFile = this.app.workspace.getActiveFile();
    return activeFile instanceof TFile && normalizePath(activeFile.path) === normalizePath(file.path);
  }

  private activeMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file instanceof TFile && isMarkdownFile(file) ? file : null;
  }

  private clearPeriodicSweepInterval(): void {
    if (this.periodicSweepIntervalId === null) {
      return;
    }

    window.clearInterval(this.periodicSweepIntervalId);
    this.periodicSweepIntervalId = null;
  }

  private registerVaultLifecycleEvents(): void {
    if (!this.loaded || this.vaultLifecycleEventsRegistered) {
      return;
    }

    this.vaultLifecycleEventsRegistered = true;
    this.registerEvent(this.app.vault.on("create", (file) => {
      void this.handleVaultCreate(file);
    }));

    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.queue?.cancel(file.path);
      if (!this.settingsReadOnly) {
        this.flushTrackedMtimeCache();
        void this.updateTrackedMtimes(removeTrackedMtimePath(this.settings.trackedMtimes, file.path));
      }
    }));
  }

  private async handleVaultCreate(file: TAbstractFile): Promise<void> {
    if (this.settingsReadOnly || !(file instanceof TFile)) {
      return;
    }

    if (this.isProcessableFile(file)) {
      this.queue?.enqueue(file, "live");
    }
  }

  private async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    this.queue?.cancel(oldPath);
    if (this.settingsReadOnly) {
      return;
    }

    this.flushTrackedMtimeCache();
    const removedOldPath = removeTrackedMtimePath(this.settings.trackedMtimes, oldPath);
    if (file instanceof TFile) {
      if (this.isProcessableFile(file)) {
        this.queue?.enqueue(file, "live");
      }

      await this.updateTrackedMtimes(removedOldPath);
      return;
    }

    if (!(file instanceof TFolder)) {
      await this.updateTrackedMtimes(removedOldPath);
      return;
    }

    await this.queue?.enqueueMany(markdownFilesInFolder(file).filter((markdownFile) => this.isProcessableFile(markdownFile)), "live");
    await this.updateTrackedMtimes(removedOldPath);
  }

  private enqueueIfProcessable(file: TFile, triggerContext: "live" | "sweep" | "manual" = "live"): void {
    if (!this.settingsReadOnly && this.isProcessableFile(file)) {
      this.queue?.enqueue(file, triggerContext);
    }
  }

  private openWriteRecovery(): void {
    new RecoveryModal(this.app, () => this.journal?.entries() ?? [], async (entry) => this.restoreRecoveredHistory(entry),
      async (id) => { await this.mutationCoordinator.runExclusive(async () => { this.journal?.acknowledge(id); }); }, this.journal?.blockedReason ?? null).open();
  }

  private openWorkInbox(): void {
    new WorkInboxModal(this.app, () => buildWorkInbox(this.settings.recentDecisions, this.journal?.entries() ?? [], [...this.pendingSweepPaths]), {
      replan: async (item) => this.replanInboxItem(item),
      openRecovery: () => this.openWriteRecovery(),
      openNote: async (path) => {
        const file = this.app.vault.getFileByPath(path);
        if (file === null || !isSupportedNote(file)) throw new Error("The vault note no longer exists at this exact path.");
        await this.app.workspace.openLinkText(file.path, "", true);
      },
    }).open();
  }

  private async replanInboxItem(item: WorkInboxItem): Promise<void> {
    if (!this.loaded || this.settingsReadOnly) throw new Error("Compatible, loaded settings are required to replan.");
    if (this.journal?.blockedReason || this.journal?.entries().some((entry) => entry.beforePath === item.path || entry.afterPath === item.path)) {
      this.openWriteRecovery();
      return;
    }
    const file = this.app.vault.getFileByPath(item.path);
    if (file === null || !isSupportedNote(file)) throw new Error("The vault note no longer exists at this exact path.");
    await this.openVaultPreview([file], item.triggerContexts);
  }

  private async openVaultPreview(files: readonly TFile[], triggerContexts: readonly RuleRunOn[] = ["manual"]): Promise<void> {
    const progress = new VaultPlanningProgressModal(this.app, files.length);
    progress.open();
    let cancelled = false;
    try {
      const now = Date.now();
      const settings = this.settings;
      const settingsRevision = this.settingsRevision;
      const results = await mapWithConcurrency(
        files,
        4,
        async (file) => compactPreviewPlan(await planReconciliationForFile(
          this.app,
          file,
          settings,
          { now, triggerContext: triggerContexts },
        )),
        {
          retainResult: (plan) => !["unchanged", "excluded"].includes(plan.preview.outcome),
          isCancelled: () => progress.isCancelled()
            || !this.loaded
            || this.settingsReadOnly
            || settingsRevision !== this.settingsRevision,
          onProgress: (completed) => progress.update(completed),
        },
      );
      cancelled = progress.isCancelled();
      if (cancelled) {
        new Notice("Vault Flow preview planning was cancelled.");
        return;
      }
      if (!this.loaded) {
        return;
      }
      if (settingsRevision !== this.settingsRevision || this.settingsReadOnly) {
        new Notice("Vault Flow settings changed while the preview was being generated. Run the preview again.");
        return;
      }
      const entries = results.map((preview) => ({
        path: preview.preview.path,
        desiredPath: preview.preview.desiredPath,
        propertyChangeCount: preview.result === null ? 0 : countFrontmatterChanges(preview.current, preview.result.desired),
        preview,
      }));
      new VaultPreviewModal(
        this.app,
        entries,
        {
          collisionPolicy: () => this.settings.collisionPolicy,
          recordDecision: async (decision) => {
            await this.recordDecision({ ...decision, triggerContexts });
          },
          runExclusive: async (operation) => this.mutationCoordinator.runExclusive(operation),
          recordBatch: (receipt) => this.recordBatch(receipt),
          assertCanApply: () => this.assertAutomationEnabled(settingsRevision),
          maxBatchWrites: () => this.settings.maxBatchWrites,
          onMutationStarted: (pending) => this.startJournal(pending),
          onMutationFinished: (transaction) => this.finishJournal(transaction),
          onMutationFailed: () => this.pauseAfterMutationFailure(),
        },
      ).open();
    } catch (error) {
      if (!progress.isCancelled()) {
        new Notice(`Vault Flow could not build the vault preview: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      progress.finish();
    }
  }

  private includedMarkdownFiles(): readonly TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isProcessableFile(file));
  }

  /**
   * Returns true if a file should be processed by Vault Flow.
   * Checks the file type, the monitored-folders allowlist,
   * the exclusion-patterns blocklist, and the per-file disable frontmatter key.
   */
  private isProcessableFile(file: TFile): boolean {
    return evaluateFileEligibility(
      file,
      this.app.metadataCache.getFileCache(file),
      this.settings,
    ).eligible;
  }

  private trackSweepMtime(file: TFile): void {
    if (!Number.isFinite(file.stat.mtime)) return;
    this.trackedMtimeCache ??= new Map(Object.entries(this.settings.trackedMtimes));
    const path = normalizePath(file.path);
    if (this.trackedMtimeCache.get(path) === file.stat.mtime) return;
    this.trackedMtimeCache.set(path, file.stat.mtime);
    this.trackedMtimesDirty = true;
    this.scheduleRuntimeStateSave();
  }

  private flushTrackedMtimeCache(): void {
    if (!this.trackedMtimesDirty || this.trackedMtimeCache === null) return;
    this.settings = { ...this.settings, trackedMtimes: Object.fromEntries(this.trackedMtimeCache) };
    this.trackedMtimesDirty = false;
  }

  private updateTrackedMtimes(update: MtimeMapUpdate): Promise<void> {
    if (!update.changed) {
      return Promise.resolve();
    }

    this.settings = {
      ...this.settings,
      trackedMtimes: update.trackedMtimes,
    };
    this.trackedMtimeCache = new Map(Object.entries(update.trackedMtimes));
    this.trackedMtimesDirty = false;
    this.scheduleRuntimeStateSave();
    this.updateStatusBar();
    return Promise.resolve();
  }

  private async runMtimeSweep(): Promise<void> {
    if (this.settingsReadOnly) {
      return;
    }
    this.flushTrackedMtimeCache();
    const now = Date.now();
    const previousSweepAt = this.lastSweepAt;
    const force = this.lastSweepRevision !== this.settingsRevision
      || previousSweepAt === null
      || now < previousSweepAt;
    // Layout readiness does not imply metadata readiness. Retain the sweep
    // trigger until each statically in-scope note has actually been indexed.
    const allFiles = this.app.vault.getMarkdownFiles();
    this.pendingSweepPaths = new Set(allFiles.filter((file) =>
      this.app.metadataCache.getFileCache(file) === null
      && evaluateFileEligibility(file, {}, this.settings).eligible).map((file) => normalizePath(file.path)));
    const markdownFiles = allFiles.filter((file) => this.isProcessableFile(file));
    const currentPaths = new Set(markdownFiles.map((file) => normalizePath(file.path)));
    for (const path of this.sweepEvaluationTimes.keys()) if (!currentPaths.has(path)) this.sweepEvaluationTimes.delete(path);
    const plan = planMtimeSweep(markdownFiles, this.settings.trackedMtimes, {
      force,
      ...(force ? {} : {
        shouldReevaluate: (file: TFile) => {
          const evaluatedAt = this.sweepEvaluationTimes.get(normalizePath(file.path));
          return evaluatedAt === undefined || timeDependentSweepDue(
            file,
            this.app.metadataCache.getFileCache(file),
            this.settings.rules,
            evaluatedAt,
            now,
          );
        },
      }),
    });
    // Global time only identifies first/forced sweeps. Each note retains its last
    // successful evaluation window, so enqueueing a failed age rule cannot lose it.
    this.lastSweepRevision = this.settingsRevision;
    this.lastSweepAt = now;

    await this.queue?.enqueueMany(plan.filesToEnqueue, "sweep");

    await this.updateTrackedMtimes(pruneTrackedMtimesToFiles(this.settings.trackedMtimes, markdownFiles));
  }

  private recordDecision(decision: ReconciliationDecision): Promise<void> {
    const recentDecisions = pruneDecisions([...this.settings.recentDecisions, diagnosticSummary(decision)]);
    if (decision.outcome === "changed" && decision.afterIdentity === undefined) {
      new Notice("This Vault Flow write completed, but its note identity could not be captured. Undo is unavailable for this transaction. Keep independent backups.");
    }
    if (decision.outcome === "changed" || decision.outcome === "undone") {
      this.transactions = pruneTransactionHistory([...this.transactions, decision]);
      if (decision.outcome === "changed" && !this.transactions.includes(decision)) {
        new Notice("This Vault Flow transaction exceeded undo retention limits. Keep independent backups.");
      }
    }
    let ruleStats = this.settings.ruleStats;

    if (decision.outcome === "changed" || decision.outcome === "dry-run") {
      ruleStats = { ...this.settings.ruleStats };
      const now = Date.now();
      const ruleIds = new Set([...decision.appliedRuleIds, ...(decision.dryRunRuleIds ?? [])]);
      for (const ruleId of ruleIds) {
        if (isUnsafeObjectKey(ruleId)) {
          continue;
        }
        const existing = ruleStats[ruleId];
        ruleStats[ruleId] = {
          matchCount: (existing?.matchCount ?? 0) + 1,
          lastMatchAt: now,
        };
      }
    }

    this.settings = { ...this.settings, recentDecisions, ruleStats };
    this.scheduleRuntimeStateSave();
    if (this.journal !== null && (decision.outcome === "changed" || decision.outcome === "undone") && decision.transactionId !== undefined) {
      this.flushRuntimeStateSave();
      const retained = decision.outcome === "undone" || this.transactions.some((transaction) => transaction.transactionId === decision.transactionId);
      if (!this.runtimeSaveFailed && retained) {
        try { this.journal.acknowledge(decision.transactionId); }
        catch { this.writeSafety.pause("A completed write could not be removed from the recovery journal"); }
      } else this.writeSafety.pause("Undo history was not retained; inspect the pending-write recovery snapshot");
    }
    this.scheduleDiagnosticsRefresh();
    this.updateStatusBar();
    return Promise.resolve();
  }

  private pauseAfterMutationFailure(): void {
    this.writeSafety.pause("A note mutation failed; inspect pending-write recovery before resuming");
  }

  private startJournal(pending: PendingNoteMutation): void {
    this.writeSafety.consume(this.settings.maxWritesPerMinute);
    try { this.journal?.begin(pending); }
    catch (error) { this.writeSafety.pause("The write-ahead journal is unavailable; no note write was started"); throw error; }
  }

  private finishJournal(transaction: AppliedReconciliationTransaction): void {
    try { this.journal?.complete(transaction); }
    catch { this.writeSafety.pause("The write completed but its recovery snapshot could not be updated"); }
  }

  private async restoreRecoveredHistory(entry: JournalEntry): Promise<boolean> {
    try {
      return await this.mutationCoordinator.runExclusive(async () => {
        if (!this.loaded || this.settingsReadOnly) throw new Error("Compatible, loaded settings are required.");
        const latest = this.journal?.entries().find((candidate) => candidate.transactionId === entry.transactionId);
        if (latest?.status !== "completed" || latest.transaction?.afterIdentity === undefined) throw new Error("No verified completed write is available. Inspect and export its snapshot instead.");
        validateVaultPath(this.app, latest.beforePath); validateVaultPath(this.app, latest.afterPath);
        const file = this.app.vault.getFileByPath(latest.afterPath);
        if (file === null || !isSupportedNote(file) || !sameNoteIdentity(latest.transaction.afterIdentity, await captureNoteIdentity(this.app, file)) || this.app.vault.getFileByPath(latest.afterPath) !== file) throw new Error("The note was changed or replaced. Inspect it manually; recovery will not overwrite newer work.");
        const frontmatter = latest.mutationKinds.includes("frontmatter");
        await this.recordDecision({ timestamp: latest.timestamp, transactionId: latest.transactionId, path: latest.beforePath, desiredPath: latest.afterPath,
          outcome: latest.operation === "undo" ? "undone" : "changed", appliedRuleIds: latest.ruleIds, involvedRuleIds: [], mutationKinds: latest.mutationKinds,
          iterations: latest.iterations, afterIdentity: latest.transaction.afterIdentity,
          ...(frontmatter ? { beforeFrontmatter: latest.beforeFrontmatter, afterFrontmatter: latest.afterFrontmatter } : {}),
          ...(latest.revertsTransactionId === undefined ? {} : { revertsTransactionId: latest.revertsTransactionId }), message: "Recovered verified completed write from the device-local journal." });
        if (this.runtimeSaveFailed || this.journal?.entries().some((candidate) => candidate.transactionId === latest.transactionId)) throw new Error("History could not retain this snapshot. Export it before acknowledging it manually.");
        new Notice("Verified completed write restored to history. No note was modified; writes remain paused.");
        return true;
      });
    } catch (error) { new Notice(`Vault Flow recovery: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }

  private recordBatch(receipt: BatchReceipt): void {
    this.batches = sanitizeBatchHistory([...this.batches, receipt]);
    if (!this.batches.some((entry) => entry.batchId === receipt.batchId)) new Notice("This batch receipt exceeded retention limits. Its diagnostic decisions are still available.");
    this.scheduleRuntimeStateSave();
  }

  private async undoBatch(batchId: string): Promise<void> {
    const decisions = this.transactions.filter((decision) => decision.batchId === batchId).reverse();
    let undone = 0;
    for (const decision of decisions) {
      if (!this.loaded || this.writeSafety.paused) break;
      if (await this.undoLastMoveOrRename(decision)) undone += 1;
      if (undone > 0 && undone % 25 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    new Notice(`Vault Flow batch undo: ${undone} of ${decisions.length} retained transactions reversed. Others were preserved or could not be safely undone.`);
  }

  private async undoLastMoveOrRename(targetDecision?: ReconciliationDecision): Promise<boolean> {
    if (this.settingsReadOnly) {
      new Notice("Vault Flow cannot undo while incompatible settings are loaded.");
      return false;
    }

    // The journal contains only retained, not-yet-undone transactions.
    const resolvedDecision = targetDecision ?? this.transactions[this.transactions.length - 1] ?? null;

    if (resolvedDecision === null) {
      new Notice("Vault Flow has no recent transaction to undo.");
      return false;
    }

    const afterIdentity = resolvedDecision.afterIdentity;
    if (afterIdentity === undefined) {
      new Notice("Vault Flow cannot safely undo this transaction because its note identity is unavailable.");
      return false;
    }
    const currentPath = normalizePath(resolvedDecision.desiredPath ?? resolvedDecision.path);
    const originalPath = normalizePath(resolvedDecision.path);
    const hasFrontmatterTransaction = resolvedDecision.beforeFrontmatter !== undefined
      && resolvedDecision.afterFrontmatter !== undefined;
    if (resolvedDecision.mutationKinds.includes("frontmatter") && !hasFrontmatterTransaction) {
      new Notice("Vault Flow cannot safely undo this legacy frontmatter change because its complete transaction snapshot is unavailable.");
      return false;
    }

    try {
      const undone = await this.mutationCoordinator.runExclusive(async () => {
        this.assertAutomationEnabled();
        const file = this.app.vault.getFileByPath(currentPath);
        if (file === null || !isSupportedNote(file)) {
          throw new Error(`The Markdown note could not be found at ${currentPath}.`);
        }
        validateVaultPath(this.app, currentPath); validateVaultPath(this.app, originalPath);
        const currentIdentity = await captureNoteIdentity(this.app, file);
        this.assertAutomationEnabled();
        if (!sameNoteIdentity(afterIdentity, currentIdentity)
          || this.app.vault.getFileByPath(currentPath) !== file) {
          throw new Error("The note was edited or replaced after this transaction; undo was cancelled to preserve newer work.");
        }
        if (currentPath !== originalPath) {
          const existing = this.app.vault.getAbstractFileByPath(originalPath);
          if (existing !== null && normalizePath(existing.path) !== currentPath) {
            throw new Error(`The original path ${originalPath} is already occupied.`);
          }
        }

        const timestamp = Date.now();
        const transactionId = createTransactionId(timestamp, currentPath);
        this.startJournal({ transactionId, timestamp, beforePath: currentPath, afterPath: originalPath, operation: "undo",
          beforeFrontmatter: resolvedDecision.afterFrontmatter, afterFrontmatter: resolvedDecision.beforeFrontmatter,
          mutationKinds: resolvedDecision.mutationKinds, ruleIds: [], iterations: 0,
          ...(resolvedDecision.transactionId === undefined ? {} : { revertsTransactionId: resolvedDecision.transactionId }) });
        let renamed = false;
        if (currentPath !== originalPath) {
          await this.app.fileManager.renameFile(file, originalPath);
          renamed = true;
        }

        try {
          this.assertAutomationEnabled();
          if (hasFrontmatterTransaction) {
            await this.app.fileManager.processFrontMatter(file, (value: unknown) => {
              if (!isRecord(value)) {
                throw new Error("Obsidian returned invalid frontmatter data.");
              }
              if (!unknownValuesEqual(value, resolvedDecision.afterFrontmatter)) {
                throw new Error("The note frontmatter changed after this transaction; undo was cancelled to preserve newer edits.");
              }
              replaceUnknownRecord(value, resolvedDecision.beforeFrontmatter ?? {});
            });
          }
        } catch (error) {
          if (renamed) {
            await this.app.fileManager.renameFile(file, currentPath);
          }
          throw error;
        }

        let restoredIdentity;
        try { restoredIdentity = await captureNoteIdentity(this.app, file); } catch { restoredIdentity = undefined; }
        this.finishJournal({ transactionId, beforePath: currentPath, afterPath: originalPath,
          ...(hasFrontmatterTransaction ? { beforeFrontmatter: resolvedDecision.afterFrontmatter, afterFrontmatter: resolvedDecision.beforeFrontmatter } : {}),
          ...(restoredIdentity === undefined ? {} : { afterIdentity: restoredIdentity }) });
        return { renamed, restoredFrontmatter: hasFrontmatterTransaction, transactionId };
      });

      this.queue?.cancel(currentPath);
      this.queue?.cancel(originalPath);
      const timestamp = Date.now();
      await this.recordDecision({
        timestamp,
        path: currentPath,
        outcome: "undone",
        transactionId: undone.transactionId,
        appliedRuleIds: [],
        involvedRuleIds: [],
        mutationKinds: resolvedDecision.mutationKinds,
        iterations: 0,
        desiredPath: originalPath,
        ...(resolvedDecision.transactionId === undefined ? {} : { revertsTransactionId: resolvedDecision.transactionId }),
        message: "Vault Flow transaction was undone after verifying its current frontmatter baseline.",
      });

      if (undone.renamed) {
        new Notice(`Vault Flow undid change: ${currentPath} → ${originalPath}`);
      } else if (undone.restoredFrontmatter) {
        new Notice(`Vault Flow restored frontmatter for ${originalPath}.`);
      }
      return true;
    } catch (error) {
      new Notice(`Vault Flow undo failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private assertAutomationEnabled(expectedRevision?: number): void {
    if (!this.loaded) {
      throw new Error("Vault Flow was unloaded before this operation could be applied.");
    }
    if (this.settingsReadOnly) {
      throw new Error("Vault Flow automation is disabled because incompatible settings are loaded.");
    }
    this.writeSafety.assertCanWrite();
    if (expectedRevision !== undefined && expectedRevision !== this.settingsRevision) {
      throw new Error("Vault Flow settings changed after this plan was generated. Run the preview again.");
    }
  }

  private scheduleRuntimeStateSave(): void {
    if (!this.loaded || typeof window === "undefined") {
      this.saveRuntimeStateNow();
      return;
    }
    if (this.runtimeSaveTimer !== null) {
      window.clearTimeout(this.runtimeSaveTimer);
    }
    this.runtimeSaveTimer = window.setTimeout(() => {
      this.runtimeSaveTimer = null;
      this.saveRuntimeStateNow();
    }, RUNTIME_SAVE_DEBOUNCE_MS);
  }

  private flushRuntimeStateSave(): void {
    if (this.runtimeSaveTimer !== null) {
      window.clearTimeout(this.runtimeSaveTimer);
      this.runtimeSaveTimer = null;
    }
    this.saveRuntimeStateNow();
  }

  private saveRuntimeStateNow(): void {
    if (this.settingsReadOnly) return;
    this.flushTrackedMtimeCache();
    const runtimeState: VaultFlowRuntimeState = {
      trackedMtimes: this.settings.trackedMtimes,
      recentDecisions: this.settings.recentDecisions,
      ruleStats: this.settings.ruleStats,
      transactions: this.transactions,
      batches: this.batches,
    };
    try {
      this.app.saveLocalStorage(RUNTIME_STORAGE_KEY, runtimeState);
      this.runtimeSaveFailed = false;
    } catch {
      if (!this.runtimeSaveFailed) {
        new Notice("Vault Flow could not save device-local runtime state. Undo history may not survive restart. Keep independent backups.");
      }
      this.runtimeSaveFailed = true;
    }
  }

  private async saveSettings(): Promise<void> {
    const save = this.settingsSaveChain.then(async () => {
      await this.saveData(settingsDataForSave(this.settings));
    });
    this.settingsSaveChain = save.catch(() => {});
    await save;
  }

  private updateStatusBar(snapshot?: ReconciliationQueueSnapshot): void {
    if (this.statusBarItemEl === null) {
      return;
    }

    this.statusBarItemEl.textContent = formatVaultFlowStatus({
      dryRun: this.settings.dryRun,
      paused: this.writeSafety.paused,
      queue: snapshot ?? this.queue?.snapshot() ?? { pendingCount: 0, runningCount: 0 },
      latestDecision: this.settings.recentDecisions[this.settings.recentDecisions.length - 1] ?? null,
    });
  }

  private async openDiagnosticsView(): Promise<void> {
    await this.app.workspace.ensureSideLeaf(
      VAULT_FLOW_DIAGNOSTICS_VIEW_TYPE,
      "secondary",
      { active: true, reveal: true },
    );
  }

  private async exportDiagnostics(): Promise<void> {
    const decisions = this.settings.recentDecisions;
    const header = "| Time | File | Outcome | Mutations | Rules |\n| --- | --- | --- | --- | --- |";
    const rows = decisions.map((decision) => {
      const time = formatDiagnosticTimestamp(decision.timestamp);
      const file = decision.path.replace(/\|/gu, "\\|");
      const mutations = decision.mutationKinds.join(", ") || "—";
      const rules = decision.appliedRuleIds.join(", ") || "—";
      return `| ${time} | ${file} | ${decision.outcome} | ${mutations} | ${rules} |`;
    });
    const content = `# Vault Flow diagnostics\n\n${header}\n${rows.join("\n")}\n`;
    const outputPath = `vault-flow-diagnostics-${moment().format("YYYY-MM-DD-HHmmss")}.md`;
    try {
      await this.app.vault.create(outputPath, content);
      new Notice(`Diagnostics exported to ${outputPath}`);
      await this.app.workspace.openLinkText(outputPath, "", false);
    } catch (error) {
      new Notice(`Vault Flow could not write diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleDiagnosticsRefresh(): void {
    if (!this.loaded || this.diagnosticsRefreshTimer !== null) return;
    this.diagnosticsRefreshTimer = window.setTimeout(() => {
      this.diagnosticsRefreshTimer = null;
      if (this.loaded) this.refreshDiagnosticsViews();
    }, 80);
  }

  private refreshDiagnosticsViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VAULT_FLOW_DIAGNOSTICS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof VaultFlowDiagnosticsView) {
        view.refresh();
      }
    }
  }
}

class VaultPlanningProgressModal extends Modal {
  private readonly total: number;
  private cancelled = false;
  private finished = false;
  private statusEl: HTMLElement | null = null;
  private progressBar: ProgressBarComponent | null = null;

  public constructor(app: Plugin["app"], total: number) {
    super(app);
    this.total = total;
  }

  override onOpen(): void {
    this.setTitle("Planning Vault Flow changes");
    this.contentEl.empty();
    this.statusEl = this.contentEl.createEl("p", {
      cls: "vf-planning-progress",
      text: this.progressText(0),
    });
    this.progressBar = new ProgressBarComponent(this.contentEl).setValue(this.total === 0 ? 100 : 0);
    const actions = this.contentEl.createDiv({ cls: "vf-modal-actions" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.cancelled = true;
      this.close();
    });
  }

  override onClose(): void {
    if (!this.finished) {
      this.cancelled = true;
    }
    this.statusEl = null;
    this.progressBar = null;
    this.contentEl.empty();
  }

  public update(completed: number): void {
    if (this.statusEl !== null) {
      this.statusEl.textContent = this.progressText(completed);
    }
    this.progressBar?.setValue(this.total === 0 ? 100 : Math.min(100, (completed / this.total) * 100));
  }

  public isCancelled(): boolean {
    return this.cancelled;
  }

  public finish(): void {
    this.finished = true;
    this.close();
  }

  private progressText(completed: number): string {
    return `Planned ${completed} of ${this.total} monitored Markdown file${this.total === 1 ? "" : "s"}.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PersistedVaultFlowSettings = Omit<VaultFlowSettings, "recentDecisions" | "trackedMtimes" | "ruleStats"> & { readonly settingsVersion: number };

function settingsDataForSave(settings: VaultFlowSettings): PersistedVaultFlowSettings {
  return {
    settingsVersion: SETTINGS_SCHEMA_VERSION,
    rules: settings.rules,
    debounceMs: settings.debounceMs,
    maxIterations: settings.maxIterations,
    useRegexSet: settings.useRegexSet,
    maxWritesPerMinute: settings.maxWritesPerMinute,
    maxBatchWrites: settings.maxBatchWrites,
    dryRun: settings.dryRun,
    collisionPolicy: settings.collisionPolicy,
    sweepOnStartup: settings.sweepOnStartup,
    periodicSweepEnabled: settings.periodicSweepEnabled,
    sweepIntervalMs: settings.sweepIntervalMs,
    monitoredFolders: settings.monitoredFolders,
    exclusionPatterns: settings.exclusionPatterns,
    disableFrontmatterKey: settings.disableFrontmatterKey,
  };
}

function formatDiagnosticTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return String(timestamp);
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function confirmBatchUndo(app: Plugin["app"], count: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new ConfirmationModal(app);
    modal.setTitle("Undo retained batch transactions");
    modal.setContent(`Attempt to undo ${count} retained transactions in reverse order? Each note is verified independently; edited, replaced, missing, or conflicting notes are preserved. Write limits still apply.`);
    modal.addButton((button) => {
      button.setButtonText("Undo batch").setDestructive().onClick(() => { settled = true; resolve(true); });
    });
    modal.addCancelButton();
    modal.setCloseCallback(() => { if (!settled) resolve(false); });
    modal.open();
  });
}

function confirmVaultWideWrite(app: Plugin["app"], fileCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new ConfirmationModal(app);
    modal.setTitle("Reconcile monitored notes");
    modal.setContent(`Dry-run mode is disabled. Reconcile ${fileCount} monitored Markdown file${fileCount === 1 ? "" : "s"} and allow Vault Flow to write changes?`);
    modal.addButton((button) => {
      button
        .setButtonText("Reconcile files")
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

async function writeClipboardText(ownerNavigator: Navigator | undefined, text: string, successMessage: string, failurePrefix: string): Promise<void> {
  try {
    if (ownerNavigator?.clipboard?.writeText === undefined) {
      new Notice(`${failurePrefix}: clipboard is unavailable.`);
      return;
    }

    await ownerNavigator.clipboard.writeText(text);
    new Notice(successMessage);
  } catch (err) {
    new Notice(`${failurePrefix}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function pruneDecisions(decisions: readonly ReconciliationDecision[]): readonly ReconciliationDecision[] {
  const cutoff = Date.now() - DECISION_MAX_AGE_MS;
  return decisions
    .filter((decision) => Number.isFinite(decision.timestamp) && decision.timestamp >= cutoff)
    .slice(-DECISION_MAX_ENTRIES);
}

function hasLegacyRuntimeState(value: unknown): boolean {
  return isRecord(value)
    && ("recentDecisions" in value || "trackedMtimes" in value || "ruleStats" in value);
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function replaceUnknownRecord(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    Reflect.deleteProperty(target, key);
  }
  const clonedSource = cloneUnknownRecord(source);
  for (const key of Object.keys(clonedSource)) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: clonedSource[key],
      writable: true,
    });
  }
}

function cloneUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof structuredClone === "function") {
    return structuredClone<Record<string, unknown>>(value);
  }
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isRecord(parsed) ? parsed : Object.create(null) as Record<string, unknown>;
}

function markdownFilesInFolder(folder: TFolder): readonly TFile[] {
  const files: TFile[] = [];
  Vault.recurseChildren(folder, (child) => {
    if (child instanceof TFile && isMarkdownFile(child)) {
      files.push(child);
    }
  });
  return files;
}
