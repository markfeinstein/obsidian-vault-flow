import { Modal, type App } from "obsidian";
import { formatDryRunPreviewLogEntry, type DryRunPreview, type DryRunPreviewPlan } from "./dry-run-preview";
import { renderFrontmatterDiff } from "./frontmatter-diff";

export class DryRunPreviewModal extends Modal {
  public constructor(
    app: App,
    private readonly preview: DryRunPreview,
    private readonly plan?: DryRunPreviewPlan,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Vault Flow dry-run preview");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();

    if (this.preview.outcome === "excluded") {
      const banner = this.contentEl.createDiv({ cls: "vf-preview-excluded" });
      banner.createEl("strong", { text: "This note is excluded from Vault Flow." });
      banner.createEl("p", { text: this.preview.message });
      banner.createEl("p", {
        text: "No rules will run on this note. Remove it from the exclusion list or unset the disable key to allow processing.",
        cls: "vf-muted",
      });
      return;
    }

    const entry = formatDryRunPreviewLogEntry(this.preview);
    this.contentEl.createEl("p", { text: entry.title });

    const details = this.contentEl.createDiv({ cls: "vf-dry-run-preview" });
    for (const detail of entry.details) {
      details.createDiv({ text: detail, cls: "vf-dry-run-preview-detail" });
    }

    if (this.plan?.result !== null && this.plan?.result !== undefined) {
      renderFrontmatterDiff(this.contentEl, this.plan.current, this.plan.result.desired);
    }

    this.contentEl.createEl("p", {
      text: "This preview used the current metadata cache, rules, max iterations, and collision policy. It did not enqueue the note, write frontmatter, create folders, move files, save settings, or update diagnostics.",
    });
  }
}
