import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/obsidian-smoke.mjs", import.meta.url));
describe("desktop smoke opt-in guards (no Obsidian runtime)", () => {
  it("documents exact-scope prerequisites without launching the application", () => {
    const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 2_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--allow-runtime");
    expect(result.stdout).toContain("No automatic launch");
  });
  it("rejects runtime requests before touching a vault without explicit opt-in", () => {
    const result = spawnSync(process.execPath, [script, "--run"], { encoding: "utf8", timeout: 2_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Runtime access requires --allow-runtime");
  });
  it("rejects ambiguous preparation/runtime modes", () => {
    const result = spawnSync(process.execPath, [script, "--prepare", "--run"], { encoding: "utf8", timeout: 2_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Choose exactly one");
  });
});
