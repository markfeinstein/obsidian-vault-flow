import { describe, expect, it } from "vitest";
import { planReconciliationForFile, previewReconciliationForFile } from "../../src/obsidian/dry-run-preview";
import type { DryRunPreview } from "../../src/obsidian/dry-run-preview";
import type { VaultFlowSettings } from "../../src/obsidian/settings";
import { TFile } from "obsidian";
import type { App, CachedMetadata } from "obsidian";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PreviewSettings = Pick<VaultFlowSettings, "maxIterations" | "rules" | "collisionPolicy" | "exclusionPatterns" | "disableFrontmatterKey" | "monitoredFolders">;

const baseSettings: PreviewSettings = {
  maxIterations: 10,
  rules: [],
  collisionPolicy: "skip",
  exclusionPatterns: [],
  disableFrontmatterKey: "vault-flow-disable",
  monitoredFolders: [],
};

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  const parts = path.split("/");
  const filename = parts[parts.length - 1] ?? path;
  const dotIndex = filename.lastIndexOf(".");
  file.basename = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  file.extension = dotIndex > 0 ? filename.slice(dotIndex + 1) : "";
  file.stat = { ctime: Date.now() - 10000, mtime: Date.now() - 1000, size: 0 };
  return file;
}

function makeApp(options: {
  frontmatter?: Record<string, unknown>;
  bodyContent?: string;
  bodyReadError?: Error;
  existingPaths?: string[];
} = {}): App {
  const { frontmatter = {}, bodyContent, bodyReadError, existingPaths = [] } = options;

  const cache: CachedMetadata = {
    frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
    tags: [],
  };

  return {
    metadataCache: {
      getFileCache: () => cache,
    },
    vault: {
      configDir: ".obsidian",
      cachedRead: async () => {
        if (bodyReadError !== undefined) throw bodyReadError;
        return bodyContent ?? "";
      },
      getAbstractFileByPath: (path: string) => {
        const found = existingPaths.find((p) => p === path);
        if (!found) return null;
        const f = new TFile();
        f.path = found;
        return f;
      },
    },
  } as unknown as App;
}

// ---------------------------------------------------------------------------
// Basic preview behaviour
// ---------------------------------------------------------------------------

