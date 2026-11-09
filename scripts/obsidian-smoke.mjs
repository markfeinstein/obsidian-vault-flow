import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markerName = ".vault-flow-smoke.json";
const deadlineMs = 90_000;

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (["--prepare", "--run", "--allow-runtime", "--help"].includes(key)) result[key] = true;
    else if (["--root", "--vault", "--cli", "--parent"].includes(key)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      result[key] = value;
    } else throw new Error(`Unknown option: ${key}`);
  }
  return result;
}

async function json(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function prepare(parent) {
  const base = await realpath(parent ? resolve(parent) : tmpdir());
  const root = await realpath(await mkdtemp(join(base, "vault-flow-smoke-")));
  const pluginDir = join(root, ".obsidian", "plugins", "vault-flow");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(join(root, "Inbox"));
  for (const file of ["main.js", "manifest.json", "styles.css"]) await copyFile(join(repository, file), join(pluginDir, file));
  const bundleSha256 = createHash("sha256").update(await readFile(join(pluginDir, "main.js"))).digest("hex");
  await json(join(root, markerName), { version: 2, id: randomUUID(), root, bundleSha256, createdAt: new Date().toISOString() });
  await json(join(root, ".obsidian", "community-plugins.json"), ["vault-flow"]);
  await json(join(root, ".obsidian", "core-plugins.json"), ["file-explorer", "global-search", "properties", "page-preview", "bases"]);
  await json(join(root, ".obsidian", "app.json"), { alwaysUpdateLinks: true });
  await json(join(pluginDir, "data.json"), {
    settingsVersion: 4, dryRun: true, collisionPolicy: "rename-with-suffix", sweepOnStartup: false, periodicSweepEnabled: false, monitoredFolders: ["Inbox"],
    rules: [
      { id: "shared", name: "Synthetic shared destination", enabled: true, priority: 0, order: 1, runOn: "manual", stopOnMatch: true,
        when: { type: "pathGlob", glob: "Inbox/Batch*.md" }, then: { moveTo: "Archive/Shared.md", moveToKind: "file", setProperties: { status: "done" } } },
      { id: "stale", name: "Synthetic late collision", enabled: true, priority: 0, order: 2, runOn: "manual", stopOnMatch: true,
        when: { type: "pathGlob", glob: "Inbox/Stale.md" }, then: { moveTo: "Archive/Contended.md", moveToKind: "file", setProperties: { status: "done" } } },
      { id: "smoke", name: "Synthetic smoke test", enabled: true, priority: 0, order: 0, runOn: "manual", stopOnMatch: true,
      when: { type: "pathGlob", glob: "Inbox/Example.md" },
      then: { moveTo: "Archive/Client.v2", moveToKind: "folder", setProperties: { status: "done", approved: false, count: 0 } },
      fixtures: [{ name: "Synthetic fixture", note: { path: "Inbox/Example.md", frontmatter: { status: "draft" } },
        expected: { path: "Archive/Client.v2/Example.md", frontmatter: { status: "done", approved: false, count: 0 }, status: "converged", changed: true } }] }],
  });
  await writeFile(join(root, "Inbox", "Example.md"), "---\nstatus: draft\ntags:\n  - smoke\n---\n# Synthetic example\n\nOnly generated test content belongs in this vault.\n", { flag: "wx" });
  for (const [name, title] of [["BatchA", "Synthetic batch A"], ["BatchB", "Synthetic batch B"], ["Stale", "Synthetic stale preview"]]) {
    await writeFile(join(root, "Inbox", `${name}.md`), `---\nstatus: draft\n---\n# ${title}\n`, { flag: "wx" });
  }
  await writeFile(join(root, "Reference.md"), "# Synthetic reference\n\n[[Inbox/Example]]\n", { flag: "wx" });
  await json(join(root, "Smoke.base"), {
    filters: { and: ['file.ext == "md"', 'file.inFolder("Inbox")'] },
    formulas: { destination: '"Archive/Client.v2"' },
    views: [
      { type: "vault-flow-plan", name: "Vault Flow", mode: "rules", pageSize: 25, destinationProperty: "formula.destination" },
      { type: "table", name: "Native table", order: ["file.name", "note.status", "formula.destination"] },
    ],
  });
  console.log(JSON.stringify({ root, prepared: true, bundleSha256, next: "Open this generated vault in Obsidian manually. Inspect/trust only this test vault, then run the documented --run command with its exact vault ID and the official CLI path." }, null, 2));
}

async function validateRoot(input) {
  if (!input || !isAbsolute(input)) throw new Error("--root must be the absolute generated fixture path.");
  const root = resolve(input);
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) throw new Error("The fixture root must be canonical and must not be a symlink.");
  const markerPath = join(root, markerName);
  if (!(await lstat(markerPath)).isFile() || (await lstat(markerPath)).isSymbolicLink()) throw new Error("Missing regular fixture marker.");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker.version !== 2 || marker.root !== root || typeof marker.id !== "string") throw new Error("Fixture marker does not match this exact root.");
  // Do not execute a plugin copied elsewhere or modified after preparation.
  for (const relative of [".obsidian", ".obsidian/plugins", ".obsidian/plugins/vault-flow", ".obsidian/plugins/vault-flow/main.js", "Inbox", "Inbox/Example.md", "Inbox/BatchA.md", "Inbox/BatchB.md", "Inbox/Stale.md", "Reference.md", "Smoke.base"]) {
    if ((await realpath(join(root, relative))) !== join(root, relative)) throw new Error(`Symlink target rejected: ${relative}`);
  }
  const digest = createHash("sha256").update(await readFile(join(root, ".obsidian/plugins/vault-flow/main.js"))).digest("hex");
  if (digest !== marker.bundleSha256) throw new Error("The fixture bundle changed. Prepare a fresh fixture.");
  if (!(await readFile(join(root, "Inbox/Example.md"), "utf8")).includes("status: draft")) throw new Error("The fixture is not in its initial state. Prepare a fresh fixture.");
  return root;
}

