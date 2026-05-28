import { describe, expect, it } from "vitest";

import { reconcileFileState } from "../../src/engine";
import type {
  NoteState,
  ReconciliationConverged,
  ReconciliationResult,
  ReconciliationCycleDetected,
  Rule,
} from "../../src/engine";

const defaultOptions = { maxIterations: 10 };

// Fixed reference timestamp: 2024-03-15T12:00:00Z
const NOW_MS = new Date("2024-03-15T12:00:00Z").getTime();
const optionsWithNow = { maxIterations: 10, now: NOW_MS };

function noteState(overrides: Partial<NoteState> = {}): NoteState {
  return {
    path: "Inbox/example.md",
    basename: "example",
    extension: "md",
    frontmatter: {},
    tags: [],
    ...overrides,
  };
}

function expectConverged(result: ReconciliationResult): ReconciliationConverged {
  expect(result.status).toBe("converged");
  if (result.status !== "converged") throw new Error(`Expected converged, got ${result.status}`);
  return result;
}

function expectCycleDetected(result: ReconciliationResult): ReconciliationCycleDetected {
  expect(result.status).toBe("cycle-detected");
  if (result.status !== "cycle-detected") throw new Error(`Expected cycle-detected, got ${result.status}`);
  return result;
}

// ---------------------------------------------------------------------------
// Fixture rules
// ---------------------------------------------------------------------------

const moveProgrammingTaggedNotes: Rule = {
  id: "move-programming",
  name: "Move programming tagged notes",
  enabled: true,
  priority: 0,
  order: 0,
  when: { type: "tag", tag: "programming" },
  then: { moveTo: "Programming/" },
};

const tagProgrammingPathNotes: Rule = {
  id: "tag-programming",
  name: "Tag notes in Programming",
  enabled: true,
  priority: 0,
  order: 1,
  when: { type: "pathGlob", glob: "Programming/*" },
  then: { addTags: ["programming"] },
};

const setEngineeringArea: Rule = {
  id: "set-engineering-area",
  name: "Set engineering area",
  enabled: true,
  priority: 0,
  order: 2,
  when: { type: "pathGlob", glob: "Programming/*" },
  then: { setProperties: { area: "engineering" } },
};

// ---------------------------------------------------------------------------
// Existing tidy scenarios (1-4)
// ---------------------------------------------------------------------------

describe("rule-based moves", () => {
  it("moves a programming-tagged note into Programming/", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["programming"] }),
      rules: [moveProgrammingTaggedNotes],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Programming/example.md");
    expect(result.mutations).toEqual([{ kind: "move", ruleIds: ["move-programming"] }]);
  });

  it("does not move a note without the tag", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState(),
      rules: [moveProgrammingTaggedNotes],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("matches tags case-insensitively like Obsidian", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["Programming"] }),
      rules: [moveProgrammingTaggedNotes],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Programming/example.md");
  });

  it("does not add a case-variant duplicate tag", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Programming/note.md", basename: "note", tags: ["Programming"] }),
      rules: [tagProgrammingPathNotes],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
    expect(result.desired.tags).toEqual(["Programming"]);
  });

  it("adds tag when note is already in Programming/", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Programming/note.md", basename: "note" }),
      rules: [tagProgrammingPathNotes],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("programming");
    expect(result.mutations.some((m) => m.kind === "frontmatter")).toBe(true);
  });
});

describe("state normalization", () => {
  it("treats frontmatter tags as unchanged when only their order differs", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { tags: ["b", "a"] },
        tags: ["b", "a"],
      }),
      rules: [],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
    expect(result.mutations).toEqual([]);
  });
});

describe("rule-based properties changes", () => {
  it("sets a property on matching notes", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Programming/api-design.md", basename: "api-design" }),
      rules: [setEngineeringArea],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.area).toBe("engineering");
  });

  it("is idempotent when property already matches", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Programming/api-design.md", basename: "api-design", frontmatter: { area: "engineering" } }),
      rules: [setEngineeringArea],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("ignores unsafe action-supplied property keys", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Programming/api-design.md", basename: "api-design" }),
      rules: [{
        ...setEngineeringArea,
        then: { setProperties: { constructor: "polluted", prototype: "polluted", safe: "ok" } },
      }],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.safe).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(result.desired.frontmatter, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.desired.frontmatter, "prototype")).toBe(false);
  });
});

describe("cascading rules (scenario 4 equivalent)", () => {
  it("applies tag then move in fixed-point convergence", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["programming"] }),
      rules: [moveProgrammingTaggedNotes, setEngineeringArea],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Programming/example.md");
    expect(result.desired.frontmatter.area).toBe("engineering");
  });
});

