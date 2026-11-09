# Validation and release gates

## What the automated checks establish

Run `npm ci --ignore-scripts` and `npm run check`. This validates the complete installed peer graph and runs zero-warning ESLint, TypeScript, engine/adapter/UI-harness tests, version checks, browser/mobile dependency checks, and the committed production build. CI also audits dependencies and compares generated `main.js`, on Node 22.13.0 and Node 24.

Regression coverage includes:

- Lossless scalar/property-name editing, numeric validation, order preservation, and optimistic concurrent rule merges.
- Delayed metadata availability retaining startup sweep context, bounded read retries/backoff, and persistence of empty-tag deletion.
- Metadata-only exclusion without body reads, rules changing later predicates, negation, and equivalent traces.
- Retained active regex patterns, opt-in lookbehind, RE2Set equivalence/fallback, and lazy capture upgrades.
- Compact preview fingerprints rejecting edited bodies even if file statistics stay unchanged.
- Filtered/scoped bulk selection and all retained undo pages.
- Write-ahead ordering, quota/corruption/size failures, stale journal instances, restart pause, identity-guarded history recovery, and exact-file recovery inspection without implicit note creation.
- Bounded CLI inputs, asynchronous results, cancellation/deadline behavior, privacy of summaries, and fixture checks.
- Successful per-note sweep windows, threshold crossing after safe failures, and no success bookkeeping after uncertain mutations.
- Iterative depth/node/ruleset budgets across imports, settings load/reload, and direct engine calls, with original saved settings preserved.
- Selected-batch destination reservations, duplicate sources, case-folded collisions, refresh, and late occupancy rejection without unreviewed suffixes.
- Trigger-aware failed-work resolution, pagination, safe read-only replanning, separate recovery routing, and stopping a batch after uncertain mutation.
- UTF-8/count-bounded settings revisions, storage failures, malformed snapshots, concurrent save snapshots, cancellation, stale restore rejection, and paused configuration-only restore.

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

The driver validates the vault path and copied bundle hash, has a 90-second overall deadline, and never retries a mutation automatically. A timed-out mutation has an unknown outcome: inspect the exact synthetic note and report before starting again. Every attempted run consumes an exclusive fixture marker before any CLI access, even if it fails without an observable note change. Prepare a new fixture for each run; do not point it at an existing user vault.

It exercises registered asynchronous CLI handlers, synthetic rule fixtures, active-note diff expansion, filtered/grouped bulk selection, explicit apply and undo confirmations, public rename/link behavior, typed property writes, acknowledgment of completed pending-write records, native Base paths feeding bounded planning, custom Bases rendering, native settings navigation, and captured application errors.

The follow-up flow also verifies two notes sharing a destination receive distinct names **before** confirmation and arrive at those exact reviewed paths with their own bodies. It deliberately creates one new synthetic destination occupant after review, verifies apply skips instead of overwriting or silently renaming, and opens a fresh read-only preview through the failed-work inbox. Settings-history review is canceled once and then explicitly confirmed; the smoke verifies the unchanged baseline retains dry-run and stays paused until explicit resume. A separate native-window test verified an actual 500 → 750 → 500 timing change/restore on desktop 1.15.0; broader configuration/conflict coverage in the matrix remains required.

The mock-CLI harness tests command sequencing and guards only. Its successful report is not evidence that any of these flows work in an actual Obsidian host.

## Required application matrix

Selected flows have now been exercised in isolated **Obsidian 1.15.0 on macOS arm64**, including apply/undo, reviewed collisions, settings restore/external reload, journal failure, and interrupted-write restart. See the [dated desktop evidence and recovery inspection fix](desktop-validation-2026-11-09.md) for artifact identities, actual outcomes, and retained reports.

The original smoke report remains **partial** at its native-settings window assumption; that page was verified separately, not relabeled as a passing end-to-end smoke. The matrix below is still required: one desktop version and controlled fault injection do not establish minimum/current desktop, mobile, Sync, performance, or comprehensive recovery support. Record each scenario's version/platform, exact fixture, result, and retained report before extending runtime claims.

