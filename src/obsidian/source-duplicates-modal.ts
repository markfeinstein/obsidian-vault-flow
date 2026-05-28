import { Modal, type App } from "obsidian";
import type { DuplicateSourceUrlGroup } from "./source-duplicates";

export class SourceDuplicatesModal extends Modal {
  public constructor(
    app: App,
    private readonly groups: readonly DuplicateSourceUrlGroup[],
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Duplicate source URLs");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `Found ${this.groups.length} duplicate source URL group(s).`,
    });

    const groupList = this.contentEl.createEl("ol", { cls: "vf-source-duplicates" });
    for (const group of this.groups) {
      const groupItem = groupList.createEl("li", { cls: "vf-source-duplicate-group" });
      groupItem.createEl("code", { text: group.url });

      const occurrenceList = groupItem.createEl("ul", { cls: "vf-source-duplicate-occurrences" });
      for (const occurrence of group.occurrences) {
        occurrenceList.createEl("li", {
          text: `${occurrence.path} (${occurrence.property})`,
        });
      }
    }
  }
}