async function run(config) {
  if (!config["--allow-runtime"]) throw new Error("Runtime access requires --allow-runtime. This may launch Obsidian and writes only to the verified generated test vault.");
  if (!config["--vault"] || !config["--cli"] || !isAbsolute(config["--cli"])) throw new Error("Pass --vault=<name/id> as two arguments (--vault ID), and --cli with the absolute official CLI path.");
  const root = await validateRoot(config["--root"]);
  const cli = config["--cli"];
  const selector = `vault=${config["--vault"]}`;
  const startedAt = Date.now();
  const report = { root, fixtureVersion: 2, platform: process.platform, architecture: process.arch, node: process.version, status: "partial", checks: [], commands: [], version: "", error: null };
  const reportPath = join(root, `.vault-flow-smoke-result-${Date.now()}.json`);

  function command(args) {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("Runtime smoke deadline exceeded; do not retry mutations automatically.");
    const result = spawnSync(cli, [selector, ...args], { encoding: "utf8", timeout: Math.min(10_000, remaining), maxBuffer: 2 * 1024 * 1024 });
    report.commands.push({ command: args[0], status: result.status, stderr: result.stderr ?? "" });
    if (result.error || result.status !== 0) throw new Error(`${args[0]} failed or timed out. A timed-out mutation has unknown outcome; inspect the fixture before retrying. ${result.error?.message ?? result.stderr ?? ""}`);
    const output = (result.stdout ?? "").trim();
    if (/^(?:Error:|Unknown command)/imu.test(output)) throw new Error(`${args[0]} returned an error: ${output}`);
    return output;
  }

  function commandJson(args) {
    const output = command(args);
    try { return JSON.parse(output); }
    catch { throw new Error(`${args[0]} did not return valid JSON.`); }
  }

  // Every eval checks the actual desktop vault path in the same invocation before
  // touching DOM or notes. No unscoped command or active-vault fallback is used.
  function evaluate(body) {
    const code = `(() => { if (app.vault.adapter.getBasePath() !== ${JSON.stringify(root)}) throw new Error("Smoke vault mismatch"); const doc = app.workspace.containerEl.ownerDocument; return "VF_SMOKE:" + JSON.stringify((() => { ${body} })()); })()`;
    let output = command(["eval", `code=${code}`]);
    try {
      const decoded = JSON.parse(output);
      if (typeof decoded === "string") output = decoded;
    } catch {
      // Some CLI versions print strings without JSON quoting.
    }
    const prefix = output.lastIndexOf("VF_SMOKE:");
    if (prefix < 0) throw new Error("CLI eval returned no smoke marker.");
    return JSON.parse(output.slice(prefix + "VF_SMOKE:".length));
  }

  async function waitFor(body, label) { return waitForRead(() => evaluate(body), label); }

  async function waitForRead(check, label) {
    const deadline = Math.min(startedAt + deadlineMs, Date.now() + 8_000);
    while (Date.now() < deadline) {
      if (check()) return;
      await delay(150);
    }
    throw new Error(`Timed out waiting for ${label}. No mutation is retried automatically.`);
  }

  function focusFixtureWindow() {
    const focused = evaluate("const view = doc.defaultView; view.dispatchEvent(new view.Event('focus')); doc.dispatchEvent(new view.Event('focusin', {bubbles:true})); doc.body?.dispatchEvent(new view.Event('pointerdown', {bubbles:true})); return typeof activeDocument === 'undefined' || doc === activeDocument;");
    if (!focused) throw new Error("The generated fixture window could not become Obsidian's active document.");
  }

  function clickButton(text) {
    evaluate(`const button = Array.from(doc.querySelectorAll(".modal-container button")).find(el => el.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error("Expected enabled confirmation button missing"); button.click(); return true;`);
  }

  function filterPreview(query) {
    evaluate(`const search = doc.querySelector('.modal-container input[aria-label="Filter preview paths"]'); if (!search) throw new Error("Preview filter missing"); search.value = ${JSON.stringify(query)}; search.dispatchEvent(new doc.defaultView.Event("input", {bubbles:true})); return true;`);
  }

  function reviewedDestinations() {
    return evaluate('return Array.from(doc.querySelectorAll(".modal-container .vf-preview-table tbody tr")).filter(row => row.querySelector("input[type=checkbox]")?.checked).map(row => { const cells = row.querySelectorAll(".vf-preview-path"); return {path: cells[0]?.textContent, destination: cells[1]?.textContent}; });');
  }

  function closeTopModal() {
    evaluate("const close = Array.from(doc.querySelectorAll('.modal-container .modal-header-button, .modal-container .modal-close-button')).at(-1); if (!close) throw new Error('Expected modal close control missing'); close.click(); return true;");
  }

  // Consume a fixture before any CLI access. Even an unchanged note after a
  // timeout is not evidence that replaying the attempted run would be safe.
  try { await json(join(root, ".vault-flow-smoke-attempt.json"), { root, startedAt: new Date(startedAt).toISOString() }); }
  catch { throw new Error("This fixture was already attempted or cannot retain an attempt marker. Prepare a fresh fixture; never retry an uncertain mutation."); }

  try {
    if (command(["vault", "info=path"]) !== root) throw new Error("CLI selector does not resolve to the exact generated fixture root.");
    report.version = command(["version"]);
    for (const name of ["open", "read", "create", "command", "eval", "base:query", "dev:errors", "dev:screenshot"]) {
      if (!command(["help", name])) throw new Error(`Empty help for ${name}`);
    }
    const enabled = command(["plugins:enabled", "filter=community"]);
    if (!enabled.includes("vault-flow")) throw new Error("Vault Flow is not enabled in the generated test vault. Inspect the test-vault trust/settings UI manually.");
    if (!command(["commands", "filter=vault-flow"]).includes("vault-flow:preview-vault")) throw new Error("Vault Flow commands were not registered.");
    report.checks.push("startup command registration");
    await waitFor('return ["Inbox/Example.md", "Inbox/BatchA.md", "Inbox/BatchB.md", "Inbox/Stale.md"].every(path => { const file = app.vault.getFileByPath(path); return file && app.metadataCache.getFileCache(file) !== null; });', "all synthetic fixture metadata");

    const cliStatus = commandJson(["vault-flow:status"]);
    if (cliStatus.status !== "ok" || cliStatus.dryRun !== true || cliStatus.paused !== false) throw new Error("Vault Flow CLI status returned an unexpected safety state.");
    const cliPlan = commandJson(["vault-flow:plan", "path=Inbox/Example.md", "trigger=manual"]);
    const serializedPlan = JSON.stringify(cliPlan);
    if (cliPlan.status !== "ok" || cliPlan.outcome !== "changed" || cliPlan.desiredPath !== "Archive/Client.v2/Example.md"
      || serializedPlan.includes("draft") || serializedPlan.includes("done") || serializedPlan.includes("Synthetic example")) {
      throw new Error("Vault Flow CLI plan was incorrect or exposed note/property values.");
    }
    const cliDiagnostics = commandJson(["vault-flow:diagnostics", "limit=5"]);
    if (cliDiagnostics.status !== "ok" || !Array.isArray(cliDiagnostics.decisions)) throw new Error("Vault Flow CLI diagnostics returned invalid JSON.");
    const cliMany = commandJson(["vault-flow:plan-many", 'paths=["Inbox/Example.md","Reference.md"]', "limit=2"]);
    if (cliMany.status !== "ok" || cliMany.count !== 2 || cliMany.plans[0]?.outcome !== "changed" || cliMany.plans[1]?.outcome !== "excluded") throw new Error("Bounded asynchronous multi-note CLI planning failed.");
    const fixtureResults = commandJson(["vault-flow:test-rule", "rule=smoke"]);
    if (fixtureResults.status !== "ok" || fixtureResults.count !== 1 || fixtureResults.results[0]?.passed !== true) throw new Error("Synthetic rule fixture failed.");
    report.checks.push("read-only CLI status, diagnostics, asynchronous bounded planning, and synthetic fixtures");

    command(["open", "path=Inbox/Example.md"]);
    focusFixtureWindow();
    command(["command", "id=vault-flow:preview-active-note"]);
    await waitFor('return !!doc.querySelector(".modal-container .vf-property-diff");', "active-note preview");
    evaluate('doc.querySelector(".modal-container .vf-property-diff").open = true; return true;');
    await waitFor('return !!doc.querySelector(".modal-container .vf-property-diff pre");', "property diff expansion");
    closeTopModal();
    report.checks.push("active-note preview and property details");

    command(["command", "id=vault-flow:preview-vault"]);
    await waitFor('return !!doc.querySelector(".modal-container input[aria-label=\\"Apply planned change for Inbox/Example.md\\"]");', "vault preview");
    evaluate('const search = doc.querySelector(".modal-container input[aria-label=\\"Filter preview paths\\"]"); search.value = "Inbox/Example"; search.dispatchEvent(new doc.defaultView.Event("input", {bubbles:true})); const group = doc.querySelector(".modal-container select[aria-label=\\"Grouping\\"]"); group.value = "folder"; group.dispatchEvent(new doc.defaultView.Event("change", {bubbles:true})); return true;');
    clickButton("Select filtered (batch limit)");
    await waitFor('return doc.querySelector(".modal-container input[aria-label=\\"Apply planned change for Inbox/Example.md\\"]")?.checked === true;', "filtered, grouped preview selection");
    clickButton("Apply selected");
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Apply changes");', "apply confirmation");
    clickButton("Apply changes");
    await waitFor('const file = app.vault.getFileByPath("Archive/Client.v2/Example.md"); const fm = file && app.metadataCache.getFileCache(file)?.frontmatter; return !!fm && fm.status === "done" && fm.approved === false && fm.count === 0;', "move and typed property update");
    await waitFor('return (app.metadataCache.resolvedLinks["Reference.md"]?.["Archive/Client.v2/Example.md"] ?? 0) > 0;', "Obsidian link updates");
    report.checks.push("preview apply, dotted destination, typed properties, link updates");

    command(["command", "id=vault-flow:show-undo-history"]);
    await waitFor('return !!doc.querySelector(".modal-container .vf-undo-button");', "undo history");
    evaluate('doc.querySelector(".modal-container .vf-undo-button").click(); return true;');
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Undo transaction(s)");', "undo confirmation");
    clickButton("Undo transaction(s)");
    await waitFor('const file = app.vault.getFileByPath("Inbox/Example.md"); const fm = file && app.metadataCache.getFileCache(file)?.frontmatter; return !!fm && fm.status === "draft" && !("approved" in fm) && !app.vault.getFileByPath("Archive/Client.v2/Example.md");', "transaction undo");
    closeTopModal();
    report.checks.push("confirmed undo restores original path and properties");
    command(["command", "id=vault-flow:inspect-write-recovery"]);
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container p")).some(el => el.textContent === "No pending writes.");', "empty recovery journal after committed apply/undo");
    closeTopModal();
    report.checks.push("completed apply and undo acknowledge device-local pending-write records");

    command(["command", "id=vault-flow:show-work-inbox"]);
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container p")).some(el => el.textContent.includes("No unresolved recent work."));', "empty failed-work inbox");
    closeTopModal();
    report.checks.push("failed-work inbox entry point and resolved-work filtering");

    command(["command", "id=vault-flow:preview-vault"]);
    await waitFor('return !!doc.querySelector(".modal-container input[aria-label=\\"Filter preview paths\\"]");', "batch collision preview");
    filterPreview("Inbox/Batch");
    clickButton("Select filtered (batch limit)");
    const reviewed = reviewedDestinations();
    if (reviewed.length !== 2 || !reviewed.some(row => row.path === "Inbox/BatchA.md") || !reviewed.some(row => row.path === "Inbox/BatchB.md")
      || reviewed.map(row => row.destination).sort().join("|") !== "Archive/Shared 1.md|Archive/Shared.md") throw new Error("Shared batch destinations were not reserved before confirmation.");
    clickButton("Refresh destinations");
    if (JSON.stringify(reviewedDestinations()) !== JSON.stringify(reviewed)) throw new Error("Unchanged destination refresh changed the reviewed batch reservation.");
    clickButton("Apply selected");
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Apply changes");', "reserved batch confirmation");
    clickButton("Apply changes");
    await waitFor(`return ${JSON.stringify(reviewed)}.every(row => { const file = app.vault.getFileByPath(row.destination); return file && !app.vault.getFileByPath(row.path) && app.metadataCache.getFileCache(file)?.frontmatter?.status === "done"; });`, "exact reviewed batch destinations");
    for (const row of reviewed) {
      const title = row.path === "Inbox/BatchA.md" ? "# Synthetic batch A" : "# Synthetic batch B";
      if (!command(["read", `path=${row.destination}`]).includes(title)) throw new Error("A batch note did not retain its own body at its reviewed destination.");
    }
    report.checks.push("shared batch destinations are reserved, refreshed, confirmed, and applied exactly");

    command(["command", "id=vault-flow:preview-vault"]);
    await waitFor('return !!doc.querySelector(".modal-container input[aria-label=\\"Filter preview paths\\"]");', "late collision preview");
    filterPreview("Inbox/Stale");
    clickButton("Select filtered (batch limit)");
    if (JSON.stringify(reviewedDestinations()) !== JSON.stringify([{ path: "Inbox/Stale.md", destination: "Archive/Contended.md" }])) throw new Error("Late-collision fixture did not review its original destination.");
    // This deliberate race writes only a new, synthetic note in the verified
    // fixture. Never repeat create/apply after a timeout or unknown outcome.
    command(["create", "path=Archive/Contended.md", "content=# Synthetic late occupant"]);
    clickButton("Apply selected");
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Apply changes");', "late collision confirmation");
    clickButton("Apply changes");
    await waitForRead(() => commandJson(["vault-flow:diagnostics", "limit=20"]).decisions?.some(row => row.path === "Inbox/Stale.md" && row.outcome === "skipped" && row.issueKind === "collision"), "recorded late collision");
    const preserved = evaluate('return !!app.vault.getFileByPath("Inbox/Stale.md") && !!app.vault.getFileByPath("Archive/Contended.md") && !app.vault.getFileByPath("Archive/Contended 1.md");');
    if (!preserved || !command(["read", "path=Archive/Contended.md"]).includes("# Synthetic late occupant")) throw new Error("A stale reviewed destination was overwritten or silently renamed.");
    command(["command", "id=vault-flow:show-work-inbox"]);
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container h4")).some(el => el.textContent === "collision: Inbox/Stale.md");', "actionable failed collision");
    clickButton("Replan and review");
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container .vf-preview-path")).some(el => el.textContent === "Archive/Contended 1.md");', "fresh inbox replan");
    if (evaluate('return !!app.vault.getFileByPath("Archive/Contended 1.md");')) throw new Error("Inbox replanning unexpectedly wrote a note.");
    closeTopModal();
    report.checks.push("late collision skips without renaming; inbox replans read-only for a new review");

    command(["command", "id=vault-flow:show-settings-history"]);
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Review restore");', "settings revision history");
    clickButton("Review restore");
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Restore settings; keep writes paused");', "settings restore review");
    closeTopModal();
    await waitFor('return !Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Restore settings; keep writes paused");', "settings restore cancellation");
    if (commandJson(["vault-flow:status"]).paused !== false) throw new Error("Canceling settings restore changed the pause state.");
    clickButton("Review restore");
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Restore settings; keep writes paused");', "confirmed settings restore review");
    clickButton("Restore settings; keep writes paused");
    await waitForRead(() => commandJson(["vault-flow:status"]).paused === true, "paused writes after settings restore");
    await waitFor('return Array.from(doc.querySelectorAll(".modal-container button")).some(el => el.textContent.trim() === "Review restore" && !el.disabled);', "completed settings restore");
    closeTopModal();
    if (commandJson(["vault-flow:status"]).dryRun !== true) throw new Error("Settings restore lost the fixture's dry-run default.");
    command(["command", "id=vault-flow:toggle-automation-pause"]);
    if (commandJson(["vault-flow:status"]).paused !== false) throw new Error("Settings restore did not permit explicit safe resume.");
    report.checks.push("settings revision review, cancellation, confirmed restore, and explicit resume");

    const query = command(["base:query", "path=Smoke.base", "view=Native table", "format=paths"]);
    if (!query.includes("Inbox/Example.md")) throw new Error("Native Base query did not return the expected fixture note.");
    const queriedPlans = commandJson(["vault-flow:plan-many", `paths=${query}`]);
    if (queriedPlans.status !== "ok" || !queriedPlans.plans.some(plan => plan.path === "Inbox/Example.md" && plan.outcome === "changed")) throw new Error("Native Base paths could not feed read-only multi-note planning.");
    command(["open", "path=Smoke.base"]);
    await waitFor('return !!doc.querySelector(".vf-bases-view .vf-bases-table");', "real custom Bases view");
    command(["dev:screenshot", `path=${join(root, ".vault-flow-smoke-screenshot.png")}`]);
    report.checks.push("native Base query and custom view rendering");

    focusFixtureWindow();
    command(["command", "id=app:open-settings"]);
    await waitFor('return Array.from(doc.querySelectorAll(".vertical-tab-nav-item")).some(el => el.textContent.trim() === "Vault Flow");', "native settings navigation");
    evaluate('Array.from(doc.querySelectorAll(".vertical-tab-nav-item")).find(el => el.textContent.trim() === "Vault Flow").click(); return true;');
    await waitFor('const content = doc.querySelector(".vertical-tab-content"); return !!content && content.textContent.includes("Automation") && content.textContent.includes("Rules");', "declarative plugin settings");
    closeTopModal();
    report.checks.push("native settings entry point and declarative page rendering");
    const errors = command(["dev:errors"]);
    if (errors && !/^no (?:captured )?(?:javascript )?errors\b/iu.test(errors)) throw new Error(`Captured application errors require review: ${errors}`);
    report.checks.push("no captured application errors");
    report.status = "passed";
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await json(reportPath, report);
    console.log(JSON.stringify({ reportPath, status: report.status, checks: report.checks }, null, 2));
  }
}

try {
  const config = options(process.argv.slice(2));
  if (config["--help"]) {
    console.log("Prepare only: node scripts/obsidian-smoke.mjs --prepare [--parent /canonical/temp/parent]\nRuntime (explicit opt-in): node scripts/obsidian-smoke.mjs --run --root /generated/root --vault VAULT_ID --cli /absolute/official/obsidian --allow-runtime\nNo automatic launch, registration, activation, integration, deployment, or cleanup occurs during --prepare. --run may launch Obsidian and changes only the verified synthetic vault. Open/trust that vault manually first. Fixture/report files are retained for inspection.");
  } else if (config["--prepare"] && !config["--run"]) await prepare(config["--parent"]);
  else if (config["--run"] && !config["--prepare"]) await run(config);
  else throw new Error("Choose exactly one of --prepare or --run. Use --help for the scope and prerequisites.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
