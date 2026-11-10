import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sanitizeVaultFlowSettings } from "../../src/obsidian/settings";
import { reconcileFileState } from "../../src/engine";

const parents: string[] = [];
const script = resolve("scripts/obsidian-smoke.mjs");
function prepare() {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), "vault-flow-smoke-test-"));
  parents.push(parent);
  const result = spawnSync(process.execPath, [script, "--prepare", "--parent", parent], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  const fixture = JSON.parse(result.stdout) as { root: string; bundleSha256: string };
  return { parent, ...fixture };
}

describe("isolated runtime harness (mock CLI, not Obsidian runtime verification)", () => {
  afterEach(() => {
    // Remove only temporary parents allocated by this test, never an operator vault.
    for (const parent of parents.splice(0)) rmSync(parent, { recursive: true });
  });

  it("prepares only generated notes, an exact marker, and a dry-run plugin configuration", () => {
    const fixture = prepare();
    expect(JSON.parse(readFileSync(join(fixture.root, ".vault-flow-smoke.json"), "utf8"))).toMatchObject({ root: fixture.root, bundleSha256: fixture.bundleSha256 });
    expect(JSON.parse(readFileSync(join(fixture.root, ".obsidian/plugins/vault-flow/data.json"), "utf8"))).toMatchObject({ dryRun: true, sweepOnStartup: false, settingsVersion: 4 });
    expect(readFileSync(join(fixture.root, "Inbox/Example.md"), "utf8")).toContain("status: draft");
    const raw: unknown = JSON.parse(readFileSync(join(fixture.root, ".obsidian/plugins/vault-flow/data.json"), "utf8"));
    const sanitized = sanitizeVaultFlowSettings(raw);
    expect(sanitized.ruleErrors ?? sanitized.regexErrors ?? sanitized.scopeErrors).toBeUndefined();
    for (const [name, destination] of [["BatchA", "Archive/Shared.md"], ["BatchB", "Archive/Shared.md"], ["Stale", "Archive/Contended.md"]]) {
      expect(readFileSync(join(fixture.root, "Inbox", `${name}.md`), "utf8")).toContain("status: draft");
      const result = reconcileFileState({ file: { path: `Inbox/${name}.md`, basename: name, extension: "md", tags: [], frontmatter: { status: "draft" } },
        rules: sanitized.settings.rules, options: { maxIterations: 10, triggerContext: "manual" } });
      expect(result).toMatchObject({ status: "converged", changed: true, desired: { path: destination, frontmatter: { status: "done" } } });
    }
  });

  it("refuses runtime access without opt-in, and refuses symlinked roots", () => {
    const fixture = prepare();
    const denied = spawnSync(process.execPath, [script, "--run", "--root", fixture.root], { encoding: "utf8", timeout: 5_000 });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain("--allow-runtime");
    const alias = join(fixture.parent, "alias");
    symlinkSync(fixture.root, alias);
    const symlinked = spawnSync(process.execPath, [script, "--run", "--root", alias, "--vault", "smoke", "--cli", process.execPath, "--allow-runtime"], { encoding: "utf8", timeout: 5_000 });
    expect(symlinked.status).toBe(1);
    expect(symlinked.stderr).toContain("must not be a symlink");
  });

  it("rejects relative and symlinked profile paths before consuming the fixture or accessing the CLI", () => {
    const fixture = prepare();
    const alias = join(fixture.parent, "profile-alias");
    symlinkSync(fixture.parent, alias);
    for (const profile of ["relative-profile", alias]) {
      const result = spawnSync(process.execPath, [script, "--run", "--root", fixture.root, "--vault", "smoke", "--cli", process.execPath, "--profile", profile, "--allow-runtime"], { encoding: "utf8", timeout: 5_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("canonical isolated application profile");
      expect(existsSync(join(fixture.root, ".vault-flow-smoke-attempt.json"))).toBe(false);
    }
  });

  it.each([false, true])("exercises guarded mock-CLI sequencing and JSON-quoted eval responses (profile=%s)", (withProfile) => {
    const fixture = prepare();
    const cli = join(fixture.parent, "mock-obsidian.mjs");
    const log = join(fixture.parent, "commands.jsonl");
    const statePath = join(fixture.parent, "state.json");
    writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
const args = process.argv.slice(2); const root = process.env.SMOKE_ROOT;
appendFileSync(process.env.SMOKE_LOG, JSON.stringify(args) + "\\n");
const command = args[1];
const state = existsSync(process.env.SMOKE_STATE) ? JSON.parse(readFileSync(process.env.SMOKE_STATE, "utf8")) : {example:0, preview:0, batch:false, occupied:false, skipped:false, paused:false, review:false, selected:false, filter:""};
const save = () => writeFileSync(process.env.SMOKE_STATE, JSON.stringify(state));
const button = (text) => ({ textContent: text, disabled: false, click() {
 if (text === "Apply changes") { if (state.preview === 1) state.example = 2; else if (state.preview === 2) state.batch = true; else state.skipped = true; }
 if (text === "Select filtered (batch limit)") { state.selected = true; if (state.preview === 1) state.example = 1; }
 if (text === "Undo transaction(s)") state.example = 0;
 if (text === "Review restore") state.review = true;
 if (text === "Restore settings; keep writes paused") { state.paused = true; state.review = false; }
 if (text === "Close") state.review = false;
 if (text === "Replan and review") state.filter = "Inbox/Stale";
 save();
} });
const destinations = () => state.filter.includes("Batch") ? [["Inbox/BatchA.md", "Archive/Shared.md"], ["Inbox/BatchB.md", "Archive/Shared 1.md"]] : [["Inbox/Stale.md", state.occupied ? "Archive/Contended 1.md" : "Archive/Contended.md"]];
const doc = {
 defaultView: { Event: class {}, dispatchEvent() {} }, body: { dispatchEvent() {} }, dispatchEvent() {},
 querySelectorAll(selector) {
  if (selector === ".vertical-tab-nav-item") return [button("Vault Flow")];
  if (selector.includes("modal-close-button")) return [button("Close")];
  if (selector === ".modal-container p") return [button("No pending writes."), button("No unresolved recent work.")];
  if (selector === ".modal-container h4") return [button("collision: Inbox/Stale.md")];
  if (selector === ".modal-container .vf-preview-path") return destinations().flatMap(paths => paths.map(button));
  if (selector === ".modal-container .vf-preview-table tbody tr") return destinations().map(paths => ({querySelector: () => ({checked:state.selected}), querySelectorAll: () => paths.map(button)}));
  const buttons = ["Select filtered (batch limit)", "Apply selected", "Refresh destinations", "Apply changes", "Undo transaction(s)", "Replan and review", "Review restore"];
  if (state.review) buttons.push("Restore settings; keep writes paused");
  return buttons.map(button);
 },
 querySelector(selector) {
  if (selector.includes("Filter preview paths")) return {get value() {return state.filter;}, set value(value) {state.filter = value; save();}, dispatchEvent() {}};
  return { textContent: "Automation Rules", open: false, checked: state.selected, click() {}, dispatchEvent() {} };
 }
};
const app = {
 vault: { adapter: { getBasePath: () => root }, getFileByPath: path => {
  const exists = path === "Inbox/Example.md" ? state.example !== 2 : path === "Archive/Client.v2/Example.md" ? state.example === 2
   : path === "Inbox/BatchA.md" || path === "Inbox/BatchB.md" ? !state.batch : path === "Archive/Shared.md" || path === "Archive/Shared 1.md" ? state.batch
   : path === "Inbox/Stale.md" || (path === "Archive/Contended.md" && state.occupied);
  return exists ? {path} : null;
 } },
 metadataCache: { getFileCache: file => ({ frontmatter: file.path.startsWith("Archive/") ? {status:"done", approved:false, count:0} : {status:"draft"} }), resolvedLinks: {"Reference.md": {"Archive/Client.v2/Example.md":1}} },
 workspace: { containerEl: { ownerDocument: doc } }
};
if (command === "command") {
 if (args.includes("id=vault-flow:preview-vault")) { state.preview++; state.selected = false; state.filter = ""; }
 if (args.includes("id=vault-flow:toggle-automation-pause")) state.paused = !state.paused;
 save();
}
else if (command === "create") {state.occupied = true; save(); console.log("Created synthetic occupant");}
else if (command === "read") console.log(args.includes("path=Archive/Contended.md") ? "# Synthetic late occupant" : args.includes("path=Archive/Shared.md") ? "# Synthetic batch A" : "# Synthetic batch B");
else if (command === "vault") console.log(root);
else if (command === "version") console.log("1.15.1 mock");
else if (command === "help") console.log("Mock help for " + args[2]);
else if (command === "plugins:enabled") console.log("vault-flow");
else if (command === "commands") console.log("vault-flow:preview-vault");
else if (command === "vault-flow:status") console.log(JSON.stringify({status:"ok", dryRun:true, paused:state.paused}));
else if (command === "vault-flow:plan") console.log(JSON.stringify({status:"ok", outcome:"changed", desiredPath:"Archive/Client.v2/Example.md", propertyChanges:["status","approved","count"]}));
else if (command === "vault-flow:plan-many") { const value = args.find(arg => arg.startsWith("paths=")).slice(6); const paths = value.startsWith("[") ? JSON.parse(value) : value.split("\\n"); console.log(JSON.stringify({status:"ok", count:paths.length, plans:paths.map(path => ({path, outcome:path === "Inbox/Example.md" ? "changed" : "excluded"}))})); }
else if (command === "vault-flow:test-rule") console.log(JSON.stringify({status:"ok", count:1, results:[{passed:true}]}));
else if (command === "vault-flow:diagnostics") console.log(JSON.stringify({status:"ok", decisions:state.skipped ? [{path:"Inbox/Stale.md", outcome:"skipped", issueKind:"collision"}] : []}));
else if (command === "base:query") console.log("Inbox/Example.md");
else if (command === "eval") { const code = args.find(arg => arg.startsWith("code=")).slice(5); console.log(JSON.stringify(vm.runInNewContext(code, {app, activeDocument:doc, require: () => ({app:{getPath:()=>process.env.SMOKE_PROFILE},getCurrentWindow:()=>({focus(){}})})}))); }
else if (command === "dev:errors") console.log("No errors");
`, { mode: 0o700 });
    const runArgs = [script, "--run", "--root", fixture.root, "--vault", "smoke", "--cli", cli, "--allow-runtime", ...(withProfile ? ["--profile", fixture.parent] : [])];
    const result = spawnSync(process.execPath, runArgs, {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, SMOKE_ROOT: fixture.root, SMOKE_LOG: log, SMOKE_STATE: statePath, SMOKE_PROFILE: fixture.parent },
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const receipt = JSON.parse(result.stdout) as { status: string; reportPath: string; checks: string[] };
    expect(receipt.status).toBe("passed");
    expect(receipt.checks).toContain("native settings entry point and declarative page rendering");
    expect(receipt.checks).toContain("read-only CLI status, diagnostics, asynchronous bounded planning, and synthetic fixtures");
    expect(receipt.checks).toContain("confirmed undo restores original path and properties");
    expect(receipt.checks).toContain("completed apply and undo acknowledge device-local pending-write records");
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.every((args) => args[0] === "vault=smoke")).toBe(true);
    expect(calls.filter((args) => args[1] === "eval").every((args) => args[2]?.includes("getBasePath() !=="))).toBe(true);
    if (withProfile) expect(calls.filter((args) => args[1] === "eval").every((args) => args[2]?.includes("getPath('userData')"))).toBe(true);
    expect(readFileSync(receipt.reportPath, "utf8")).toContain("1.15.1 mock");
    expect(receipt.checks).toContain("shared batch destinations are reserved, refreshed, confirmed, and applied exactly");
    expect(receipt.checks).toContain("late collision skips without renaming; inbox replans read-only for a new review");
    expect(receipt.checks).toContain("settings revision review, cancellation, confirmed restore, and explicit resume");
    expect(calls.filter((args) => args[1] === "create")).toHaveLength(1);
    const before = calls.length;
    const retry = spawnSync(process.execPath, runArgs, {
      encoding: "utf8", timeout: 5_000, env: { ...process.env, SMOKE_ROOT: fixture.root, SMOKE_LOG: log, SMOKE_STATE: statePath, SMOKE_PROFILE: fixture.parent },
    });
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain("already attempted");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(before);
    if (withProfile) {
      const rejected = prepare();
      const rejectedLog = join(rejected.parent, "rejected-commands.jsonl");
      const mismatch = spawnSync(process.execPath, [script, "--run", "--root", rejected.root, "--vault", "smoke", "--cli", cli, "--profile", rejected.parent, "--allow-runtime"], {
        encoding: "utf8", timeout: 5_000,
        env: { ...process.env, SMOKE_ROOT: rejected.root, SMOKE_LOG: rejectedLog, SMOKE_STATE: join(rejected.parent, "state.json"), SMOKE_PROFILE: "/different/profile" },
      });
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain("Smoke profile mismatch");
      const rejectedCalls = readFileSync(rejectedLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(rejectedCalls.some((args) => ["open", "command", "create"].includes(args[1]))).toBe(false);
    }
  }, 20_000);
});
