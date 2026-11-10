import { Notice, normalizePath, type App, type TFile } from "obsidian";
import type { DryRunRuleMatch, NoteState, PlannedMutation, ReconciliationConverged, ReconciliationResult, RuleRunOn } from "../engine";
import { applyReconciliationResult, isMarkdownFile, noteStateFromObsidian, resolveMoveCollision, TransactionInterruptedError, validateReconciliationResult } from "./adapter";
import { createTransactionId, type ReconciliationDecision } from "./diagnostics";
import { evaluateFileEligibility } from "./eligibility";
import { sameNoteStateBaseline, withNoteStatePath } from "./note-state";
import { markdownBodyContent, planFileReconciliation, type FilePlanningSettings } from "./planner";
import type { CollisionPolicy } from "./settings";

export interface ReconciliationQueueOptions {
  readonly debounceMs: number;
  readonly maxIterations: number;
  readonly useRegexSet?: boolean;
  readonly dryRun: boolean;
  readonly collisionPolicy: CollisionPolicy;
  readonly rules: FilePlanningSettings["rules"];
  readonly monitoredFolders?: readonly string[];
  readonly exclusionPatterns?: readonly string[];
  readonly disableFrontmatterKey?: string;
  readonly revision?: number;
  readonly maxConcurrent?: number;
  readonly automationEnabled?: boolean;
}

export interface ReconciliationQueueSnapshot {
  readonly pendingCount: number;
  readonly runningCount: number;
}

export interface ReconciliationQueueCallbacks {
  readonly recordDecision?: (decision: ReconciliationDecision) => void | Promise<void>;
  readonly onSnapshotChange?: (snapshot: ReconciliationQueueSnapshot) => void;
  readonly shouldDeferLiveWrite?: (file: TFile) => boolean;
  readonly onReconciled?: (file: TFile, context: { readonly triggerContexts: readonly RuleRunOn[]; readonly revision: number }) => void | Promise<void>;
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
  readonly onMutationStarted?: Parameters<typeof applyReconciliationResult>[5];
  readonly onMutationFinished?: Parameters<typeof applyReconciliationResult>[6];
}

type ReconciliationCompletion = "reconciled" | "deferred" | "failed";
const MAX_CONTENT_READ_FAILURES = 3;
const DEFAULT_MAX_CONCURRENT = 4;

interface PendingEntry {
  readonly file: TFile;
  readonly triggerContexts: readonly RuleRunOn[];
}

export class ReconciliationQueue {
  private readonly timers = new Map<string, number>();
  private readonly pendingFiles = new Map<string, PendingEntry>();
  private readonly deferredFiles = new Map<string, PendingEntry>();
  private readonly readyPaths = new Set<string>();
  private readonly runningPaths = new Set<string>();
  private readonly cancellationVersions = new Map<string, number>();
  private readonly expectedRenamePaths = new Map<string, number>();
  private readonly contentReadFailures = new Map<string, number>();
  private generation = 0;
  private disposed = false;
  private snapshotTimer: number | null = null;

  public constructor(
    private readonly app: App,
    private readonly getOptions: () => ReconciliationQueueOptions,
    private readonly callbacks: ReconciliationQueueCallbacks = {},
  ) {}

  public enqueue(file: TFile, triggerContext: RuleRunOn = "live"): void {
    if (this.disposed || !isMarkdownFile(file)) {
      return;
    }

    const path = normalizePath(file.path);
    const existingEntry = this.pendingFiles.get(path) ?? this.deferredFiles.get(path);
    this.deferredFiles.delete(path);
    const triggerContexts = existingEntry !== undefined
      ? mergeTriggerContexts(existingEntry.triggerContexts, triggerContext)
      : [triggerContext];
    this.enqueueWithTriggerContexts(path, file, triggerContexts);
  }

