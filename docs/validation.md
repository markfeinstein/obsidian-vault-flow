# Validation and release gates

## What the automated checks establish

Run `npm ci --ignore-scripts` and `npm run check`. This runs ESLint, TypeScript, engine/adapter/UI-harness tests, version checks, browser/mobile dependency checks, and the committed production build. CI also audits dependencies and compares generated `main.js`, on Node 22.13.0 and Node 24.

Regression coverage includes:

- Lossless scalar/property-name editing, numeric validation, order preservation, and optimistic concurrent rule merges.
- Delayed metadata availability retaining startup sweep context, bounded read retries/backoff, and persistence of empty-tag deletion.
- Metadata-only exclusion without body reads, rules changing later predicates, negation, and equivalent traces.
- Retained active regex patterns, opt-in lookbehind, RE2Set equivalence/fallback, and lazy capture upgrades.
- Compact preview fingerprints rejecting edited bodies even if file statistics stay unchanged.
- Filtered/scoped bulk selection and all retained undo pages.
- Write-ahead ordering, quota/corruption/size failures, stale journal instances, restart pause, and identity-guarded history recovery.
- Bounded CLI inputs, asynchronous results, cancellation/deadline behavior, privacy of summaries, and fixture checks.

These are source/headless checks with an Obsidian shim, not confirmation of real application behavior, crash durability, physical-device compatibility, or large-vault memory usage.

`npm run bench:regex` measures the actual bundled engine in memory with synthetic 80-pattern workloads. It does not alter a vault. Compare representative rules before enabling batching; warm synthetic measurements do not establish mobile or real-vault speedups.

## Opt-in real desktop smoke driver

The driver only targets a freshly generated fixture vault and retains all fixture/report files for inspection. Preparing it does not launch or register a vault, change an installed plugin, or touch a real vault.

1. Run `npm run check`.
2. Run `npm run test:obsidian:prepare` to obtain the exact generated root.
3. Manually open that root in Obsidian, inspect/trust the synthetic plugin, and obtain the exact vault ID plus the absolute path to the official CLI.
4. With explicit runtime authorization, run:

   ```sh
   npm run test:obsidian -- --root /exact/generated/root --vault EXACT_ID --cli /absolute/official/obsidian --allow-runtime
   ```

The driver validates the vault path and copied bundle hash, has a 90-second overall deadline, and never retries a mutation automatically. A timed-out mutation has an unknown outcome: inspect the exact synthetic note and report before starting again. Prepare a new fixture for each run; do not point it at an existing user vault.

It exercises registered asynchronous CLI handlers, synthetic rule fixtures, active-note diff expansion, filtered/grouped bulk selection, explicit apply and undo confirmations, public rename/link behavior, typed property writes, acknowledgment of completed pending-write records, native Base paths feeding bounded planning, custom Bases rendering, native settings navigation, and captured application errors.

## Required application matrix

The changes in this review-remediation series have **not** been run in a real Obsidian instance. Record each scenario's version/platform, exact fixture, result, and retained report before claiming runtime validation.

| Gate | Smallest useful next check |
| --- | --- |
| Minimum supported desktop (1.14.4) | Fresh generated vault: smoke flow, native settings/Bases/CLI registration, apply/undo/reload. |
| Current desktop (1.15.1 at review time) | Same smoke flow; verify asynchronous single/multi-note CLI responses and earlier workspace display with delayed indexing. |
| iOS and Android | Disposable synthetic vault: load plugin, edit rule, preview/apply/undo, content predicates, timing, and memory. Browser-compatible bundling alone is insufficient. |
| Sync/external settings | Two disposable devices: open editor, change another rule externally, save; then change the same rule and confirm conflict rejection. |
| Pop-out windows/accessibility | Use actual owner-document settings, search/group controls, confirmations, keyboard/screen-reader navigation, and focus restoration. |
| Large vault | Synthetic 1k/10k-note sets with large bodies: measure reads, peak memory, planning latency, cancellation, and retained frontmatter cost with batching off/on. |
| Interrupted writes | In an isolated test application only, interrupt around first rename/property write/history persistence. Verify startup pause, retained snapshots, no automatic rollback, identity-guarded recovery, and preservation of newer edits. Do not kill an application hosting real vaults. |
| Storage failure | Disposable vault: simulate device-local quota/read failures, prove note writes do not start without a saved pending record, and preserve/export unsupported records before manual repair. |
| External files/collisions | Confirm external-file notes remain excluded; test shared destinations, folder races, protected configuration paths, and collision policies. |

Pending-write storage is device-local, bounded, and synchronous at the public API boundary, not an fsync/power-loss guarantee or cross-device backup. Unknown outcomes require inspection; incomplete snapshots are never treated as proof of an undoable completed write.

## API/dependency decisions (reviewed 2026-11-09)

- Keep Obsidian API types 1.14.4 / minimum app 1.14.4 and RE2JS 2.9.1: no newer published dependency was found. New regex extensions are explicitly opt-in.
- Update the typescript-eslint parser/plugin/umbrella graph together to 8.72.2. The umbrella package is an exact-version dependency of the Obsidian lint plugin; updating only the two direct packages can fail peer resolution.
- Retain TypeScript 5.9.3: typescript-eslint declares `>=4.8.4 <6.1.0`; latest TypeScript 7 is outside that range.
- Retain ESLint 9.39.5: the installed `eslint-plugin-import@2.32.0` peer range stops at ESLint 9, even though other parts of the lint stack support 10.
- Keep Node type definitions on the supported Node 22 baseline. CI covers Node 22.13.0 and 24; a local check on Node 24 is not local Node 22 verification.
- Recommend a current desktop installer for upstream security fixes; do not automatically raise the plugin's API minimum or activate/update an installation.

Sources:

- [Obsidian API package](https://registry.npmjs.org/obsidian/latest)
- [RE2JS package](https://registry.npmjs.org/re2js/latest) and [2.9.1 capabilities](https://github.com/le0pard/re2js/blob/2.9.1/README.md)
- [Obsidian 1.15.1 changes](https://obsidian.md/changelog/2026-11-03-desktop-v1.15.1/)
- [Obsidian 1.14.5 installer/security changes](https://obsidian.md/changelog/2026-10-22-desktop-v1.14.5/)
- [Official CLI documentation](https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Obsidian%20CLI.md)

The CLI attaches to a running application. `base:query ... format=paths` is an external read-only selection source, not a headless query API available inside a plugin. Continue using public FileManager/frontmatter, Bases, declarative settings, and CLI registration APIs; do not replace them with private internals.
