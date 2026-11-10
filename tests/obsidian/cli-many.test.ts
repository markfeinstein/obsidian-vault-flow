import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, type App, type CliData, type PluginManifest } from "obsidian";
import VaultFlowPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/obsidian/settings";
import { parseCliPaths, planCliPaths } from "../../src/obsidian/cli-many";

afterEach(() => { vi.useRealTimers(); });
describe("bounded CLI input and execution", () => {
  it("accepts JSON and newline lists, preserves spaces, and deduplicates paths", () => {
    expect(parseCliPaths({ paths: '["Inbox/Some note.md","Inbox/Some note.md"]' })).toEqual({ paths: ["Inbox/Some note.md"], trigger: "manual" });
    expect(parseCliPaths({ paths: "a.md\nb.md\n", trigger: "sweep" })).toEqual({ paths: ["a.md", "b.md"], trigger: "sweep" });
  });
  it.each<CliData>([{ paths: "a.md", limit: "201" }, { paths: "a.md", limit: "1x" }, { paths: "a.md", trigger: "always" },
    { paths: '["../note.md"]' }, { paths: '["/note.md"]' }, { paths: '["*.md"]' }, { paths: '["a.md",false]' }, { paths: "[invalid" },
    { paths: "" }, { paths: "a.md\nb.md", limit: "1" }, { paths: "x".repeat(65537) }])("rejects invalid or over-limit input", (params) => {
    expect(parseCliPaths(params)).toHaveProperty("error");
  });
  it("continues past per-note errors and returns summaries in input order", async () => {
    const output = await planCliPaths({ paths: "a.md\nb.md" }, async (path) => { if (path === "b.md") throw new Error("missing"); return { path, outcome: "unchanged" }; });
    expect(JSON.parse(output)).toMatchObject({ status: "ok", count: 2, plans: [{ path: "a.md", outcome: "unchanged" }, { status: "error", path: "b.md", message: "missing" }] });
  });
  it("stops launching paths on timeout without pretending an in-flight read can be aborted", async () => {
    vi.useFakeTimers(); const releases: Array<() => void> = [];
    const plan = vi.fn(async () => new Promise<void>((resolve) => { releases.push(resolve); }));
    const pending = planCliPaths({ paths: Array.from({ length: 10 }, (_, i) => i + ".md").join("\n") }, plan, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const output = JSON.parse(await pending) as { status: string; message: string };
    expect(output.status).toBe("error"); expect(output.message).toContain("deadline");
    expect(plan).toHaveBeenCalledTimes(4);
    for (const release of releases) release();
    await Promise.resolve(); await Promise.resolve();
    expect(plan).toHaveBeenCalledTimes(4);
  });
  it("rejects mixed-revision results and oversized outputs", async () => {
    expect(JSON.parse(await planCliPaths({ paths: "a.md" }, async () => ({}), { stillValid: () => false }))).toMatchObject({ status: "error" });
    expect(JSON.parse(await planCliPaths({ paths: "a.md" }, async () => ({ text: "x".repeat(1_048_576) })))).toMatchObject({ status: "error" });
  });
});

describe("registered Obsidian CLI entry points", () => {
  it("plans multiple notes asynchronously and runs fixtures without note writes", async () => {
    const target = new TFile(); Object.assign(target, { path: "note.md", basename: "note", extension: "md", stat: { ctime: 1, mtime: 2, size: 0 } });
    const read = vi.fn(async () => "private-body"); const write = vi.fn(), rename = vi.fn();
    const app = { vault: { configDir: ".obsidian", getFileByPath: (path: string) => path === "note.md" ? target : null, cachedRead: read },
      metadataCache: { getFileCache: () => ({ frontmatter: { private: "private-value" } }) }, fileManager: { processFrontMatter: write, renameFile: rename } } as unknown as App;
    const plugin = new VaultFlowPlugin(app, {} as PluginManifest);
    plugin.settings = { ...DEFAULT_SETTINGS, rules: [{ id: "test", name: "Test", enabled: true, priority: 0, order: 0, when: { type: "contentContains", text: "private-body" }, then: { setProperties: { approved: true } },
      fixtures: [{ name: "Synthetic", note: { path: "synthetic.md", body: "private-body" }, expected: { frontmatter: { approved: true } } }] }] };
    const calls: Parameters<VaultFlowPlugin["registerCliHandler"]>[] = [];
    vi.spyOn(plugin, "registerCliHandler").mockImplementation((...args) => { calls.push(args); });
    const runtime = plugin as unknown as { loaded: boolean; registerCliHandlers(): void };
    runtime.loaded = true; runtime.registerCliHandlers();
    const many = calls.find(([name]) => name === "vault-flow:plan-many")?.[3];
    const test = calls.find(([name]) => name === "vault-flow:test-rule")?.[3];
    if (many === undefined || test === undefined) throw new Error("Missing handlers");
    const output = await many({ paths: "note.md\nmissing.md" });
    expect(typeof output).toBe("string");
    expect(JSON.parse(String(output))).toMatchObject({ status: "ok", plans: [{ outcome: "changed", propertyChanges: ["approved"] }, { status: "error", path: "missing.md" }] });
    expect(String(output)).not.toContain("private-body"); expect(String(output)).not.toContain("private-value");
    const count = read.mock.calls.length;
    expect(JSON.parse(String(await test({ rule: "test" })))).toMatchObject({ status: "ok", count: 1 });
    expect(read).toHaveBeenCalledTimes(count);
    expect(write).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
  });
});
