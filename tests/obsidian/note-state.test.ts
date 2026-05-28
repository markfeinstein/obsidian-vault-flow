import { describe, expect, it } from "vitest";
import type { NoteState } from "../../src/engine";
import { countFrontmatterChanges, sameNoteStateBaseline, withNoteStatePath } from "../../src/obsidian/note-state";

function state(overrides: Partial<NoteState> = {}): NoteState {
  return {
    path: "Inbox/note.md",
    basename: "note",
    extension: "md",
    frontmatter: {},
    frontmatterKeys: [],
    tags: [],
    stat: { ctime: 1, mtime: 2 },
    ...overrides,
  };
}

describe("note state safety helpers", () => {
  it("does not report reordered shallow-object keys as property changes", () => {
    const current = state({ frontmatter: { metadata: { alpha: 1, beta: 2 } }, frontmatterKeys: ["metadata"] });
    const desired = state({ frontmatter: { metadata: { beta: 2, alpha: 1 } }, frontmatterKeys: ["metadata"] });

    expect(countFrontmatterChanges(current, desired)).toBe(0);
  });

  it("compares complete planning baselines consistently", () => {
    const planned = state({
      frontmatter: { tags: ["Project"], metadata: { alpha: 1, beta: 2 } },
      frontmatterKeys: ["metadata", "tags"],
      tags: ["Project"],
      bodyContent: "Body only",
    });
    const current = state({
      frontmatter: { metadata: { beta: 2, alpha: 1 }, tags: ["Project"] },
      frontmatterKeys: ["tags", "metadata"],
      tags: ["#Project"],
      bodyContent: "Body only",
    });

    expect(sameNoteStateBaseline(planned, current)).toBe(true);
    expect(sameNoteStateBaseline(planned, { ...current, bodyContent: "Edited" })).toBe(false);
  });

  it("updates all path-derived state after collision resolution", () => {
    expect(withNoteStatePath(state(), "Archive/note 2.md")).toMatchObject({
      path: "Archive/note 2.md",
      basename: "note 2",
      extension: "md",
    });
  });
});
