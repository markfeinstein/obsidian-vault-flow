import { ConfirmationModal, Modal, Notice, type App, type TFile } from "obsidian";
import type { NoteState, ReconciliationConverged } from "../engine";
import { applyReconciliationResult, noteStateFromObsidian, resolveMoveCollision } from "./adapter";
import { createTransactionId, type ReconciliationDecision } from "./diagnostics";
import type { DryRunPreviewPlan } from "./dry-run-preview";
import { sameNoteStateBaseline, withNoteStatePath } from "./note-state";
import { markdownBodyContent } from "./planner";
import { renderFrontmatterDiff } from "./frontmatter-diff";
import type { CollisionPolicy } from "./settings";
import { MAX_BATCH_RECEIPT_ROWS, type BatchReceipt, type BatchRowReceipt } from "./batch-history";
import { WriteSafetyError } from "./write-safety";
import { bodyFingerprint } from "./preview-snapshot";

class ApplyCancelledError extends Error {}
class ApplyStoppedError extends Error {}

export interface VaultPreviewEntry {
  readonly path: string;
  readonly desiredPath?: string;
  readonly propertyChangeCount: number;
  readonly preview: DryRunPreviewPlan;
  readonly selected?: boolean;
}

export interface VaultPreviewApplyCallbacks {
  readonly collisionPolicy?: () => CollisionPolicy;
  readonly recordDecision?: (decision: ReconciliationDecision) => void | Promise<void>;
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly preflightApply?: () => void;
  readonly assertCanApply?: () => void;
  readonly now?: () => number;
  readonly maxBatchWrites?: () => number;
  readonly onMutationStarted?: () => void;
  readonly recordBatch?: (receipt: BatchReceipt) => void | Promise<void>;
}

const PREVIEW_PAGE_SIZE = 100;

export class VaultPreviewModal extends Modal {
  private readonly pending: readonly VaultPreviewEntry[];
  private readonly selected = new Set<VaultPreviewEntry>();
  private currentPage = 0;
  private applying = false;
  private batchStarted = false;
  private entryStarted = false;
  private cancelRequested = false;
  private closed = false;
  private activeBatchId: string | null = null;
  private progressEl: HTMLElement | null = null;
  private lastRow: Partial<BatchRowReceipt> = {};

  public constructor(
    app: App,
    entries: readonly VaultPreviewEntry[],
    private readonly callbacks: VaultPreviewApplyCallbacks = {},
  ) {
    super(app);
    this.pending = entries.filter((entry) => !["unchanged", "excluded"].includes(entry.preview.preview.outcome));
    for (const entry of this.pending) {
      if (entry.selected === true && isApplyableEntry(entry)) this.selected.add(entry);
    }
  }

  override onOpen(): void {
    this.closed = false;
    this.setTitle("Vault Flow — vault-wide preview");
    this.render();
  }

  override onClose(): void {
    this.closed = true;
    if (this.applying || this.activeBatchId !== null) this.cancelRequested = true;
    this.progressEl = null;
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();

    if (this.pending.length === 0) {
      this.contentEl.createEl("p", { text: "No pending changes found." });
      return;
    }

    const pageCount = Math.ceil(this.pending.length / PREVIEW_PAGE_SIZE);
    const pagination = this.contentEl.createDiv({ cls: "vf-preview-pagination" });
    const previous = pagination.createEl("button", { text: "Previous" });
    previous.disabled = this.applying || this.currentPage === 0;
    previous.addEventListener("click", () => {
      this.currentPage -= 1;
      this.render();
    });
    pagination.createSpan({ text: `Page ${this.currentPage + 1} of ${pageCount}`, attr: { "aria-live": "polite" } });
    const next = pagination.createEl("button", { text: "Next" });
    next.disabled = this.applying || this.currentPage === pageCount - 1;
    next.addEventListener("click", () => {
      this.currentPage += 1;
      this.render();
    });

    const footer = this.contentEl.createDiv({ cls: "vf-preview-footer" });
    const summary = footer.createSpan({ cls: "vf-preview-summary", attr: { "aria-live": "polite" } });
    const applyBtn = footer.createEl("button", { text: this.applying ? "Applying…" : "Apply selected", cls: "mod-cta" });
    const updateSelection = (): void => {
      summary.setText(`${this.selected.size} selected of ${this.pending.length} pending changes (all pages)`);
      applyBtn.disabled = this.applying || this.selected.size === 0;
    };
    updateSelection();
    this.progressEl = footer.createSpan({ attr: { role: "status", "aria-live": "polite" } });
    if (this.applying) {
      const cancel = footer.createEl("button", { text: "Cancel remaining" });
      cancel.onclick = () => {
        this.cancelRequested = true;
        cancel.disabled = true;
        cancel.setText("Stopping after current transaction…");
      };
    }

    const scrollWrap = this.contentEl.createDiv({ cls: "vf-preview-scroll" });
    const table = scrollWrap.createEl("table", { cls: "vf-preview-table" });

    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    for (const col of ["Apply", "Status", "File", "New path", "Property changes"]) {
      headerRow.createEl("th", { text: col, cls: "vf-preview-header-cell", attr: { scope: "col" } });
    }

    const tbody = table.createEl("tbody");
    const start = this.currentPage * PREVIEW_PAGE_SIZE;
    for (const entry of this.pending.slice(start, start + PREVIEW_PAGE_SIZE)) {
      const tr = tbody.createEl("tr");

      const tdSelect = tr.createEl("td", { cls: "vf-preview-cell" });
      const checkbox = tdSelect.createEl("input", {
        type: "checkbox",
        attr: { "aria-label": `Apply planned change for ${entry.path}` },
      });
      checkbox.checked = this.selected.has(entry);
      checkbox.disabled = this.applying || !isApplyableEntry(entry);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(entry);
        else this.selected.delete(entry);
        updateSelection();
      });