describe("previewReconciliationForFile — basic", () => {
  it("returns unchanged when no rules match", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp();
    const preview = await previewReconciliationForFile(app, file, baseSettings);
    expect(preview.outcome).toBe("unchanged");
  });

  it("shows matching per-rule dry-run plans without making them applyable", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp();
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "dry-move",
        name: "Dry move",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "pathGlob", glob: "Inbox/*" },
        then: { moveTo: "Archive/" },
        dryRun: true,
      }],
    };

    const plan = await planReconciliationForFile(app, file, settings);
    expect(plan.preview.outcome).toBe("dry-run");
    expect(plan.preview.desiredPath).toBe("Archive/note.md");
    expect(plan.preview.dryRunRuleIds).toEqual(["dry-move"]);
    expect(plan.result).toBeNull();
  });

  it("returns an apply-ready plan for changed previews", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({ frontmatter: { type: "meeting" } });
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "move-meeting",
        name: "Move meeting",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "frontmatterValue", property: "type", value: "meeting" },
        then: { moveTo: "Meetings/" },
      }],
    };
    const plan = await planReconciliationForFile(app, file, settings);
    expect(plan.preview.outcome).toBe("changed");
    expect(plan.result).not.toBeNull();
    expect(plan.current.path).toBe("Inbox/note.md");
  });

  it("reports body read failures instead of silently evaluating content rules", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({ bodyReadError: new Error("read failed") });
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "body",
        name: "Body",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "contentContains", text: "trigger" },
        then: { moveTo: "Archive/" },
      }],
    };

    const plan = await planReconciliationForFile(app, file, settings);
    expect(plan.preview.outcome).toBe("error");
    expect(plan.preview.message).toContain("read failed");
    expect(plan.result).toBeNull();
  });

  it("excludes YAML frontmatter from body-content predicates", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({
      frontmatter: { status: "trigger" },
      bodyContent: "---\nstatus: trigger\n---\nVisible body only.\n",
    });
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "body-only",
        name: "Body only",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "contentContains", text: "trigger" },
        then: { moveTo: "Archive/" },
      }],
    };

    const plan = await planReconciliationForFile(app, file, settings);
    expect(plan.preview.outcome).toBe("unchanged");
    expect(plan.current.bodyContent).toBe("Visible body only.\n");
  });

  it("counts words only in the Markdown body", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({
      frontmatter: { verbose: "one two three four five" },
      bodyContent: "---\nverbose: one two three four five\n---\nTwo words\n",
    });
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "body-word-count",
        name: "Body word count",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "wordCount", moreThan: 2 },
        then: { moveTo: "Archive/" },
      }],
    };

    const plan = await planReconciliationForFile(app, file, settings);
    expect(plan.preview.outcome).toBe("unchanged");
  });

  it("returns changed when a matching rule would move the file", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({ frontmatter: { type: "meeting" } });
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "move-meeting",
        name: "Move meeting",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "frontmatterValue", property: "type", value: "meeting" },
        then: { moveTo: "Meetings/" },
      }],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("changed");
    expect(preview.desiredPath).toBe("Meetings/note.md");
    expect(preview.mutationKinds).toContain("move");
  });

  it("returns excluded for non-markdown files", async () => {
    const file = makeFile("Diagram.canvas");
    const app = makeApp();
    const preview = await previewReconciliationForFile(app, file, baseSettings);
    expect(preview.outcome).toBe("excluded");
  });

  it("returns skipped when destination already exists and policy is skip", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({
      frontmatter: { type: "meeting" },
      existingPaths: ["Meetings/note.md"],
    });
    const settings: PreviewSettings = {
      ...baseSettings,
      collisionPolicy: "skip",
      rules: [{
        id: "move-meeting",
        name: "Move meeting",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "frontmatterValue", property: "type", value: "meeting" },
        then: { moveTo: "Meetings/" },
      }],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("skipped");
    expect(preview.message).toContain("already exists");
  });

  it("reports protected destinations as preview errors", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp();
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{ id: "unsafe", name: "Unsafe", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: ".obsidian/note.md" }, stopOnMatch: true }],
    };

    const plan = await planReconciliationForFile(app, file, settings);

    expect(plan.preview.outcome).toBe("error");
    expect(plan.preview.message).toContain("protected folder");
    expect(plan.result).toBeNull();
  });

  it("reports extension-changing destinations as preview errors", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp();
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{ id: "unsafe", name: "Unsafe", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "Inbox/**" }, then: { moveTo: "Archive/note.txt" }, stopOnMatch: true }],
    };

    const plan = await planReconciliationForFile(app, file, settings);

    expect(plan.preview.outcome).toBe("error");
    expect(plan.preview.message).toContain("changes file extension");
    expect(plan.result).toBeNull();
  });

  it("returns cycle-detected for a cycling rule set", async () => {
    const file = makeFile("A/note.md");
    const app = makeApp();
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [
        { id: "b-to-c", name: "B to C", enabled: true, priority: 0, order: 0, when: { type: "pathGlob", glob: "B/*" }, then: { moveTo: "C/" } },
        { id: "a-to-b", name: "A to B", enabled: true, priority: 1, order: 1, when: { type: "pathGlob", glob: "A/*" }, then: { moveTo: "B/" } },
        { id: "c-to-a", name: "C to A", enabled: true, priority: 2, order: 2, when: { type: "pathGlob", glob: "C/*" }, then: { moveTo: "A/" } },
      ],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("cycle-detected");
  });
});

// ---------------------------------------------------------------------------
// Exclusion checks
// ---------------------------------------------------------------------------