describe("cycle detection", () => {
  const moveBToC: Rule = {
    id: "b-to-c",
    name: "B to C",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "pathGlob", glob: "B/*" },
    then: { moveTo: "C/" },
  };
  const moveAToB: Rule = {
    id: "a-to-b",
    name: "A to B",
    enabled: true,
    priority: 0,
    order: 1,
    when: { type: "pathGlob", glob: "A/*" },
    then: { moveTo: "B/" },
  };
  const moveCToA: Rule = {
    id: "c-to-a",
    name: "C to A",
    enabled: true,
    priority: 0,
    order: 2,
    when: { type: "pathGlob", glob: "C/*" },
    then: { moveTo: "A/" },
  };

  it("detects a move cycle", () => {
    const result = expectCycleDetected(reconcileFileState({
      file: noteState({ path: "A/note.md", basename: "note" }),
      rules: [moveBToC, moveAToB, moveCToA],
      options: defaultOptions,
    }));

    expect(result.involvedRuleIds).toContain("a-to-b");
  });

  it("distinguishes an iteration limit from a repeated-state cycle", () => {
    const appendForever: Rule = {
      id: "append-forever",
      name: "Append forever",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "**" },
      then: { appendToProperty: { log: "entry" } },
    };

    const result = reconcileFileState({
      file: noteState(),
      rules: [appendForever],
      options: { maxIterations: 3 },
    });

    expect(result.status).toBe("max-iterations-exceeded");
    expect(result.iterations).toBe(3);
  });

  it("converges when rules leave no net state change in one pass", () => {
    const addReview: Rule = {
      id: "add-review",
      name: "Add review",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { addTags: ["review"] },
    };
    const removeReview: Rule = {
      id: "remove-review",
      name: "Remove review",
      enabled: true,
      priority: 0,
      order: 1,
      when: { type: "tag", tag: "review" },
      then: { removeTags: ["review"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState(),
      rules: [addReview, removeReview],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
    expect(result.mutations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// basename predicate
// ---------------------------------------------------------------------------

describe("basename predicate", () => {
  const renameIfMeeting: Rule = {
    id: "meeting-move",
    name: "Move meetings",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "basename", pattern: "^meeting" },
    then: { moveTo: "Meetings/" },
  };

  it("matches notes whose basename starts with 'meeting'", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/meeting-2024-01-15.md", basename: "meeting-2024-01-15" }),
      rules: [renameIfMeeting],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Meetings/meeting-2024-01-15.md");
  });

  it("is case-insensitive", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/Meeting-Notes.md", basename: "Meeting-Notes" }),
      rules: [renameIfMeeting],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
  });

  it("does not match non-meeting notes", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/project-plan.md", basename: "project-plan" }),
      rules: [renameIfMeeting],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("handles invalid regex gracefully (no match)", () => {
    const rule: Rule = {
      id: "bad-regex",
      name: "Bad regex",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "basename", pattern: "[invalid(" },
      then: { moveTo: "Error/" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState(),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// frontmatterValue predicate
// ---------------------------------------------------------------------------

describe("frontmatterValue predicate", () => {
  const moveIfTypeMeeting: Rule = {
    id: "type-meeting-move",
    name: "Move meeting type notes",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "frontmatterValue", property: "type", value: "meeting" },
    then: { moveTo: "Meetings/" },
  };

  it("matches when frontmatter property equals the expected value", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { type: "meeting" } }),
      rules: [moveIfTypeMeeting],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Meetings/example.md");
  });

  it("does not match when property has a different value", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { type: "project" } }),
      rules: [moveIfTypeMeeting],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("does not match when property is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {} }),
      rules: [moveIfTypeMeeting],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("matches boolean values", () => {
    const rule: Rule = {
      id: "archived",
      name: "Move archived",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "archived", value: true },
      then: { moveTo: "Archive/" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { archived: true } }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Archive/example.md");
  });

  it("matches numeric values", () => {
    const rule: Rule = {
      id: "priority-1",
      name: "High priority",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "priority", value: 1 },
      then: { setProperties: { urgent: true } },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { priority: 1 } }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.urgent).toBe(true);
  });

  it("matches explicit null but not a missing property", () => {
    const rule: Rule = {
      id: "null-status",
      name: "Null status",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "status", value: null },
      then: { addTags: ["needs-status"] },
    };

    const presentNull = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: null } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(presentNull.changed).toBe(true);
    expect(presentNull.desired.tags).toContain("needs-status");

    const missing = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {} }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(missing.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renameTo action
// ---------------------------------------------------------------------------

describe("renameTo action", () => {
  it("renames a note using a static string", () => {
    const rule: Rule = {
      id: "static-rename",
      name: "Static rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "daily" },
      then: { renameTo: "daily-note" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/untitled.md", basename: "untitled", tags: ["daily"] }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("daily-note");
    expect(result.desired.path).toBe("Inbox/daily-note.md");
    expect(result.mutations).toEqual([{ kind: "rename", ruleIds: ["static-rename"] }]);
  });

  it("renames using a frontmatter property template", () => {
    const rule: Rule = {
      id: "title-rename",
      name: "Rename to title",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "type", value: "meeting" },
      then: { renameTo: "{date} Meeting" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/untitled.md",
        basename: "untitled",
        frontmatter: { type: "meeting", date: "2024-01-15" },
      }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("2024-01-15 Meeting");
    expect(result.desired.path).toBe("Inbox/2024-01-15 Meeting.md");
  });

  it("renames using multiple property references", () => {
    const rule: Rule = {
      id: "multi-prop-rename",
      name: "Multi-prop rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "type", value: "meeting" },
      then: { renameTo: "{year}-{month}-{day} {title}" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/untitled.md",
        basename: "untitled",
        frontmatter: { type: "meeting", year: "2024", month: "01", day: "15", title: "Team Sync" },
      }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("2024-01-15 Team Sync");
  });

  it("skips rename when referenced property is missing", () => {
    const rule: Rule = {
      id: "missing-prop-rename",
      name: "Missing prop rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "note" },
      then: { renameTo: "{nonexistent}" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/test.md", basename: "test", tags: ["note"] }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("skips rename when referenced property is an array (non-scalar)", () => {
    const rule: Rule = {
      id: "array-prop-rename",
      name: "Array prop rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "note" },
      then: { renameTo: "{tags}" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/test.md", basename: "test", tags: ["note"], frontmatter: { tags: ["note", "draft"] } }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("skips rename when result is empty after sanitization", () => {
    const rule: Rule = {
      id: "empty-rename",
      name: "Empty rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "note" },
      then: { renameTo: "   " },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["note"] }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("combines rename and move in the same rule", () => {
    const rule: Rule = {
      id: "move-and-rename",
      name: "Move and rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "type", value: "meeting" },
      then: { moveTo: "Meetings/", renameTo: "{date} Meeting" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/untitled.md",
        basename: "untitled",
        frontmatter: { type: "meeting", date: "2024-01-15" },
      }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("2024-01-15 Meeting");
    expect(result.desired.path).toBe("Meetings/2024-01-15 Meeting.md");
    expect(result.mutations.some((m) => m.kind === "move")).toBe(true);
    expect(result.mutations.some((m) => m.kind === "rename")).toBe(true);
  });

  it("treats {{ as a literal {", () => {
    const rule: Rule = {
      id: "escape-brace",
      name: "Escape brace",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "note" },
      then: { renameTo: "{{literal}} note" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/test.md", basename: "test", tags: ["note"] }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("{literal} note");
  });

  it("is idempotent when basename already matches template result", () => {
    const rule: Rule = {
      id: "idempotent-rename",
      name: "Idempotent rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "type", value: "meeting" },
      then: { renameTo: "{date} Meeting" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Meetings/2024-01-15 Meeting.md",
        basename: "2024-01-15 Meeting",
        frontmatter: { type: "meeting", date: "2024-01-15" },
      }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });

  it("strips path separators from renamed basename for safety", () => {
    const rule: Rule = {
      id: "path-sep-rename",
      name: "Path sep rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "note" },
      then: { renameTo: "{title}" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/test.md",
        basename: "test",
        tags: ["note"],
        frontmatter: { title: "Notes/With/Slashes" },
      }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("NotesWithSlashes");
    expect(result.desired.path).not.toContain("//");
  });
});

// ---------------------------------------------------------------------------
// compound predicates
// ---------------------------------------------------------------------------

describe("compound predicates with new predicate types", () => {
  it("all: basename + frontmatterValue must both match", () => {
    const rule: Rule = {
      id: "all-rule",
      name: "All rule",
      enabled: true,
      priority: 0,
      order: 0,
      when: {
        type: "all",
        predicates: [
          { type: "basename", pattern: "^meeting" },
          { type: "frontmatterValue", property: "reviewed", value: false },
        ],
      },
      then: { setProperties: { status: "pending-review" } },
    };

    const matchResult = expectConverged(reconcileFileState({
      file: noteState({ basename: "meeting-notes", path: "Inbox/meeting-notes.md", frontmatter: { reviewed: false } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(matchResult.changed).toBe(true);

    const noMatchResult = expectConverged(reconcileFileState({
      file: noteState({ basename: "meeting-notes", path: "Inbox/meeting-notes.md", frontmatter: { reviewed: true } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(noMatchResult.changed).toBe(false);
  });

  it("not: inverts frontmatterValue", () => {
    const rule: Rule = {
      id: "not-rule",
      name: "Not archived",
      enabled: true,
      priority: 0,
      order: 0,
      when: {
        type: "not",
        predicate: { type: "frontmatterValue", property: "archived", value: true },
      },
      then: { setProperties: { status: "active" } },
    };

    const activeResult = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { archived: false } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(activeResult.changed).toBe(true);

    const archivedResult = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { archived: true } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(archivedResult.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sourceUrl predicate
// ---------------------------------------------------------------------------

describe("sourceUrl predicate", () => {
  const moveGithubNotes: Rule = {
    id: "github-source",
    name: "Move GitHub notes",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "sourceUrl", property: "source", host: "github.com" },
    then: { moveTo: "GitHub/" },
  };

  it("moves notes whose source URL host matches", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { source: "https://github.com/some/repo" } }),
      rules: [moveGithubNotes],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("GitHub/example.md");
  });

  it("does not match a different host", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { source: "https://gitlab.com/some/repo" } }),
      rules: [moveGithubNotes],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Disabled rules
// ---------------------------------------------------------------------------

describe("disabled rules", () => {
  it("ignores disabled rules", () => {
    const rule: Rule = { ...moveProgrammingTaggedNotes, enabled: false };
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["programming"] }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: frontmatterExists predicate
// ---------------------------------------------------------------------------

describe("frontmatterExists predicate", () => {
  const rule: Rule = {
    id: "has-status",
    name: "Has status",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "frontmatterExists", property: "status" },
    then: { moveTo: "Active/" },
  };

  it("matches when property is present with a value", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: "active" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Active/example.md");
  });

  it("does not match when property is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {} }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when property is null", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: null } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("matches when property is false (present but falsy)", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: false } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });

  it("matches when property is 0 (present but falsy)", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: 0 } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEW: frontmatterMissing predicate
// ---------------------------------------------------------------------------

describe("frontmatterMissing predicate", () => {
  const rule: Rule = {
    id: "no-status",
    name: "No status",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "frontmatterMissing", property: "status" },
    then: { setProperties: { status: "inbox" } },
  };

  it("matches when property is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {} }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.status).toBe("inbox");
  });

  it("does not match when property exists", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: "active" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("matches when property is null (treated as missing)", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: null } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEW: frontmatterContains predicate
// ---------------------------------------------------------------------------

describe("frontmatterContains predicate", () => {
  const rule: Rule = {
    id: "desc-urgent",
    name: "Urgent description",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "frontmatterContains", property: "description", value: "urgent" },
    then: { addTags: ["urgent"] },
  };

  it("matches when string property contains the substring", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { description: "This is an urgent request" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("urgent");
  });

  it("is case-insensitive", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { description: "URGENT matter" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });

  it("does not match when substring is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { description: "routine maintenance" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when property is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {} }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("matches against array elements", () => {
    const arrayRule: Rule = {
      id: "tag-contains",
      name: "Tag contains",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterContains", property: "categories", value: "work" },
      then: { moveTo: "Work/" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { categories: ["personal", "work", "finance"] } }),
      rules: [arrayRule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Work/example.md");
  });
});

// ---------------------------------------------------------------------------
// NEW: fileAge predicate
// ---------------------------------------------------------------------------

describe("fileAge predicate", () => {
  // Reference: NOW_MS = 2024-03-15T12:00:00Z
  // 40 days ago
  const oldMtime = NOW_MS - 40 * 24 * 60 * 60 * 1000;
  // 3 days ago
  const recentMtime = NOW_MS - 3 * 24 * 60 * 60 * 1000;

  const archiveOldRule: Rule = {
    id: "archive-old",
    name: "Archive old notes",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "fileAge", field: "mtime", olderThanDays: 30 },
    then: { moveTo: "Archive/" },
  };

  it("matches when mtime is older than specified days", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ stat: { ctime: oldMtime, mtime: oldMtime } }),
      rules: [archiveOldRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Archive/example.md");
  });

  it("does not match when mtime is newer than specified days", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ stat: { ctime: recentMtime, mtime: recentMtime } }),
      rules: [archiveOldRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when stat is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ stat: undefined }),
      rules: [archiveOldRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(false);
  });

  it("matches newerThanDays for recently modified notes", () => {
    const recentRule: Rule = {
      id: "recent",
      name: "Recently modified",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "fileAge", field: "mtime", newerThanDays: 7 },
      then: { addTags: ["recent"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ stat: { ctime: recentMtime, mtime: recentMtime } }),
      rules: [recentRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("recent");
  });

  it("newerThanDays does not match old files", () => {
    const recentRule: Rule = {
      id: "recent",
      name: "Recently modified",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "fileAge", field: "mtime", newerThanDays: 7 },
      then: { addTags: ["recent"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ stat: { ctime: oldMtime, mtime: oldMtime } }),
      rules: [recentRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(false);
  });

  it("uses ctime field when specified", () => {
    const ctimeRule: Rule = {
      id: "old-created",
      name: "Old created",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "fileAge", field: "ctime", olderThanDays: 30 },
      then: { addTags: ["old"] },
    };

    // mtime is recent but ctime is old
    const result = expectConverged(reconcileFileState({
      file: noteState({ stat: { ctime: oldMtime, mtime: recentMtime } }),
      rules: [ctimeRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEW: bodyH1 predicate
// ---------------------------------------------------------------------------

describe("bodyH1 predicate", () => {
  const rule: Rule = {
    id: "meeting-h1",
    name: "Meeting H1",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "bodyH1", pattern: "^Meeting:" },
    then: { moveTo: "Meetings/" },
  };

  it("matches when H1 heading matches pattern", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyH1: "Meeting: Team Sync" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Meetings/example.md");
  });

  it("is case-insensitive", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyH1: "meeting: standup" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });

  it("does not match when H1 heading does not match pattern", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyH1: "Project: Alpha" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when bodyH1 is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyH1: undefined }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: contentContains predicate
// ---------------------------------------------------------------------------

describe("contentContains predicate", () => {
  const rule: Rule = {
    id: "project-content",
    name: "Project content",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "contentContains", text: "#project-alpha" },
    then: { addTags: ["project-alpha"] },
  };

  it("matches when body contains the text", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: "Some text #project-alpha in the body." }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("project-alpha");
  });

  it("does not match when text is absent from body", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: "Some text without the tag." }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when bodyContent is absent (content not loaded)", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: undefined }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("is case-sensitive", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: "#PROJECT-ALPHA in the body" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: removeTags action
// ---------------------------------------------------------------------------

describe("removeTags action", () => {
  it("removes specified tags from frontmatter", () => {
    const rule: Rule = {
      id: "remove-wip",
      name: "Remove wip",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "status", value: "done" },
      then: { removeTags: ["wip"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { status: "done", tags: ["wip", "project"] },
        tags: ["wip", "project"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).not.toContain("wip");
    expect(result.desired.tags).toContain("project");
  });

  it("removes tags case-insensitively while preserving unrelated casing", () => {
    const rule: Rule = {
      id: "remove-case-variant",
      name: "Remove case variant",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "PROJECT" },
      then: { removeTags: ["wip"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { tags: ["WIP", "Project"] },
        tags: ["WIP", "Project"],
        frontmatterTags: ["WIP", "Project"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.frontmatterTags).toEqual(["Project"]);
    expect(result.desired.tags).toEqual(["Project"]);
  });

  it("leaves unrelated tags intact", () => {
    const rule: Rule = {
      id: "remove-draft",
      name: "Remove draft",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "published" },
      then: { removeTags: ["draft"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { tags: ["published", "draft", "article"] },
        tags: ["published", "draft", "article"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.desired.tags).not.toContain("draft");
    expect(result.desired.tags).toContain("published");
    expect(result.desired.tags).toContain("article");
  });

  it("does not claim to remove an inline-only tag", () => {
    const rule: Rule = {
      id: "remove-inline",
      name: "Remove inline",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "inline" },
      then: { removeTags: ["inline"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["inline"] }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
    expect(result.desired.tags).toContain("inline");
    expect(result.desired.frontmatter.tags).toBeUndefined();
  });

  it("keeps an inline tag when removing the same tag from frontmatter", () => {
    const rule: Rule = {
      id: "remove-shared",
      name: "Remove shared frontmatter tag",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "shared" },
      then: { removeTags: ["shared"] },
      stopOnMatch: true,
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { tags: ["shared"] },
        tags: ["shared"],
        frontmatterTags: ["shared"],
        inlineTags: ["shared"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.tags).toBeUndefined();
    expect(result.desired.frontmatterTags).toEqual([]);
    expect(result.desired.tags).toContain("shared");
    expect(result.desired.inlineTags).toEqual(["shared"]);
  });

  it("is a no-op when tag is not present", () => {
    const rule: Rule = {
      id: "remove-absent",
      name: "Remove absent",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "note" },
      then: { removeTags: ["nonexistent"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["note"] }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: deleteProperties action
// ---------------------------------------------------------------------------

describe("deleteProperties action", () => {
  it("deletes specified property from frontmatter", () => {
    const rule: Rule = {
      id: "delete-legacy",
      name: "Delete legacy field",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterExists", property: "legacy_id" },
      then: { deleteProperties: ["legacy_id"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { legacy_id: "abc123", title: "My Note" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter).not.toHaveProperty("legacy_id");
    expect(result.desired.frontmatter.title).toBe("My Note");
  });

  it("leaves other properties intact", () => {
    const rule: Rule = {
      id: "delete-one",
      name: "Delete one",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { deleteProperties: ["draft"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/note.md",
        basename: "note",
        frontmatter: { draft: true, status: "active", title: "Note" },
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.desired.frontmatter).not.toHaveProperty("draft");
    expect(result.desired.frontmatter.status).toBe("active");
    expect(result.desired.frontmatter.title).toBe("Note");
  });

  it("is a no-op when property does not exist", () => {
    const rule: Rule = {
      id: "delete-absent",
      name: "Delete absent",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { deleteProperties: ["nonexistent"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note", frontmatter: { title: "Note" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("deletes a property whose nested YAML value is not rule-editable", () => {
    const rule: Rule = {
      id: "delete-nested",
      name: "Delete nested",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterExists", property: "nested" },
      then: { deleteProperties: ["nested"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {}, frontmatterKeys: ["nested"] }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(true);
    expect(result.desired.frontmatterKeys).not.toContain("nested");
    expect(result.mutations.map((mutation) => mutation.kind)).toContain("frontmatter");
  });

  it("handles deleting the tags property", () => {
    const rule: Rule = {
      id: "delete-tags",
      name: "Delete tags",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterExists", property: "tags" },
      then: { deleteProperties: ["tags"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { tags: ["wip", "project"] },
        tags: ["wip", "project"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter).not.toHaveProperty("tags");
    expect(result.desired.tags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NEW: replaceTags action
// ---------------------------------------------------------------------------

describe("replaceTags action", () => {
  it("replaces all frontmatter tags with the given list", () => {
    const rule: Rule = {
      id: "replace-tags",
      name: "Replace tags",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "status", value: "archived" },
      then: { replaceTags: ["archived", "read-only"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { status: "archived", tags: ["active", "wip", "project"] },
        tags: ["active", "wip", "project"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toEqual(["archived", "read-only"]);
    expect(result.desired.tags).not.toContain("active");
    expect(result.desired.tags).not.toContain("wip");
  });

  it("removes all tags when replacing with empty list", () => {
    const rule: Rule = {
      id: "clear-tags",
      name: "Clear tags",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterValue", property: "status", value: "deleted" },
      then: { replaceTags: [] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { status: "deleted", tags: ["active"] },
        tags: ["active"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toHaveLength(0);
  });

  it("is idempotent when tags already match", () => {
    const rule: Rule = {
      id: "replace-idempotent",
      name: "Replace idempotent",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "project" },
      then: { replaceTags: ["project"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        frontmatter: { tags: ["project"] },
        tags: ["project"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-rule dry-run
// ---------------------------------------------------------------------------

describe("per-rule dry-run", () => {
  it("returns the hypothetical plan without changing live desired state", () => {
    const rule: Rule = {
      id: "dry-move",
      name: "Dry move",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { moveTo: "Archive/", setProperties: { status: "planned" } },
      dryRun: true,
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note" }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
    expect(result.desired.path).toBe("Inbox/note.md");
    expect(result.dryRunRuleIds).toEqual(["dry-move"]);
    expect(result.dryRunMatches).toHaveLength(1);
    expect(result.dryRunMatches?.[0]?.desired.path).toBe("Archive/note.md");
    expect(result.dryRunMatches?.[0]?.desired.frontmatter.status).toBe("planned");
    expect(result.dryRunMatches?.[0]?.mutations.map((mutation) => mutation.kind)).toEqual(["move", "frontmatter"]);
  });
});

// ---------------------------------------------------------------------------
// stopOnMatch
// ---------------------------------------------------------------------------

describe("stopOnMatch", () => {
  it("stops evaluating further rules after a stopOnMatch rule fires", () => {
    const firstRule: Rule = {
      id: "first",
      name: "First",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { moveTo: "Archive/" },
      stopOnMatch: true,
    };
    const secondRule: Rule = {
      id: "second",
      name: "Second",
      enabled: true,
      priority: 1,
      order: 1,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { addTags: ["should-not-be-added"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note" }),
      rules: [firstRule, secondRule],
      options: defaultOptions,
    }));
    expect(result.desired.path).toBe("Archive/note.md");
    expect(result.desired.tags).not.toContain("should-not-be-added");
    expect(result.appliedRuleIds).toContain("first");
    expect(result.appliedRuleIds).not.toContain("second");
  });

  it("does not resume later rules on a subsequent reconciliation iteration", () => {
    const firstRule: Rule = {
      id: "first",
      name: "First",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { moveTo: "Archive/" },
      stopOnMatch: true,
    };
    const laterRule: Rule = {
      id: "later",
      name: "Later",
      enabled: true,
      priority: 1,
      order: 1,
      when: { type: "pathGlob", glob: "Archive/*" },
      then: { addTags: ["should-not-fire"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note" }),
      rules: [firstRule, laterRule],
      options: defaultOptions,
    }));

    expect(result.desired.path).toBe("Archive/note.md");
    expect(result.desired.tags).not.toContain("should-not-fire");
    expect(result.appliedRuleIds).toEqual(["first"]);
    expect(result.iterations).toBe(1);
  });

  it("does not stop when the stopOnMatch rule does not match", () => {
    const nonMatchingStop: Rule = {
      id: "non-matching",
      name: "Non matching",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "special" },
      then: { moveTo: "Special/" },
      stopOnMatch: true,
    };
    const fallthrough: Rule = {
      id: "fallthrough",
      name: "Fallthrough",
      enabled: true,
      priority: 1,
      order: 1,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { addTags: ["processed"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note" }),
      rules: [nonMatchingStop, fallthrough],
      options: defaultOptions,
    }));
    expect(result.desired.tags).toContain("processed");
    expect(result.appliedRuleIds).toContain("fallthrough");
  });

  it("fires stopOnMatch even when the rule causes no change", () => {
    // Rule matches and has no-op action (tag already present), but still stops
    const stopRule: Rule = {
      id: "stop-noop",
      name: "Stop noop",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { addTags: ["inbox"] }, // tag already present
      stopOnMatch: true,
    };
    const laterRule: Rule = {
      id: "later",
      name: "Later",
      enabled: true,
      priority: 1,
      order: 1,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { addTags: ["should-not-fire"] },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note", tags: ["inbox"] }),
      rules: [stopRule, laterRule],
      options: defaultOptions,
    }));
    expect(result.desired.tags).not.toContain("should-not-fire");
    expect(result.appliedRuleIds).not.toContain("later");
  });
});

// ---------------------------------------------------------------------------
// NEW: runOn trigger filtering
// ---------------------------------------------------------------------------

describe("runOn trigger filtering", () => {
  const liveOnlyRule: Rule = {
    id: "live-only",
    name: "Live only",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "pathGlob", glob: "Inbox/*" },
    then: { addTags: ["live-processed"] },
    runOn: "live",
  };

  const sweepOnlyRule: Rule = {
    id: "sweep-only",
    name: "Sweep only",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "pathGlob", glob: "Inbox/*" },
    then: { addTags: ["sweep-processed"] },
    runOn: "sweep",
  };

  const alwaysRule: Rule = {
    id: "always",
    name: "Always",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "pathGlob", glob: "Inbox/*" },
    then: { addTags: ["always-processed"] },
    runOn: "always",
  };

  it("runs live rule when triggerContext is live", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note" }),
      rules: [liveOnlyRule],
      options: { maxIterations: 10, triggerContext: "live" },
    }));
    expect(result.desired.tags).toContain("live-processed");
  });

  it("skips live rule when triggerContext is sweep", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note" }),
      rules: [liveOnlyRule],
      options: { maxIterations: 10, triggerContext: "sweep" },
    }));
    expect(result.changed).toBe(false);
  });

  it("skips live rule when triggerContext is manual", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note" }),
      rules: [liveOnlyRule],
      options: { maxIterations: 10, triggerContext: "manual" },
    }));
    expect(result.changed).toBe(false);
  });

  it("runs sweep rule when triggerContext is sweep", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note" }),
      rules: [sweepOnlyRule],
      options: { maxIterations: 10, triggerContext: "sweep" },
    }));
    expect(result.desired.tags).toContain("sweep-processed");
  });

  it("always rule runs on any trigger context", () => {
    for (const ctx of ["live", "sweep", "manual"] as const) {
      const result = expectConverged(reconcileFileState({
        file: noteState({ path: "Inbox/note.md", basename: "note" }),
        rules: [alwaysRule],
        options: { maxIterations: 10, triggerContext: ctx },
      }));
      expect(result.desired.tags).toContain("always-processed");
    }
  });

  it("rule without runOn defaults to always and runs on any context", () => {
    const defaultRule: Rule = {
      id: "no-runon",
      name: "No runOn",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { addTags: ["processed"] },
    };

    for (const ctx of ["live", "sweep", "manual"] as const) {
      const result = expectConverged(reconcileFileState({
        file: noteState({ path: "Inbox/note.md", basename: "note" }),
        rules: [defaultRule],
        options: { maxIterations: 10, triggerContext: ctx },
      }));
      expect(result.desired.tags).toContain("processed");
    }
  });
});

// ---------------------------------------------------------------------------
// NEW: Template enhancements ({now}, {date:FORMAT}, {basename}, captures)
// ---------------------------------------------------------------------------

describe("template enhancements", () => {
  it("expands {now} to current date as YYYY-MM-DD", () => {
    const rule: Rule = {
      id: "now-rename",
      name: "Now rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "daily" },
      then: { renameTo: "{now} daily" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["daily"], basename: "untitled" }),
      rules: [rule],
      options: optionsWithNow,
    }));
    expect(result.desired.basename).toBe("2024-03-15 daily");
  });

  it("expands {now:YYYY} to current year", () => {
    const rule: Rule = {
      id: "year-rename",
      name: "Year rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "archive" },
      then: { renameTo: "{now:YYYY} archive" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["archive"], basename: "old-note" }),
      rules: [rule],
      options: optionsWithNow,
    }));
    expect(result.desired.basename).toBe("2024 archive");
  });

  it("expands {date:MM-DD} to month-day from current date", () => {
    const rule: Rule = {
      id: "date-format-rename",
      name: "Date format rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "daily" },
      then: { renameTo: "{date:MM-DD} note" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["daily"], basename: "untitled" }),
      rules: [rule],
      options: optionsWithNow,
    }));
    expect(result.desired.basename).toBe("03-15 note");
  });

  it("skips plain {date} when the frontmatter date property is missing", () => {
    const rule: Rule = {
      id: "missing-date",
      name: "Missing date",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "note" },
      then: { renameTo: "{date} note" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["note"], basename: "untitled", frontmatter: {} }),
      rules: [rule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(false);
  });

  it("{date} (no colon) uses frontmatter date property for backward compat", () => {
    const rule: Rule = {
      id: "fm-date",
      name: "FM date",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "note" },
      then: { renameTo: "{date} note" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({
        tags: ["note"],
        basename: "untitled",
        frontmatter: { date: "2023-06-01" },
      }),
      rules: [rule],
      options: optionsWithNow,
    }));
    // {date} should use the frontmatter "date" property, not today's date
    expect(result.desired.basename).toBe("2023-06-01 note");
  });

  it("expands {basename} to the current note basename", () => {
    const rule: Rule = {
      id: "basename-rename",
      name: "Basename rename",
      enabled: true,
      priority: 0,
      order: 0,
      // Guard: only fire when basename doesn't already have the year prefix
      when: {
        type: "all",
        predicates: [
          { type: "tag", tag: "archive" },
          { type: "not", predicate: { type: "basename", pattern: "^\\d{4} - " } },
        ],
      },
      then: { renameTo: "{now:YYYY} - {basename}" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["archive"], basename: "my-project-notes" }),
      rules: [rule],
      options: optionsWithNow,
    }));
    expect(result.desired.basename).toBe("2024 - my-project-notes");
  });

  it("expands {1} capture group from basename predicate in renameTo", () => {
    const rule: Rule = {
      id: "capture-rename",
      name: "Capture rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "basename", pattern: "^(\\d{4}-\\d{2}-\\d{2})-(.+)$" },
      then: { renameTo: "{2} ({1})" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/2024-01-15-team-sync.md", basename: "2024-01-15-team-sync" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.desired.basename).toBe("team-sync (2024-01-15)");
  });

  it("expands capture groups in moveTo template", () => {
    const rule: Rule = {
      id: "capture-move",
      name: "Capture move",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "basename", pattern: "^(\\d{4})-(\\d{2})-" },
      then: { moveTo: "Archive/{1}/{2}/" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/2024-03-daily.md", basename: "2024-03-daily" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.desired.path).toBe("Archive/2024/03/2024-03-daily.md");
  });

  it("skips rename when capture group index is out of range", () => {
    const rule: Rule = {
      id: "bad-capture",
      name: "Bad capture",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "basename", pattern: "^(\\w+)" },
      then: { renameTo: "{1} {2}" }, // {2} doesn't exist
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ basename: "hello" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("expands frontmatter property in moveTo", () => {
    const rule: Rule = {
      id: "property-moveto",
      name: "Property moveTo",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterExists", property: "project" },
      then: { moveTo: "Projects/{project}/" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { project: "alpha" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.desired.path).toBe("Projects/alpha/example.md");
  });

  it("classifies templated moveTo destinations as files after expansion", () => {
    const rule: Rule = {
      id: "templated-file-move",
      name: "Templated file move",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterExists", property: "target" },
      then: { moveTo: "Archive/{target}" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ basename: "source", frontmatter: { target: "renamed.md" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.desired.path).toBe("Archive/renamed.md");
    expect(result.desired.basename).toBe("renamed");
  });

  it("classifies templated moveTo destinations as folders after expansion", () => {
    const rule: Rule = {
      id: "templated-folder-move",
      name: "Templated folder move",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterExists", property: "target" },
      then: { moveTo: "Archive/{target}" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ basename: "source", frontmatter: { target: "project" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.desired.path).toBe("Archive/project/source.md");
    expect(result.desired.basename).toBe("source");
  });

  it("skips moveTo when referenced frontmatter property is missing", () => {
    const rule: Rule = {
      id: "missing-prop-move",
      name: "Missing prop move",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { moveTo: "Projects/{nonexistent}/" },
    };

    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note", frontmatter: {} }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: frontmatterRegex predicate
// ---------------------------------------------------------------------------

describe("frontmatterRegex predicate", () => {
  const rule: Rule = {
    id: "regex-status",
    name: "Regex status",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "frontmatterRegex", property: "status", pattern: "^in.?progress$" },
    then: { addTags: ["active"] },
  };

  it("matches when property value matches the regex", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: "in-progress" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("active");
  });

  it("is case-insensitive", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: "IN-PROGRESS" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });

  it("does not match when property value does not match the regex", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: "done" } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when property is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {} }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when property is null", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: null } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("returns no match on invalid regex (safe fallback)", () => {
    const badRule: Rule = {
      id: "bad-regex-fm",
      name: "Bad regex fm",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterRegex", property: "status", pattern: "[invalid(" },
      then: { addTags: ["active"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { status: "anything" } }),
      rules: [badRule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("matches numeric property by coercing to string", () => {
    const numRule: Rule = {
      id: "regex-priority",
      name: "Regex priority",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterRegex", property: "priority", pattern: "^[12]$" },
      then: { addTags: ["high-priority"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { priority: 1 } }),
      rules: [numRule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("high-priority");
  });
});

// ---------------------------------------------------------------------------
// NEW: frontmatterDateAge predicate
// ---------------------------------------------------------------------------

describe("frontmatterDateAge predicate", () => {
  // Reference: NOW_MS = 2024-03-15T12:00:00Z
  // 40 days ago as ISO string
  const oldDate = new Date(NOW_MS - 40 * 24 * 60 * 60 * 1000).toISOString();
  // 5 days ago as ISO string
  const recentDate = new Date(NOW_MS - 5 * 24 * 60 * 60 * 1000).toISOString();

  const archiveOldDateRule: Rule = {
    id: "archive-old-date",
    name: "Archive old dated notes",
    enabled: true,
    priority: 0,
    order: 0,
    when: { type: "frontmatterDateAge", property: "date", olderThanDays: 30 },
    then: { moveTo: "Archive/" },
  };

  it("matches when date property is an ISO string older than N days", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { date: oldDate } }),
      rules: [archiveOldDateRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Archive/example.md");
  });

  it("does not match when date property is newer than N days", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { date: recentDate } }),
      rules: [archiveOldDateRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when property is absent", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {} }),
      rules: [archiveOldDateRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when property value is not a parseable date", () => {
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { date: "not-a-date" } }),
      rules: [archiveOldDateRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(false);
  });

  it("matches newerThanDays for recently dated notes", () => {
    const recentDateRule: Rule = {
      id: "recent-date",
      name: "Recent date",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterDateAge", property: "date", newerThanDays: 7 },
      then: { addTags: ["recent"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { date: recentDate } }),
      rules: [recentDateRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("recent");
  });

  it("newerThanDays does not match old dates", () => {
    const recentDateRule: Rule = {
      id: "recent-date-2",
      name: "Recent date 2",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterDateAge", property: "date", newerThanDays: 7 },
      then: { addTags: ["recent"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { date: oldDate } }),
      rules: [recentDateRule],
      options: optionsWithNow,
    }));
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: wordCount predicate
// ---------------------------------------------------------------------------

describe("wordCount predicate", () => {
  // 100 words
  const longBody = Array(10).fill("alpha beta gamma delta epsilon zeta eta theta iota kappa").join(" ");
  // 5 words
  const shortBody = "one two three four five";

  it("matches when body word count is above moreThan threshold", () => {
    const rule: Rule = {
      id: "long-notes",
      name: "Long notes",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "wordCount", moreThan: 50 },
      then: { addTags: ["long"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: longBody }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("long");
  });

  it("does not match when body word count is at or below moreThan threshold", () => {
    const rule: Rule = {
      id: "long-notes-2",
      name: "Long notes 2",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "wordCount", moreThan: 50 },
      then: { addTags: ["long"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: shortBody }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("matches when body word count is below lessThan threshold", () => {
    const rule: Rule = {
      id: "stub-notes",
      name: "Stub notes",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "wordCount", lessThan: 10 },
      then: { addTags: ["stub"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: shortBody }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("stub");
  });

  it("does not match when body word count is at or above lessThan threshold", () => {
    const rule: Rule = {
      id: "stub-notes-2",
      name: "Stub notes 2",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "wordCount", lessThan: 10 },
      then: { addTags: ["stub"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: longBody }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("treats empty body as 0 words — matches lessThan", () => {
    const rule: Rule = {
      id: "empty-notes",
      name: "Empty notes",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "wordCount", lessThan: 5 },
      then: { addTags: ["empty"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: "" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });

  it("does not match lessThan when bodyContent is absent", () => {
    const rule: Rule = {
      id: "missing-body-stub",
      name: "Missing body stub",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "wordCount", lessThan: 5 },
      then: { addTags: ["stub"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: undefined }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not let a negated wordCount match when bodyContent is absent", () => {
    const rule: Rule = {
      id: "not-long-missing-body",
      name: "Not long missing body",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "not", predicate: { type: "wordCount", moreThan: 50 } },
      then: { addTags: ["not-long"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: undefined }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("uses both moreThan and lessThan as range", () => {
    const rule: Rule = {
      id: "medium-notes",
      name: "Medium notes",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "wordCount", moreThan: 2, lessThan: 20 },
      then: { addTags: ["medium"] },
    };
    // shortBody has 5 words: moreThan:2 and lessThan:20 → matches
    const matchResult = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: shortBody }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(matchResult.changed).toBe(true);

    // longBody has 100 words: lessThan:20 fails
    const noMatchResult = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: longBody }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(noMatchResult.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: tagPrefix predicate
// ---------------------------------------------------------------------------

describe("tagPrefix predicate", () => {
  it("matches a tag that starts with the given prefix", () => {
    const rule: Rule = {
      id: "area-prefix",
      name: "Area prefix",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tagPrefix", prefix: "area" },
      then: { moveTo: "Areas/" },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["area/work", "project"] }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Areas/example.md");
  });

  it("matches tag prefixes case-insensitively", () => {
    const rule: Rule = {
      id: "case-insensitive-prefix",
      name: "Case insensitive prefix",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tagPrefix", prefix: "AREA" },
      then: { moveTo: "Areas/" },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["area/Work"] }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });

  it("does not match when no tags start with the prefix", () => {
    const rule: Rule = {
      id: "area-prefix-2",
      name: "Area prefix 2",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tagPrefix", prefix: "area" },
      then: { moveTo: "Areas/" },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["project", "work"] }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("normalizes # from prefix before matching", () => {
    const rule: Rule = {
      id: "hash-prefix",
      name: "Hash prefix",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tagPrefix", prefix: "#area" },
      then: { addTags: ["has-area"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["area/engineering"] }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("has-area");
  });

  it("matches an exact tag when it equals the prefix", () => {
    const rule: Rule = {
      id: "exact-prefix",
      name: "Exact prefix",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tagPrefix", prefix: "project" },
      then: { addTags: ["has-project"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ tags: ["project"] }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEW: contentRegex predicate
// ---------------------------------------------------------------------------

describe("contentRegex predicate", () => {
  it("matches when body content matches the regex", () => {
    const rule: Rule = {
      id: "content-regex-match",
      name: "Content regex match",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "contentRegex", pattern: "TODO:" },
      then: { addTags: ["has-todos"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: "Some text\nTODO: finish the report" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.tags).toContain("has-todos");
  });

  it("is case-insensitive", () => {
    const rule: Rule = {
      id: "content-regex-ci",
      name: "Content regex ci",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "contentRegex", pattern: "todo:" },
      then: { addTags: ["has-todos"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: "TODO: something" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
  });

  it("does not match when body content does not match the regex", () => {
    const rule: Rule = {
      id: "content-regex-no-match",
      name: "Content regex no match",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "contentRegex", pattern: "TODO:" },
      then: { addTags: ["has-todos"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: "Nothing special here" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not match when bodyContent is absent", () => {
    const rule: Rule = {
      id: "content-regex-absent",
      name: "Content regex absent",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "contentRegex", pattern: "TODO:" },
      then: { addTags: ["has-todos"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: undefined }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("does not let a negated contentRegex match when bodyContent is absent", () => {
    const rule: Rule = {
      id: "not-content-regex-absent",
      name: "Not content regex absent",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "not", predicate: { type: "contentRegex", pattern: "TODO:" } },
      then: { addTags: ["no-todos"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: undefined }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("returns no match on invalid regex (safe fallback)", () => {
    const rule: Rule = {
      id: "content-regex-bad",
      name: "Content regex bad",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "contentRegex", pattern: "[invalid(" },
      then: { addTags: ["matched"] },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ bodyContent: "some content" }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });

  it("exposes capture groups as {1} {2} in renameTo template", () => {
    const rule: Rule = {
      id: "content-capture-rename",
      name: "Content capture rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "contentRegex", pattern: "Project:\\s+(\\w+)\\s+Phase:\\s+(\\d+)" },
      then: { renameTo: "{1}-phase{2}" },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/untitled.md",
        basename: "untitled",
        bodyContent: "Project: Alpha Phase: 3",
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("Alpha-phase3");
  });
});

// ---------------------------------------------------------------------------
// NEW: Template variables {folder}, {path}, {extension}
// ---------------------------------------------------------------------------

describe("template variables — folder, path, extension", () => {
  it("{folder} expands to the immediate parent folder segment", () => {
    const rule: Rule = {
      id: "folder-rename",
      name: "Folder rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "index" },
      then: { renameTo: "{folder}-index" },
    };
    // path = "Projects/Alpha/note.md", folder = "Projects/Alpha"
    // slashes stripped in basename template → "ProjectsAlpha-index"
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Projects/Alpha/note.md",
        basename: "note",
        tags: ["index"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("ProjectsAlpha-index");
  });

  it("{folder} in moveTo template is preserved as a path component", () => {
    // Guard: don't re-fire after the file is already in Mirror/
    const rule: Rule = {
      id: "folder-move",
      name: "Folder move",
      enabled: true,
      priority: 0,
      order: 0,
      when: {
        type: "all",
        predicates: [
          { type: "tag", tag: "mirror" },
          { type: "not", predicate: { type: "pathGlob", glob: "Mirror/**" } },
        ],
      },
      then: { moveTo: "Mirror/{folder}/" },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Projects/Alpha/note.md",
        basename: "note",
        tags: ["mirror"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.path).toBe("Mirror/Projects/Alpha/note.md");
  });

  it("{path} in renameTo strips slashes and expands to path without extension", () => {
    // Guard: only fire when basename is the original "note" — after rename predicate won't match
    const rule: Rule = {
      id: "path-rename",
      name: "Path rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "basename", pattern: "^note$" },
      then: { renameTo: "{path}" },
    };
    // path = "Projects/Alpha/note.md", {path} without extension = "Projects/Alpha/note"
    // slashes stripped in basename template → "ProjectsAlphanote"
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Projects/Alpha/note.md",
        basename: "note",
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("ProjectsAlphanote");
  });

  it("{extension} expands to 'md' for a markdown file", () => {
    // Guard: only rename when basename doesn't already end in .bak
    const rule: Rule = {
      id: "ext-rename",
      name: "Ext rename",
      enabled: true,
      priority: 0,
      order: 0,
      when: {
        type: "all",
        predicates: [
          { type: "tag", tag: "note" },
          { type: "not", predicate: { type: "basename", pattern: "\\.bak$" } },
        ],
      },
      then: { renameTo: "{basename}.{extension}.bak" },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/myfile.md",
        basename: "myfile",
        extension: "md",
        tags: ["note"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.basename).toBe("myfile.md.bak");
  });
});

// ---------------------------------------------------------------------------
// NEW: initProperties action
// ---------------------------------------------------------------------------

describe("initProperties action", () => {
  it("sets properties that are missing from frontmatter", () => {
    const rule: Rule = {
      id: "init-defaults",
      name: "Init defaults",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { initProperties: { status: "inbox", reviewed: false } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ path: "Inbox/note.md", basename: "note", frontmatter: {} }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.status).toBe("inbox");
    expect(result.desired.frontmatter.reviewed).toBe(false);
  });

  it("does not overwrite an existing non-null property", () => {
    const rule: Rule = {
      id: "init-no-overwrite",
      name: "Init no overwrite",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { initProperties: { status: "inbox", priority: 3 } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/note.md",
        basename: "note",
        frontmatter: { status: "active", priority: 1 },
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
    expect(result.desired.frontmatter.status).toBe("active");
    expect(result.desired.frontmatter.priority).toBe(1);
  });

  it("does not overwrite an existing unsupported nested YAML property", () => {
    const rule: Rule = {
      id: "init-nested",
      name: "Init nested",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { initProperties: { nested: "replacement" } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/note.md",
        basename: "note",
        frontmatter: {},
        frontmatterKeys: ["nested"],
      }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
    expect(result.desired.frontmatter).not.toHaveProperty("nested");
    expect(result.desired.frontmatterKeys).toContain("nested");
  });

  it("sets a property when it is null (treated as missing)", () => {
    const rule: Rule = {
      id: "init-null",
      name: "Init null",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { initProperties: { status: "inbox" } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/note.md",
        basename: "note",
        frontmatter: { status: null },
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.status).toBe("inbox");
  });

  it("is idempotent when all init properties already exist", () => {
    const rule: Rule = {
      id: "init-idempotent",
      name: "Init idempotent",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "Inbox/*" },
      then: { initProperties: { status: "inbox" } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        path: "Inbox/note.md",
        basename: "note",
        frontmatter: { status: "inbox" },
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: appendToProperty action
// ---------------------------------------------------------------------------

describe("appendToProperty action", () => {
  it("appends a string to an existing string property (space-separated)", () => {
    // Guard with a not-regex so rule is idempotent after appending
    const rule: Rule = {
      id: "append-log",
      name: "Append log",
      enabled: true,
      priority: 0,
      order: 0,
      when: {
        type: "all",
        predicates: [
          { type: "tag", tag: "updated" },
          { type: "not", predicate: { type: "frontmatterRegex", property: "log", pattern: "entry-added" } },
        ],
      },
      then: { appendToProperty: { log: "entry-added" } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        tags: ["updated"],
        frontmatter: { log: "previous-entry" },
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.log).toBe("previous-entry entry-added");
  });

  it("sets property when it is missing", () => {
    // Use frontmatterMissing as guard so the rule doesn't re-fire after setting the property
    const rule: Rule = {
      id: "append-set-missing",
      name: "Append set missing",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterMissing", property: "notes" },
      then: { appendToProperty: { notes: "initial" } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {} }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.notes).toBe("initial");
  });

  it("skips a non-string existing value (no change for that key)", () => {
    const rule: Rule = {
      id: "append-skip-nonstring",
      name: "Append skip nonstring",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "tag", tag: "updated" },
      then: { appendToProperty: { count: "more" } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({
        tags: ["updated"],
        frontmatter: { count: 42 }, // numeric — should be skipped
      }),
      rules: [rule],
      options: defaultOptions,
    }));
    // count should remain 42, no change
    expect(result.changed).toBe(false);
    expect(result.desired.frontmatter.count).toBe(42);
  });

  it("does not append over an existing unsupported nested YAML property", () => {
    const rule: Rule = {
      id: "append-nested",
      name: "Append nested",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "pathGlob", glob: "**" },
      then: { appendToProperty: { nested: "entry" } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: {}, frontmatterKeys: ["nested"] }),
      rules: [rule],
      options: defaultOptions,
    }));

    expect(result.changed).toBe(false);
    expect(result.desired.frontmatter).not.toHaveProperty("nested");
  });

  it("sets property when it is null", () => {
    // Use frontmatterMissing as guard (null counts as missing) so the rule doesn't re-fire
    const rule: Rule = {
      id: "append-null",
      name: "Append null",
      enabled: true,
      priority: 0,
      order: 0,
      when: { type: "frontmatterMissing", property: "log" },
      then: { appendToProperty: { log: "first" } },
    };
    const result = expectConverged(reconcileFileState({
      file: noteState({ frontmatter: { log: null } }),
      rules: [rule],
      options: defaultOptions,
    }));
    expect(result.changed).toBe(true);
    expect(result.desired.frontmatter.log).toBe("first");
  });
});