      tr.createEl("td", { text: entry.preview.preview.outcome, cls: "vf-preview-cell vf-preview-status" });
      tr.createEl("td", { text: entry.path, cls: "vf-preview-cell vf-preview-path" });

      const tdNew = tr.createEl("td", { cls: "vf-preview-cell vf-preview-path" });
      if (entry.desiredPath !== undefined && entry.desiredPath !== entry.path) {
        tdNew.setText(entry.desiredPath);
      } else {
        tdNew.setText("—");
        tdNew.addClass("vf-muted");
      }

      const tdProps = tr.createEl("td", { cls: "vf-preview-cell vf-preview-count" });
      if (entry.propertyChangeCount > 0) {
        tdProps.setText(String(entry.propertyChangeCount));
        if (entry.preview.result !== null) renderFrontmatterDiff(tdProps, entry.preview.current, entry.preview.result.desired);
      } else {
        tdProps.setText("—");
        tdProps.addClass("vf-muted");
      }
      if (entry.preview.preview.outcome === "error" || entry.preview.preview.outcome === "skipped") {
        tdProps.createDiv({ text: entry.preview.preview.message });
      }
    }

    applyBtn.onclick = async () => {
      if (this.applying || this.selected.size === 0) return;
      const selectedEntries = this.pending.filter((entry) => this.selected.has(entry));
      this.applying = true;
      this.cancelRequested = false;
      this.render();
      let finished = false;
      try {
        if (!(await confirmPreviewApply(this.app, selectedEntries.length))) return;
        await this.applySelected(selectedEntries);
        finished = true;
        this.close();
      } catch (error) {
        new Notice(`Vault Flow preview apply failed: ${formatError(error)}`);
      } finally {
        this.applying = false;
        if (!finished && !this.closed) this.render();
      }
    };
  }

  private async applySelected(entries: readonly VaultPreviewEntry[]): Promise<void> {
    if (entries.length === 0) {
      new Notice("Vault Flow has no selected preview rows to apply.");
      return;
    }

    this.batchStarted = false;
    const limit = this.callbacks.maxBatchWrites?.() ?? 100;
    if (entries.length > limit) throw new Error(`Select at most ${limit} rows per batch, or explicitly raise Maximum batch writes in settings.`);
    this.callbacks.preflightApply?.();

    if (this.activeBatchId !== null) throw new Error("A batch is already applying in this preview.");
    const startedAt = this.now();
    const batchId = createTransactionId(startedAt, "apply-batch");
    this.activeBatchId = batchId;
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    let stopped = false;
    const rows: BatchRowReceipt[] = [];
    try {
      for (const entry of entries) {
        if (this.cancelRequested) break;
        this.entryStarted = false;
        this.lastRow = {};
        let outcome: BatchRowReceipt["outcome"];
        try {
          outcome = await this.runExclusive(async () => this.applyEntry(entry));
        } catch (error) {
          if (error instanceof ApplyCancelledError) break;
          outcome = "failed";
          stopped = error instanceof WriteSafetyError || error instanceof ApplyStoppedError;
          await this.recordError(entry, `Preview apply failed: ${formatError(error)}`);
        }
        if (outcome === "applied") applied += 1;
        else if (outcome === "skipped") skipped += 1;
        else failed += 1;
        if (rows.length < MAX_BATCH_RECEIPT_ROWS) rows.push({ ...this.lastRow, path: entry.path, outcome });
        const completed = applied + skipped + failed;
        this.progressEl?.setText(`${applied} applied, ${skipped} skipped, ${failed} failed; ${entries.length - completed} remaining`);
        if (stopped) break;
        if (completed % 25 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    } finally {
      this.activeBatchId = null;
      const completed = applied + skipped + failed;
      const receipt: BatchReceipt = { batchId, startedAt, finishedAt: this.now(), total: entries.length,
        applied, skipped, failed, unprocessed: entries.length - completed, rows, truncated: completed > rows.length,
        status: this.cancelRequested ? "cancelled" : stopped ? "stopped" : "completed" };
      try { await this.callbacks.recordBatch?.(receipt); }
      catch { new Notice("Vault Flow could not retain this batch receipt. Review diagnostics before retrying."); }
      new Notice(`Vault Flow batch ${receipt.status}: ${applied} applied, ${skipped} skipped, ${failed} failed, ${receipt.unprocessed} unprocessed.`);
    }
  }

  private assertCanStart(): void {
    if (this.cancelRequested && !this.entryStarted) throw new ApplyCancelledError("Apply cancelled before note mutation.");
    try {
      this.callbacks.assertCanApply?.();
      // Ignore only query updates caused after our first note mutation.
      if (!this.batchStarted) this.callbacks.preflightApply?.();
    } catch (error) {
      throw new ApplyStoppedError(formatError(error));
    }
  }

  private async applyEntry(entry: VaultPreviewEntry): Promise<"applied" | "skipped" | "failed"> {
    this.assertCanStart();
    if (entry.preview.result === null) {
      await this.recordSkipped(entry, "Preview skipped because it has no applyable reconciliation result.");
      return "skipped";
    }

    const file = this.app.vault.getFileByPath(entry.preview.current.path);
    if (file === null) {
      await this.recordSkipped(entry, "Preview skipped because the note could not be found at its previewed path.");
      return "skipped";
    }

    const currentState = await currentStateForPreviewApply(this.app, file, entry.preview.current, entry.preview.needsBodyContent);
    if (currentState.status === "failed") {
      await this.recordError(entry, `Preview content read failed: ${currentState.message}`);
      return "failed";
    }

    const current = currentState.current;
    if (!sameNoteStateBaseline(entry.preview.current, current)) {
      await this.recordSkipped(entry, "Preview skipped because the note changed since the preview was generated.");
      return "skipped";
    }

    const pathResolution = this.resolveCurrentPathCollision(file, entry, current);
    if (pathResolution.status === "skipped") {
      await this.recordSkipped(entry, pathResolution.message);
      return "skipped";
    }

    this.assertCanStart();
    const transaction = await applyReconciliationResult(this.app, file, current, pathResolution.result, () => {
      this.assertCanStart();
      const baseline = { ...noteStateFromObsidian(file, this.app.metadataCache.getFileCache(file), { bodyContent: current.bodyContent }), bodyFingerprint: current.bodyFingerprint };
      if (!sameNoteStateBaseline(current, baseline)) {
        throw new Error("The note changed during transaction preparation. Generate a new preview.");
      }
    }, () => {
      this.callbacks.onMutationStarted?.();
      this.entryStarted = true;
      this.batchStarted = true;
    });
    await this.recordApplied(entry, transaction);
    return "applied";
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.callbacks.runExclusive?.(operation) ?? operation();
  }

  private async recordApplied(
    entry: VaultPreviewEntry,
    transaction: Awaited<ReturnType<typeof applyReconciliationResult>>,
  ): Promise<void> {
    if (entry.preview.result === null) {
      return;
    }

    const timestamp = this.now();
    const transactionId = createTransactionId(timestamp, transaction.beforePath);
    this.lastRow = { afterPath: transaction.afterPath, transactionId };
    await this.recordDecision({
      timestamp,
      path: transaction.beforePath,
      outcome: "changed",
      appliedRuleIds: entry.preview.result.appliedRuleIds,
      involvedRuleIds: [],
      mutationKinds: entry.preview.preview.mutationKinds,
      iterations: entry.preview.result.iterations,
      desiredPath: transaction.afterPath,
      transactionId,
      ...(this.activeBatchId === null ? {} : { batchId: this.activeBatchId }),
      ...(transaction.afterIdentity === undefined ? {} : { afterIdentity: transaction.afterIdentity }),
      ...(transaction.beforeFrontmatter === undefined ? {} : { beforeFrontmatter: transaction.beforeFrontmatter }),
      ...(transaction.afterFrontmatter === undefined ? {} : { afterFrontmatter: transaction.afterFrontmatter }),
    });
  }

  private async recordSkipped(entry: VaultPreviewEntry, message: string): Promise<void> {
    this.lastRow = { message };
    await this.recordDecision({
      timestamp: this.now(),
      path: entry.preview.current.path,
      outcome: "skipped",
      appliedRuleIds: entry.preview.result?.appliedRuleIds ?? entry.preview.preview.appliedRuleIds,
      involvedRuleIds: [],
      mutationKinds: entry.preview.preview.mutationKinds,
      iterations: entry.preview.result?.iterations ?? entry.preview.preview.iterations,
      desiredPath: entry.preview.result?.desired.path ?? entry.preview.preview.desiredPath,
      message,
    });
  }

  private async recordError(entry: VaultPreviewEntry, message: string): Promise<void> {
    this.lastRow = { message };
    await this.recordDecision({
      timestamp: this.now(),
      path: entry.preview.current.path,
      outcome: "error",
      appliedRuleIds: entry.preview.result?.appliedRuleIds ?? entry.preview.preview.appliedRuleIds,
      involvedRuleIds: [],
      mutationKinds: entry.preview.preview.mutationKinds,
      iterations: entry.preview.result?.iterations ?? entry.preview.preview.iterations,
      desiredPath: entry.preview.result?.desired.path ?? entry.preview.preview.desiredPath,
      message,
    });
  }

  private async recordDecision(decision: ReconciliationDecision): Promise<void> {
    try {
      await this.callbacks.recordDecision?.(decision);
    } catch {
      // Applying selected rows should not depend on diagnostics persistence.
    }
  }

  private now(): number {
    return this.callbacks.now?.() ?? Date.now();
  }

  private resolveCurrentPathCollision(
    file: TFile,
    entry: VaultPreviewEntry,
    current: NoteState,
  ): { readonly status: "ready"; readonly result: ReconciliationConverged } | { readonly status: "skipped"; readonly message: string } {
    if (entry.preview.result === null) {
      return { status: "skipped", message: "Preview skipped because it has no applyable reconciliation result." };
    }

    const result = entry.preview.result;
    const pathChanged = entry.preview.preview.mutationKinds.includes("move") || entry.preview.preview.mutationKinds.includes("rename");
    if (!pathChanged || current.path === result.desired.path) {
      return { status: "ready", result };
    }

    const resolution = resolveMoveCollision(
      this.app,
      file,
      entry.preview.collisionBasePath ?? result.desired.path,
      this.collisionPolicy(),
    );
    if (resolution.status === "skipped") {
      return { status: "skipped", message: resolution.message };
    }

    return {
      status: "ready",
      result: resolution.path === result.desired.path
        ? result
        : {
          ...result,
          desired: withNoteStatePath(result.desired, resolution.path),
        },
    };
  }

  private collisionPolicy(): CollisionPolicy {
    return this.callbacks.collisionPolicy?.() ?? "skip";
  }
}

function isApplyableEntry(entry: VaultPreviewEntry): boolean {
  return entry.preview.result !== null && entry.preview.preview.outcome === "changed";
}

type CurrentStateForPreviewApplyResult =
  | { readonly status: "ready"; readonly current: NoteState }
  | { readonly status: "failed"; readonly message: string };

async function currentStateForPreviewApply(
  app: App,
  file: TFile,
  previewed: NoteState,
  needsBodyContent: boolean,
): Promise<CurrentStateForPreviewApplyResult> {
  if (!needsBodyContent) {
    return { status: "ready", current: noteStateFromObsidian(file, app.metadataCache.getFileCache(file)) };
  }

  try {
    const completeContent = await app.vault.cachedRead(file);
    const body = markdownBodyContent(completeContent);
    const current = noteStateFromObsidian(file, app.metadataCache.getFileCache(file), { bodyContent: body });
    return {
      status: "ready",
      current: previewed.bodyFingerprint === undefined ? current : { ...current, bodyFingerprint: await bodyFingerprint(body) },
    };
  } catch (error) {
    return { status: "failed", message: formatError(error) };
  }
}

function confirmPreviewApply(app: App, count: number): Promise<boolean> {
  if (count === 0) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const modal = new ConfirmationModal(app);
    modal.setTitle("Apply previewed changes");
    modal.setContent(`Apply ${count} selected change${count === 1 ? "" : "s"}? This writes to the vault even when global dry-run mode is enabled.`);
    modal.addButton((button) => {
      button
        .setButtonText("Apply changes")
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
