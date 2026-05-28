import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    expect(JSON.parse(readFileSync(join(fixture.root, ".obsidian/plugins/vault-flow/data.json"), "utf8"))).toMatchObject({ dryRun: true, sweepOnStartup: false, settingsVersion: 3 });
    expect(readFileSync(join(fixture.root, "Inbox/Example.md"), "utf8")).toContain("status: draft");
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

  it("exercises guarded command sequencing and parses JSON-quoted eval responses using a mock CLI", () => {
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
let stage = existsSync(process.env.SMOKE_STATE) ? JSON.parse(readFileSync(process.env.SMOKE_STATE, "utf8")) : 0;
const save = () => writeFileSync(process.env.SMOKE_STATE, JSON.stringify(stage));
const button = (text) => ({ textContent: text, disabled: false, click() { if (text === "Apply changes") { stage = 2; save(); } } });
const doc = {
 defaultView: { Event: class {}, dispatchEvent() {} }, body: { dispatchEvent() {} }, dispatchEvent() {},
 querySelectorAll(selector) { return selector === ".vertical-tab-nav-item" ? [button("Vault Flow")] : [button("Apply selected"), button("Apply changes")]; },
 querySelector(selector) { return { textContent: "Automation Rules", open: false, click() { if (selector.includes("vf-undo-button")) { stage = 0; save(); } }, dispatchEvent() {} }; }
};
const app = {
 vault: { adapter: { getBasePath: () => root }, getFileByPath: path => stage === 2 ? (path.startsWith("Archive/") ? {path} : null) : (path === "Inbox/Example.md" ? {path} : null) },
 metadataCache: { getFileCache: () => ({ frontmatter: stage === 2 ? {status:"done", approved:false, count:0} : {status:"draft"} }), resolvedLinks: {"Reference.md": {"Archive/Client.v2/Example.md":1}} },
 workspace: { containerEl: { ownerDocument: doc } }
};
if (command === "vault") console.log(root);
else if (command === "version") console.log("1.15.0 mock");
else if (command === "help") console.log("Mock help for " + args[2]);
else if (command === "plugins:enabled") console.log("vault-flow");
else if (command === "commands") console.log("vault-flow:preview-vault");
else if (command === "vault-flow:status") console.log(JSON.stringify({status:"ok", dryRun:true, paused:false}));
else if (command === "vault-flow:plan") console.log(JSON.stringify({status:"ok", outcome:"changed", desiredPath:"Archive/Client.v2/Example.md", propertyChanges:["status","approved","count"]}));
else if (command === "vault-flow:diagnostics") console.log(JSON.stringify({status:"ok", decisions:[]}));
else if (command === "base:query") console.log("Inbox/Example.md");
else if (command === "eval") { const code = args.find(arg => arg.startsWith("code=")).slice(5); console.log(JSON.stringify(vm.runInNewContext(code, {app, activeDocument:doc}))); }
else if (command === "dev:errors") console.log("No errors");
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [script, "--run", "--root", fixture.root, "--vault", "smoke", "--cli", cli, "--allow-runtime"], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, SMOKE_ROOT: fixture.root, SMOKE_LOG: log, SMOKE_STATE: statePath },
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const receipt = JSON.parse(result.stdout) as { status: string; reportPath: string; checks: string[] };
    expect(receipt.status).toBe("passed");
    expect(receipt.checks).toContain("native settings entry point and declarative page rendering");
    expect(receipt.checks).toContain("read-only CLI status, diagnostics, and bounded plan");
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.every((args) => args[0] === "vault=smoke")).toBe(true);
    expect(calls.filter((args) => args[1] === "eval").every((args) => args[2]?.includes("getBasePath() !=="))).toBe(true);
    expect(readFileSync(receipt.reportPath, "utf8")).toContain("1.15.0 mock");
  }, 20_000);
});