  /** Populate large queues in bounded chunks without monopolizing the UI thread. */
  public async enqueueMany(files: readonly TFile[], triggerContext: RuleRunOn): Promise<void> {
    for (let index = 0; index < files.length; index += 1) {
      if (this.disposed) return;
      this.enqueue(files[index], triggerContext);
      if ((index + 1) % 200 === 0 && index + 1 < files.length) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }

  public resumeDeferred(): void {
    if (this.disposed || this.getOptions().automationEnabled === false) {
      return;
    }
    for (const [path, entry] of [...this.deferredFiles]) {
      if (this.shouldDeferActiveFileWrite(entry.file, entry.triggerContexts)) {
        continue;
      }
      this.deferredFiles.delete(path);
      this.enqueueWithTriggerContexts(path, entry.file, entry.triggerContexts);
    }
    this.notifySnapshotChanged();
  }

  public cancel(path: string): void {
    const normalizedPath = normalizePath(path);
    const prefix = `${normalizedPath}/`;
    let changed = false;

    for (const [queuedPath, timer] of this.timers) {
      if (queuedPath === normalizedPath || queuedPath.startsWith(prefix)) {
        window.clearTimeout(timer);
        this.timers.delete(queuedPath);
        changed = true;
      }
    }

    for (const queuedPath of [...this.pendingFiles.keys(), ...this.deferredFiles.keys(), ...this.readyPaths]) {
      if (queuedPath === normalizedPath || queuedPath.startsWith(prefix)) {
        this.pendingFiles.delete(queuedPath);
        this.deferredFiles.delete(queuedPath);
        this.readyPaths.delete(queuedPath);
        changed = true;
      }
    }

    for (const runningPath of this.runningPaths) {
      if (runningPath === normalizedPath || runningPath.startsWith(prefix)) {
        if (!this.isExpectedRenamePath(runningPath)) {
          this.cancellationVersions.set(runningPath, this.cancellationVersionForPath(runningPath) + 1);
        }
        changed = true;
      }
    }

    for (const failedPath of this.contentReadFailures.keys()) {
      if (failedPath === normalizedPath || failedPath.startsWith(prefix)) {
        this.contentReadFailures.delete(failedPath);
      }
    }

    if (changed) {
      this.notifySnapshotChanged();
    }
  }

  public clear(): void {
    this.disposed = true;
    if (this.snapshotTimer !== null) window.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    for (const timer of this.timers.values()) {
      window.clearTimeout(timer);
    }
    this.generation += 1;
    this.timers.clear();
    this.pendingFiles.clear();
    this.deferredFiles.clear();
    this.readyPaths.clear();
    this.runningPaths.clear();
    this.contentReadFailures.clear();
    this.notifySnapshotChanged();
  }

  public snapshot(): ReconciliationQueueSnapshot {
    return {
      // Entries are moved between these maps, never duplicated in both.
      pendingCount: this.pendingFiles.size + this.deferredFiles.size,
      runningCount: this.runningPaths.size,
    };
  }

  private markReady(path: string): void {
    if (this.disposed || !this.pendingFiles.has(path)) {
      return;
    }
    this.readyPaths.add(path);
    this.pump();
  }

  private pump(): void {
    if (this.disposed) {
      return;
    }
    const maxConcurrent = Math.max(1, this.getOptions().maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    while (this.runningPaths.size < maxConcurrent) {
      let path: string | undefined;
      for (const candidate of this.readyPaths) {
        if (!this.runningPaths.has(candidate)) { path = candidate; break; }
      }
      if (path === undefined) {
        break;
      }
      this.readyPaths.delete(path);
      void this.flush(path);
    }
  }

  private async flush(path: string): Promise<void> {
    const generation = this.generation;
    const cancellationVersion = this.cancellationVersionForPath(path);
    const entry = this.pendingFiles.get(path);
    if (entry === undefined || this.disposed) {
      return;
    }

    this.pendingFiles.delete(path);
    this.runningPaths.add(path);
    this.notifySnapshotChanged();

    try {
      const revision = this.getOptions().revision ?? 0;
      const completion = await this.reconcile(path, entry.file, entry.triggerContexts, generation, cancellationVersion);
      if (completion === "reconciled") this.contentReadFailures.delete(path);
      if (completion === "reconciled" && !this.isStale(path, generation, cancellationVersion)) {
        await this.callbacks.onReconciled?.(entry.file, { triggerContexts: entry.triggerContexts, revision });
      }
    } catch (error) {
      if (!this.isStale(path, generation, cancellationVersion)) {
        const message = formatError(error);
        await this.recordDecision({
          timestamp: this.now(),
          path: entry.file.path,
          outcome: "error",
          appliedRuleIds: [],
          involvedRuleIds: [],
          mutationKinds: [],
          iterations: 0,
          message,
        });
        new Notice(`Vault Flow failed to reconcile ${entry.file.path}: ${message}`);
      }
    } finally {
      this.runningPaths.delete(path);
      this.notifySnapshotChanged();
      this.pump();
    }
  }

  private cancellationVersionForPath(path: string): number {
    return this.cancellationVersions.get(path) ?? 0;
  }

  private isStale(path: string, generation: number, cancellationVersion: number): boolean {
    return this.disposed || generation !== this.generation || cancellationVersion !== this.cancellationVersionForPath(path);
  }

  private optionsAreStale(
    path: string,
    generation: number,
    cancellationVersion: number,
    options: ReconciliationQueueOptions,
  ): boolean {
    const latestOptions = this.getOptions();
    return this.isStale(path, generation, cancellationVersion)
      || latestOptions.automationEnabled === false
      || (latestOptions.revision ?? 0) !== (options.revision ?? 0);
  }

  private isExpectedRenamePath(path: string): boolean {
    return (this.expectedRenamePaths.get(path) ?? 0) > 0;
  }

  private beginExpectedRename(path: string): void {
    this.expectedRenamePaths.set(path, (this.expectedRenamePaths.get(path) ?? 0) + 1);
  }

  private endExpectedRename(path: string): void {
    const count = this.expectedRenamePaths.get(path) ?? 0;
    if (count <= 1) {
      this.expectedRenamePaths.delete(path);
      return;
    }

    this.expectedRenamePaths.set(path, count - 1);
  }

  private async reconcile(
    path: string,
    file: TFile,
    triggerContexts: readonly RuleRunOn[],
    generation: number,
    cancellationVersion: number,
  ): Promise<ReconciliationCompletion> {
    if (!isMarkdownFile(file) || this.isStale(path, generation, cancellationVersion)) {
      return "deferred";
    }

    const options = this.getOptions();
    if (options.automationEnabled === false) {
      this.defer(path, file, triggerContexts);
      return "deferred";
    }
    const planningSettings = normalizePlanningSettings(options);
    const plan = await planFileReconciliation(this.app, file, planningSettings, triggerContexts, this.now());
    if (this.isStale(path, generation, cancellationVersion)) {
      return "deferred";
    }
    if ((this.getOptions().revision ?? 0) !== (options.revision ?? 0)) {
      this.requeue(path, file, triggerContexts);
      return "deferred";
    }

    if (plan.status === "excluded") {
      await this.recordDecision({
        timestamp: this.now(),
        path,
        outcome: "skipped",
        appliedRuleIds: [],
        involvedRuleIds: [],
        mutationKinds: [],
        iterations: 0,
        message: plan.eligibility.message,
      });
      return "reconciled";
    }

    if (plan.status === "metadata-unavailable" || plan.status === "content-read-failed") {
      const failureCount = this.incrementContentReadFailure(path);
      const retryLimitReached = failureCount >= MAX_CONTENT_READ_FAILURES;
      const failureLabel = plan.status === "metadata-unavailable" ? "Metadata" : "Content read";
      await this.recordDecision({
        timestamp: this.now(),
        path,
        outcome: retryLimitReached ? "error" : "skipped",
        appliedRuleIds: [],
        involvedRuleIds: [],
        mutationKinds: [],
        iterations: 0,
        message: retryLimitReached
          ? `${failureLabel} failed ${failureCount} times; reconciliation stopped: ${plan.message}`
          : `${failureLabel} failed; reconciliation was requeued: ${plan.message}`,
      });
      if (retryLimitReached) {
        this.contentReadFailures.delete(path);
        return "failed";
      }
      this.requeue(path, file, triggerContexts, this.readRetryDelay(failureCount));
      return "deferred";
    }

    // Keep failures through planning: the pre-apply read may still fail.
    return this.applyResult(
      file,
      plan.current,
      plan.result,
      triggerContexts,
      generation,
      cancellationVersion,
      plan.needsBodyContent,
      options,
    );
  }

  private async applyResult(
    file: TFile,
    current: NoteState,
    result: ReconciliationResult,
    triggerContexts: readonly RuleRunOn[],
    generation: number,
    cancellationVersion: number,
    needsBodyContent: boolean,
    options: ReconciliationQueueOptions,
  ): Promise<ReconciliationCompletion> {
    const path = normalizePath(current.path);
    if (this.isStale(path, generation, cancellationVersion)) {
      return "deferred";
    }

    if (result.status !== "converged") {
      const cycleDetected = result.status === "cycle-detected";
      const outcome = cycleDetected ? "cycle-detected" : "max-iterations-exceeded";
      const message = cycleDetected
        ? `Cycle detected among rules: ${result.involvedRuleIds.join(", ")}`
        : `Reconciliation exceeded ${result.iterations} iteration(s). Involved rules: ${result.involvedRuleIds.join(", ")}`;
      await this.recordDecision({
        timestamp: this.now(),
        path: current.path,
        outcome,
        appliedRuleIds: [],
        involvedRuleIds: result.involvedRuleIds,
        mutationKinds: [],
        iterations: result.iterations,
        message,
      });
      new Notice(`Vault Flow could not reconcile ${file.path}: ${message}`);
      return "reconciled";
    }

    const dryRunMatches = result.dryRunMatches ?? [];
    const dryRunMutationKinds = uniqueMutationKinds(dryRunMatches.flatMap((match) => match.mutations.map((mutation) => mutation.kind)));
    if (!result.changed) {
      if (dryRunMatches.length > 0) {
        await this.recordDecision({
          timestamp: this.now(),
          path: current.path,
          outcome: "dry-run",
          appliedRuleIds: [...result.dryRunRuleIds],
          involvedRuleIds: [],
          mutationKinds: dryRunMutationKinds,
          iterations: result.iterations,
          desiredPath: singleDryRunDesiredPath(dryRunMatches, current.path),
          dryRunRuleIds: [...result.dryRunRuleIds],
          message: "Matching per-rule dry-run actions were planned but not written.",
        });
      } else {
        await this.recordDecision({
          timestamp: this.now(),
          path: current.path,
          outcome: "unchanged",
          appliedRuleIds: result.appliedRuleIds,
          involvedRuleIds: [],
          mutationKinds: [],
          iterations: result.iterations,
          desiredPath: result.desired.path,
        });
      }
      return "reconciled";
    }

    const mutationKinds = result.mutations.map((mutation) => mutation.kind);
    try {
      validateReconciliationResult(this.app, file, result);
    } catch (error) {
      const message = formatError(error);
      await this.recordDecision({
        timestamp: this.now(),
        path: current.path,
        outcome: "error",
        appliedRuleIds: result.appliedRuleIds,
        involvedRuleIds: [],
        mutationKinds,
        iterations: result.iterations,
        desiredPath: result.desired.path,
        message,
      });
      new Notice(`Vault Flow could not reconcile ${file.path}: ${message}`);
      return "reconciled";
    }

    if (options.dryRun) {
      await this.recordDecision({
        timestamp: this.now(),
        path: current.path,
        outcome: "dry-run",
        appliedRuleIds: [...result.appliedRuleIds, ...result.dryRunRuleIds],
        involvedRuleIds: [],
        mutationKinds: uniqueMutationKinds([...mutationKinds, ...dryRunMutationKinds]),
        iterations: result.iterations,
        desiredPath: result.desired.path,
        dryRunRuleIds: [...result.dryRunRuleIds],
        message: "Dry-run mode is enabled; no vault changes were written.",
      });
      return "reconciled";
    }

    if (this.shouldDeferActiveFileWrite(file, triggerContexts)) {
      await this.recordDecision({
        timestamp: this.now(),
        path: current.path,
        outcome: "skipped",
        appliedRuleIds: result.appliedRuleIds,
        involvedRuleIds: [],
        mutationKinds,
        iterations: result.iterations,
        desiredPath: result.desired.path,
        message: "Live write deferred because the note is currently active. Try again after switching notes or saving changes.",
      });
      this.defer(path, file, triggerContexts);
      return "deferred";
    }

    const runExclusive = this.callbacks.runExclusive ?? (async <T>(operation: () => Promise<T>): Promise<T> => operation());
    const execution = await runExclusive(async () => {
      if (this.optionsAreStale(path, generation, cancellationVersion, options)) {
        return { status: "stale" } as const;
      }

      const eligibility = evaluateFileEligibility(file, this.app.metadataCache.getFileCache(file), normalizePlanningSettings(options));
      if (!eligibility.eligible) {
        return { status: "excluded", message: eligibility.message } as const;
      }

      const latestCurrent = await currentStateForApply(this.app, file, needsBodyContent);
      if (latestCurrent.status === "failed") {
        return { status: "read-failed", message: latestCurrent.message } as const;
      }
      if (this.optionsAreStale(path, generation, cancellationVersion, options)) {
        return { status: "stale" } as const;
      }
      if (!sameNoteStateBaseline(current, latestCurrent.current)) {
        return { status: "changed" } as const;
      }

      const collisionCheckedResult = await this.resolvePathCollision(
        file,
        latestCurrent.current,
        result,
        mutationKinds,
        options.collisionPolicy,
      );
      if (collisionCheckedResult === null) {
        return { status: "collision-skipped" } as const;
      }

      const pathChanges = mutationKinds.includes("move") || mutationKinds.includes("rename");
      const expectsRename = pathChanges && normalizePath(file.path) !== normalizePath(collisionCheckedResult.result.desired.path);
      if (expectsRename) {
        this.beginExpectedRename(path);
      }
      try {
        const transaction = await applyReconciliationResult(this.app, file, latestCurrent.current, collisionCheckedResult.result, () => {
          if (this.optionsAreStale(path, generation, cancellationVersion, options)) {
            throw new TransactionInterruptedError("stale");
          }
          if (this.shouldDeferActiveFileWrite(file, triggerContexts)) {
            throw new TransactionInterruptedError("active");
          }
          const baseline = noteStateFromObsidian(file, this.app.metadataCache.getFileCache(file), {
            bodyContent: latestCurrent.current.bodyContent,
          });
          if (!sameNoteStateBaseline(latestCurrent.current, baseline)) {
            throw new TransactionInterruptedError("changed");
          }
        }, (pending) => this.callbacks.onMutationStarted?.(pending), (transaction) => this.callbacks.onMutationFinished?.(transaction));
        return {
          status: "applied",
          current: latestCurrent.current,
          result: collisionCheckedResult.result,
          transaction,
          message: collisionCheckedResult.message,
        } as const;
      } catch (error) {
        if (error instanceof TransactionInterruptedError) {
          if (error.reason === "active") return { status: "active" } as const;
          if (error.reason === "changed") return { status: "changed" } as const;
          return { status: "stale" } as const;
        }
        throw error;
      } finally {
        if (expectsRename) {
          this.endExpectedRename(path);
        }
      }
    });

    if (execution.status === "stale") {
      if (!this.isStale(path, generation, cancellationVersion)) this.requeue(path, file, triggerContexts);
      return "deferred";
    }
    if (execution.status === "active") {
      this.defer(path, file, triggerContexts);
      return "deferred";
    }
    if (execution.status === "excluded") {
      await this.recordDecision({
        timestamp: this.now(),
        path: current.path,
        outcome: "skipped",
        appliedRuleIds: result.appliedRuleIds,
        involvedRuleIds: [],
        mutationKinds,
        iterations: result.iterations,
        desiredPath: result.desired.path,
        message: execution.message,
      });
      return "reconciled";
    }
    if (execution.status === "collision-skipped") {
      return "reconciled";
    }
    if (execution.status === "read-failed") {
      const failureCount = this.incrementContentReadFailure(path);
      const retryLimitReached = failureCount >= MAX_CONTENT_READ_FAILURES;
      await this.recordDecision({
        timestamp: this.now(),
        path: current.path,
        outcome: retryLimitReached ? "error" : "skipped",
        appliedRuleIds: result.appliedRuleIds,
        involvedRuleIds: [],
        mutationKinds,
        iterations: result.iterations,
        desiredPath: result.desired.path,
        message: retryLimitReached
          ? `Content read failed ${failureCount} times before apply; reconciliation stopped: ${execution.message}`
          : `Content read failed before apply; reconciliation was requeued: ${execution.message}`,
      });
      if (retryLimitReached) {
        this.contentReadFailures.delete(path);
        return "failed";
      }
      this.requeue(path, file, triggerContexts, this.readRetryDelay(failureCount));
      return "deferred";
    }
    if (execution.status === "changed") {
      await this.recordDecision({
        timestamp: this.now(),
        path: current.path,
        outcome: "skipped",
        appliedRuleIds: result.appliedRuleIds,
        involvedRuleIds: [],
        mutationKinds,
        iterations: result.iterations,
        desiredPath: result.desired.path,
        message: "Write skipped because the note changed after reconciliation was planned; it was requeued.",
      });
      this.requeue(path, file, triggerContexts);
      return "deferred";
    }

    this.contentReadFailures.delete(path);
    const timestamp = this.now();
    await this.recordDecision({
      timestamp,
      path: execution.transaction.beforePath,
      outcome: "changed",
      appliedRuleIds: result.appliedRuleIds,
      involvedRuleIds: [],
      mutationKinds,
      iterations: result.iterations,
      desiredPath: execution.transaction.afterPath,
      transactionId: execution.transaction.transactionId ?? createTransactionId(timestamp, execution.transaction.beforePath),
      ...(execution.transaction.afterIdentity === undefined ? {} : { afterIdentity: execution.transaction.afterIdentity }),
      ...(execution.transaction.beforeFrontmatter === undefined ? {} : { beforeFrontmatter: execution.transaction.beforeFrontmatter }),
      ...(execution.transaction.afterFrontmatter === undefined ? {} : { afterFrontmatter: execution.transaction.afterFrontmatter }),
      ...(result.dryRunRuleIds.length === 0 ? {} : { dryRunRuleIds: [...result.dryRunRuleIds] }),
      ...(execution.message === undefined ? {} : { message: execution.message }),
    });
    return "reconciled";
  }

  private requeue(path: string, file: TFile, triggerContexts: readonly RuleRunOn[], delayMs?: number): void {
    if (this.disposed) {
      return;
    }
    const existingEntry = this.pendingFiles.get(path) ?? this.deferredFiles.get(path);
    this.deferredFiles.delete(path);
    const mergedTriggerContexts = existingEntry === undefined
      ? triggerContexts
      : mergeTriggerContextLists(existingEntry.triggerContexts, triggerContexts);
    this.enqueueWithTriggerContexts(path, existingEntry?.file ?? file, mergedTriggerContexts, delayMs);
  }

  private defer(path: string, file: TFile, triggerContexts: readonly RuleRunOn[]): void {
    if (this.disposed) {
      return;
    }
    const existingEntry = this.deferredFiles.get(path) ?? this.pendingFiles.get(path);
    const mergedTriggerContexts = existingEntry === undefined
      ? triggerContexts
      : mergeTriggerContextLists(existingEntry.triggerContexts, triggerContexts);
    this.pendingFiles.delete(path);
    this.readyPaths.delete(path);
    this.deferredFiles.set(path, { file: existingEntry?.file ?? file, triggerContexts: mergedTriggerContexts });
    this.notifySnapshotChanged();
  }

  private shouldDeferActiveFileWrite(file: TFile, triggerContexts: readonly RuleRunOn[]): boolean {
    if (!triggerContexts.includes("live") || triggerContexts.includes("manual")) {
      return false;
    }

    return this.callbacks.shouldDeferLiveWrite?.(file) === true;
  }

  private enqueueWithTriggerContexts(path: string, file: TFile, triggerContexts: readonly RuleRunOn[], delayMs?: number): void {
    if (this.disposed) {
      return;
    }
    const existingTimer = this.timers.get(path);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    this.pendingFiles.set(path, { file, triggerContexts });
    const debounceMs = this.getOptions().debounceMs;
    const timer = window.setTimeout(() => {
      this.timers.delete(path);
      this.markReady(path);
    }, delayMs ?? debounceMs);
    this.timers.set(path, timer);
    this.notifySnapshotChanged();
  }

  private async resolvePathCollision(
    file: TFile,
    current: NoteState,
    result: ReconciliationConverged,
    mutationKinds: readonly ReconciliationDecision["mutationKinds"][number][],
    collisionPolicy: CollisionPolicy,
  ): Promise<{ readonly result: ReconciliationConverged; readonly message?: string } | null> {
    const pathChanges = mutationKinds.includes("move") || mutationKinds.includes("rename");
    if (!pathChanges || normalizePath(current.path) === normalizePath(result.desired.path)) {
      return { result };
    }

    const resolution = resolveMoveCollision(this.app, file, result.desired.path, collisionPolicy);
    if (resolution.status === "skipped") {
      await this.recordDecision({
        timestamp: this.now(),
        path: current.path,
        outcome: "skipped",
        appliedRuleIds: result.appliedRuleIds,
        involvedRuleIds: [],
        mutationKinds,
        iterations: result.iterations,
        desiredPath: resolution.path,
        message: resolution.message,
      });
      return null;
    }

    if (resolution.path === normalizePath(result.desired.path)) {
      return { result };
    }

    return {
      result: {
        ...result,
        desired: withNoteStatePath(result.desired, resolution.path),
      },
      message: `Destination already existed; using available path: ${resolution.path}`,
    };
  }

  private async recordDecision(decision: ReconciliationDecision): Promise<void> {
    await this.callbacks.recordDecision?.(decision);
  }

  private notifySnapshotChanged(): void {
    if (this.callbacks.onSnapshotChange === undefined) return;
    if (this.disposed) {
      this.callbacks.onSnapshotChange(this.snapshot());
      return;
    }
    if (this.snapshotTimer !== null) return;
    this.snapshotTimer = window.setTimeout(() => {
      this.snapshotTimer = null;
      this.callbacks.onSnapshotChange?.(this.snapshot());
    }, 16);
  }

  private now(): number {
    return this.callbacks.now?.() ?? Date.now();
  }

  private readRetryDelay(failureCount: number): number {
    return Math.min(30_000, Math.max(1, this.getOptions().debounceMs) * 2 ** (failureCount - 1));
  }

  private incrementContentReadFailure(path: string): number {
    const next = (this.contentReadFailures.get(path) ?? 0) + 1;
    this.contentReadFailures.set(path, next);
    return next;
  }
}

type CurrentStateForApplyResult =
  | { readonly status: "ready"; readonly current: NoteState }
  | { readonly status: "failed"; readonly message: string };

async function currentStateForApply(app: App, file: TFile, needsBodyContent: boolean): Promise<CurrentStateForApplyResult> {
  if (!needsBodyContent) {
    return { status: "ready", current: noteStateFromObsidian(file, app.metadataCache.getFileCache(file)) };
  }

  try {
    const completeContent = await app.vault.cachedRead(file);
    return {
      status: "ready",
      current: noteStateFromObsidian(file, app.metadataCache.getFileCache(file), { bodyContent: markdownBodyContent(completeContent) }),
    };
  } catch (error) {
    return { status: "failed", message: formatError(error) };
  }
}

function normalizePlanningSettings(options: ReconciliationQueueOptions): FilePlanningSettings {
  return {
    maxIterations: options.maxIterations,
    rules: options.rules,
    monitoredFolders: options.monitoredFolders ?? [],
    exclusionPatterns: options.exclusionPatterns ?? [],
    disableFrontmatterKey: options.disableFrontmatterKey ?? "vault-flow-disable",
  };
}

function uniqueMutationKinds(kinds: readonly PlannedMutation["kind"][]): PlannedMutation["kind"][] {
  return [...new Set(kinds)];
}

function singleDryRunDesiredPath(matches: readonly DryRunRuleMatch[], fallbackPath: string): string {
  const paths = [...new Set(matches.map((match) => match.desired.path))];
  return paths.length === 1 ? paths[0] ?? fallbackPath : fallbackPath;
}

function mergeTriggerContexts(existing: readonly RuleRunOn[], incoming: RuleRunOn): readonly RuleRunOn[] {
  if (existing.includes(incoming)) {
    return existing;
  }

  return [...existing, incoming];
}

function mergeTriggerContextLists(existing: readonly RuleRunOn[], incoming: readonly RuleRunOn[]): readonly RuleRunOn[] {
  let merged = existing;
  for (const triggerContext of incoming) {
    merged = mergeTriggerContexts(merged, triggerContext);
  }

  return merged;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
