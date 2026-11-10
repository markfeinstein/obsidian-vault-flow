import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

// Source contracts supplement actionlint's YAML validation; they do not execute GitHub Actions.
function job(id: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${id}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

const scan = job("secret-scan");
const release = job("release");
const command = /^ {8}run: (gitleaks git .+)$/m.exec(scan)?.[1];

describe("release secret-scan prerequisite", () => {
  it("blocks publishing unless the separate scan job succeeds", () => {
    expect(release).toMatch(/^ {4}needs: secret-scan$/m);
    expect(release).not.toMatch(/^ {4}if:/m);
    expect(scan).not.toMatch(/^ {4}if:/m);
    expect(workflow).not.toContain("continue-on-error:");
    expect(workflow).not.toMatch(/if:.*(?:always\(|!cancelled\()/);
    expect(release).toContain("gh release create");
  });

  it("keeps scanner credentials read-only and publishing credentials separate", () => {
    expect(scan).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(scan).not.toMatch(/contents: write|GH_TOKEN:/);
    expect(release).toMatch(/^ {4}permissions:\n {6}contents: write$/m);
    expect(scan).toContain('GITLEAKS_ENABLE_COMMENTS: "false"');
    expect(scan).toContain('GITLEAKS_ENABLE_UPLOAD_ARTIFACT: "false"');
  });

  it("checks out the exact event commit with complete history and no saved credentials", () => {
    for (const block of [scan, release]) {
      expect(block).toContain("ref: ${{ github.sha }}");
      expect(block).toContain("persist-credentials: false");
    }
    expect(scan).toContain("fetch-depth: 0");
  });

  it("pins scanner preparation and scans all lineages independently of an empty tag payload", () => {
    expect(scan).toContain("gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e");
    expect(scan).toContain('GITLEAKS_VERSION: "8.30.1"');
    expect(command).toBe('gitleaks git --log-opts="--all --full-history" --redact=100 --timeout=300');
    expect(scan).not.toContain("github.event.commits");
    expect(scan.indexOf("gitleaks/gitleaks-action@")).toBeLessThan(scan.indexOf("run: gitleaks git"));
  });

  // GitHub-hosted ubuntu-latest uses Bash. Exercise the actual workflow command
  // with a fake scanner: no network, GitHub API, credentials or real secrets.
  it.skipIf(process.platform === "win32").each([0, 1, 2])("propagates scanner exit status %i", (exitCode) => {
    expect(command).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "vault-flow-release-scan-"));
    const argsPath = join(root, "args.json");
    try {
      const scanner = join(root, "gitleaks");
      writeFileSync(scanner, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`);
      chmodSync(scanner, 0o700);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command!], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
        timeout: 2_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exitCode);
      expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
        "git", "--log-opts=--all --full-history", "--redact=100", "--timeout=300",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
