import { build } from "esbuild";
import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = await build({ entryPoints: [resolve(root, "src/engine/reconcile.ts")], bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
// eslint-disable-next-line no-unsanitized/method -- Runs only esbuild output from the fixed, local engine entry point above.
const { reconcileFileState } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const body = ("Ordinary synthetic Markdown prose with words and numbers 12345.\n").repeat(400);
const scenarios = [
  { name: "literal misses", pattern: (i) => "unmatchedLiteral" + i },
  { name: "word-boundary misses", pattern: (i) => "\\b(?:missing" + i + "|absent" + i + ")\\b" },
  { name: "mixed character classes", pattern: (i) => "(?:missing" + i + ")[a-z0-9_-]{1,16}\\b" },
];
const results = [];
for (const scenario of scenarios) {
  const rules = Array.from({ length: 80 }, (_, i) => ({ id: String(i), name: String(i), enabled: true, priority: i, order: i, when: { type: "contentRegex", pattern: scenario.pattern(i) }, then: { setProperties: { matched: true } } }));
  const file = { path: "Inbox/synthetic.md", basename: "synthetic", extension: "md", frontmatter: {}, tags: [], bodyContent: body };
  const time = (useRegexSet) => {
    const run = () => reconcileFileState({ file, rules, options: { maxIterations: 10, useRegexSet } });
    run(); // Warm compilation and execution caches outside the timed interval.
    const samples = [];
    for (let round = 0; round < 5; round++) {
      const started = performance.now();
      for (let i = 0; i < 20; i++) run();
      samples.push(performance.now() - started);
    }
    return Number(samples.sort((a, b) => a - b)[2].toFixed(2));
  };
  const individualMs = time(false), batchedMs = time(true);
  results.push({ scenario: scenario.name, patterns: 80, bodyBytes: Buffer.byteLength(body), iterations: 20, individualMs, batchedMs, ratioBatchedToIndividual: Number((batchedMs / individualMs).toFixed(2)) });
}
console.log(JSON.stringify({ note: "Synthetic headless measurements, not Obsidian/mobile runtime evidence. Lower times are better; keep batching off unless representative workloads benefit.", results }, null, 2));
