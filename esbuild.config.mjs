import esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import process from "node:process";

const production = process.argv[2] === "production";

const banner = `/*
Vault Flow

This file is generated from TypeScript source. Review source files under src/.

Bundled dependency: re2js (MIT)
${readFileSync(new URL("./node_modules/re2js/LICENSE", import.meta.url), "utf8")}
*/`;

const context = await esbuild.context({
  banner: {
    js: banner,
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map((moduleName) => `node:${moduleName}`),
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
