import esbuild from "esbuild";

// Mobile Obsidian does not provide Node.js or Electron. Unlike the production
// build, this verification deliberately externalizes only the Obsidian API so
// accidental platform-specific imports fail resolution in CI.
await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  logLevel: "info",
  platform: "browser",
  target: "es2018",
  write: false,
});