describe("previewReconciliationForFile — exclusionPatterns", () => {
  it("returns excluded when file path matches an exclusion pattern", async () => {
    const file = makeFile("Templates/daily.md");
    const app = makeApp();
    const settings: PreviewSettings = {
      ...baseSettings,
      exclusionPatterns: ["Templates/**"],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("excluded");
    expect(preview.message).toContain("exclusion pattern");
  });

  it("does not exclude when path does not match any pattern", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp();
    const settings: PreviewSettings = {
      ...baseSettings,
      exclusionPatterns: ["Templates/**"],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("unchanged");
  });

  it("returns excluded for exact folder match", async () => {
    const file = makeFile("Archive/old-note.md");
    const app = makeApp();
    const settings: PreviewSettings = {
      ...baseSettings,
      exclusionPatterns: ["Archive/**"],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("excluded");
  });

  it("exclusion takes priority over matching rules", async () => {
    const file = makeFile("Templates/meeting.md");
    const app = makeApp({ frontmatter: { type: "meeting" } });
    const settings: PreviewSettings = {
      ...baseSettings,
      exclusionPatterns: ["Templates/**"],
      rules: [{
        id: "move-meeting",
        name: "Move meeting",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "frontmatterValue", property: "type", value: "meeting" },
        then: { moveTo: "Meetings/" },
      }],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("excluded");
  });
});

// ---------------------------------------------------------------------------
// Per-file disable frontmatter key
// ---------------------------------------------------------------------------

describe("previewReconciliationForFile — disableFrontmatterKey", () => {
  it("returns excluded when disable key is true (boolean)", async () => {
    const file = makeFile("Inbox/pinned.md");
    const app = makeApp({ frontmatter: { "vault-flow-disable": true } });
    const preview = await previewReconciliationForFile(app, file, baseSettings);
    expect(preview.outcome).toBe("excluded");
    expect(preview.message).toContain("vault-flow-disable");
  });

  it("returns excluded when disable key is 'true' (string)", async () => {
    const file = makeFile("Inbox/pinned.md");
    const app = makeApp({ frontmatter: { "vault-flow-disable": "true" } });
    const preview = await previewReconciliationForFile(app, file, baseSettings);
    expect(preview.outcome).toBe("excluded");
  });

  it("returns excluded when disable key is 'disable' (string)", async () => {
    const file = makeFile("Inbox/pinned.md");
    const app = makeApp({ frontmatter: { "vault-flow-disable": "disable" } });
    const preview = await previewReconciliationForFile(app, file, baseSettings);
    expect(preview.outcome).toBe("excluded");
  });

  it("does not exclude when disable key is false", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({ frontmatter: { "vault-flow-disable": false } });
    const preview = await previewReconciliationForFile(app, file, baseSettings);
    expect(preview.outcome).toBe("unchanged");
  });

  it("does not exclude when disable key is absent", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({ frontmatter: {} });
    const preview = await previewReconciliationForFile(app, file, baseSettings);
    expect(preview.outcome).toBe("unchanged");
  });

  it("respects a custom disable key name", async () => {
    const file = makeFile("Inbox/pinned.md");
    const app = makeApp({ frontmatter: { "no-touch": true } });
    const settings: PreviewSettings = { ...baseSettings, disableFrontmatterKey: "no-touch" };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("excluded");
  });

  it("disable key takes priority over exclusion patterns (both checked, order matters)", async () => {
    // disable-key is checked first, so it's reported as the disable-key reason
    const file = makeFile("Inbox/pinned.md");
    const app = makeApp({ frontmatter: { "vault-flow-disable": true } });
    const settings: PreviewSettings = {
      ...baseSettings,
      exclusionPatterns: ["Inbox/**"],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("excluded");
    // Message should reference the disable key since it's checked first
    expect(preview.message).toContain("vault-flow-disable");
  });
});

// ---------------------------------------------------------------------------
// contentContains — lazy loading
// ---------------------------------------------------------------------------

describe("previewReconciliationForFile — contentContains lazy loading", () => {
  it("matches contentContains when body is loaded", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({ bodyContent: "Some text with #project-alpha in it." });
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "content-tag",
        name: "Content tag",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "contentContains", text: "#project-alpha" },
        then: { addTags: ["project-alpha"] },
      }],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("changed");
    expect(preview.mutationKinds).toContain("frontmatter");
  });

  it("does not match contentContains when body lacks the text", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({ bodyContent: "Unrelated content." });
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "content-tag",
        name: "Content tag",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "contentContains", text: "#project-alpha" },
        then: { addTags: ["project-alpha"] },
      }],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.outcome).toBe("unchanged");
  });
});

// ---------------------------------------------------------------------------
// Preview result fields
// ---------------------------------------------------------------------------

describe("previewReconciliationForFile — result fields", () => {
  it("includes appliedRuleIds for matched rules", async () => {
    const file = makeFile("Inbox/note.md");
    const app = makeApp({ frontmatter: { type: "meeting" } });
    const settings: PreviewSettings = {
      ...baseSettings,
      rules: [{
        id: "move-meeting",
        name: "Move meeting",
        enabled: true,
        priority: 0,
        order: 0,
        when: { type: "frontmatterValue", property: "type", value: "meeting" },
        then: { moveTo: "Meetings/" },
      }],
    };
    const preview: DryRunPreview = await previewReconciliationForFile(app, file, settings);
    expect(preview.appliedRuleIds).toContain("move-meeting");
  });

  it("excluded preview has zero appliedRuleIds", async () => {
    const file = makeFile("Templates/note.md");
    const app = makeApp();
    const settings: PreviewSettings = {
      ...baseSettings,
      exclusionPatterns: ["Templates/**"],
    };
    const preview = await previewReconciliationForFile(app, file, settings);
    expect(preview.appliedRuleIds).toHaveLength(0);
    expect(preview.involvedRuleIds).toHaveLength(0);
  });
});