| Gate | Smallest useful next check |
| --- | --- |
| Minimum supported desktop (1.14.4) | Fresh generated vault: smoke flow, native settings/Bases/CLI registration, apply/undo/reload. |
| Current desktop (1.15.1 at review time) | Same smoke flow; verify asynchronous single/multi-note CLI responses and earlier workspace display with delayed indexing. |
| iOS and Android | Disposable synthetic vault: load plugin, edit rule, preview/apply/undo, content predicates, timing, and memory. Browser-compatible bundling alone is insufficient. |
| Sync/external settings | Two disposable devices: open editor, change another rule externally, save; then change the same rule and confirm conflict rejection. Capture revision history before invalid/new-schema reloads; do not overwrite incompatible settings. |
| Settings revisions | Change scalar types, ordering, scope, dry-run, and timing controls; restore an older revision through confirmation. Verify values return, runtime/recovery remain, and writes stay paused. Repeat with a concurrent editor/Sync change, quota failure, and plugin restart. Keep external writers quiescent during restore; the public API has no cross-process compare-and-swap. |
| Failed-work retry | Cross an age threshold, fail before mutation, then run a later sweep. Confirm retry is retained. Verify read/metadata/collision/stale failures appear with the correct trigger, a fresh inbox preview does not write, and uncertain mutations route to recovery rather than replay. |
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
- **Operator-approved deferral: ESLint 9.39.5 remains end-of-support.** A clean, supported ESLint 10 migration is blocked by published `eslint-plugin-import@2.32.0` (peer through 9), `@microsoft/eslint-plugin-sdl@1.1.0` (`^9`), and its pinned `eslint-plugin-react@7.37.3` (peer through 9). A trial with ESLint 10.14.0 and an import-x alias still produced invalid peers and introduced minimatch audit warnings; it was rolled back completely. Do not use force/legacy peer resolution, suppress the checks, or present the retained stack as supported. The operator chose to preserve the official Obsidian checks rather than maintain a local compatibility fork or drop guideline coverage. `verify:peers` now prevents silently accepting such an invalid graph; lint warnings fail checks. Revisit when **all** upstream peers support 10, or obtain explicit approval for a maintained fork. The retained lockfile audits cleanly.
- Keep Node type definitions on the supported Node 22 baseline. CI covers Node 22.13.0 and 24; a local check on Node 24 is not local Node 22 verification.
- Recommend a current desktop installer for upstream security fixes; do not automatically raise the plugin's API minimum or activate/update an installation.

Sources:

- [ESLint version support](https://eslint.org/version-support/)
- [Obsidian lint package](https://registry.npmjs.org/eslint-plugin-obsidianmd/latest), [import plugin peers](https://registry.npmjs.org/eslint-plugin-import/latest), [SDL peers](https://registry.npmjs.org/@microsoft/eslint-plugin-sdl/latest), and [React peers](https://registry.npmjs.org/eslint-plugin-react/7.37.3)
- [Obsidian API package](https://registry.npmjs.org/obsidian/latest)
- [RE2JS package](https://registry.npmjs.org/re2js/latest) and [2.9.1 capabilities](https://github.com/le0pard/re2js/blob/2.9.1/README.md)
- [Obsidian 1.15.1 changes](https://obsidian.md/changelog/2026-11-03-desktop-v1.15.1/)
- [Obsidian 1.14.5 installer/security changes](https://obsidian.md/changelog/2026-10-22-desktop-v1.14.5/)
- [Official CLI documentation](https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Obsidian%20CLI.md)

The CLI attaches to a running application. `base:query ... format=paths` is an external read-only selection source, not a headless query API available inside a plugin. Continue using public FileManager/frontmatter, Bases, declarative settings, and CLI registration APIs; do not replace them with private internals.
