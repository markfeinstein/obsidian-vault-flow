import obsidian from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: ["node_modules/**", "main.js", "coverage/**", "dist/**"],
  },
  ...obsidian.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "*.config.mjs", "esbuild.config.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.mts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];
