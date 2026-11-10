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
3. Open that root in a **separate temporary application profile**, registering no real vaults. Launch the test application with `--user-data-dir=/canonical/isolated/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=0`. Inspect/trust only the generated plugin and enable the CLI only in that profile; skip PATH registration. Obtain the exact vault ID and absolute official CLI path for that application version. Coordinate other instances first: the native CLI socket is shared even with separate profiles.
4. With explicit runtime authorization, run:

   ```sh
   npm run test:obsidian -- --root /exact/generated/root --vault EXACT_ID --cli /absolute/official/obsidian --profile /canonical/isolated/profile --allow-runtime
   ```

The driver validates the vault path and copied bundle hash. With `--profile`, it also checks the exact application profile before every eval; relative/symlinked profile paths are rejected before CLI access. It reads the profile's `DevToolsActivePort` for native Settings, accepts only the exact loopback endpoint and a unique matching renderer, rechecks the main profile/vault before each Settings operation, and captures that owned window separately. It supports both main-document settings and the newer separate native window without choosing an arbitrary active window. It has a 90-second overall deadline, and never retries a mutation automatically. A timed-out mutation has an unknown outcome: inspect the exact synthetic note and report before starting again. Every attempted run consumes an exclusive fixture marker before any CLI access, even if it fails without an observable note change. Prepare a new fixture for each run; do not point it at an existing user vault.

It exercises registered asynchronous CLI handlers, synthetic rule fixtures, active-note diff expansion, filtered/grouped bulk selection, explicit apply and undo confirmations, public rename/link behavior, typed property writes, acknowledgment of completed pending-write records, native Base paths feeding bounded planning, custom Bases rendering, native settings navigation, and captured application errors.

The follow-up flow also verifies two notes sharing a destination receive distinct names **before** confirmation and arrive at those exact reviewed paths with their own bodies. It deliberately creates one new synthetic destination occupant after review, verifies apply skips instead of overwriting or silently renaming, and opens a fresh read-only preview through the failed-work inbox. Settings-history review is canceled once and then explicitly confirmed; the smoke verifies the unchanged baseline retains dry-run and stays paused until explicit resume. A separate native-window test verified an actual 500 → 750 → 500 timing change/restore on desktop 1.15.0; broader configuration/conflict coverage in the matrix remains required.

The mock-CLI and mocked-CDP harnesses test command sequencing, profile/vault/renderer guards, expired deadlines, awaited results, and scoped Settings closure only. Its successful report is not evidence that any of these flows work in an actual Obsidian host.

## Required application matrix

Fresh full smoke runs now pass on **minimum Obsidian 1.14.4 and current public 1.15.0 on macOS arm64**, with thirteen stages each, including the actual native Settings window and captured application errors. Both application and installer versions were checked. The older app was a hash-verified, code-signature-verified, notarized temporary copy; the installed application was not replaced. The first-party [desktop update feed](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json) checked 2026-11-09 identifies 1.15.0 as public and 1.15.1 as beta, correcting the earlier review's current-version label.

| Version | Fresh fixture | Retained full smoke report | Result |
| --- | --- | --- | --- |
| 1.14.4 / installer 1.14.4 | `vault-flow-smoke-GsGdWL` | `.vault-flow-smoke-result-1794272008919.json` | 13 stages passed |
| 1.15.0 / installer 1.15.0 | `vault-flow-smoke-c9rtJR` | `.vault-flow-smoke-result-1794271793848.json` | 13 stages passed |

Both fixtures copied bundle SHA-256 `83f2a89962638b4718ece320d24f7e28b3ceff919ab9f857382333e3571cf488`, ran once with exact profile/vault guards, and retained separate main-window and Settings screenshots. These are actual host runs, unlike the mocked protocol tests. The earlier partial smoke remains retained as a partial historical result, not relabeled green.

The [desktop matrix follow-up](desktop-matrix-2026-11-09.md) records actual minimum/current reload readbacks, current-version native editor/external-writer conflicts, newer editor text against a stale preview, pop-out owner documents, keyboard/AX checks, completed-write runtime-storage failure/restart, and 1k/10k-note synthetic planning. It preserves controller partials separately and documents a live bulk-import index shortfall recovered by a controlled test-profile restart without changing notes.

Earlier changed-value settings restore, adversarial external reload, pre-write journal failure and a controlled rename-boundary kill/restart remain in the [dated recovery evidence](desktop-validation-2026-11-09.md). These selected checks do not establish mobile, other desktop platforms, multi-device Sync, comprehensive accessibility, representative performance, or all recovery boundaries. Record each scenario's version/platform, exact fixture, result, and retained report before extending runtime claims.

| Gate | Smallest useful next check |
| --- | --- |
| Minimum supported desktop (1.14.4) | macOS full smoke and reload postconditions verified; next repeat on other supported desktop platforms and extend recovery cases. |
| Current public desktop (1.15.0; 1.15.1 is beta in the first-party feed checked 2026-11-09) | macOS full smoke plus selected editing/reload/pop-out/storage/scale cases verified; next other supported platforms, delayed indexing and broader concurrent workflows. |
| iOS and Android | Disposable synthetic vault: load plugin, edit rule, preview/apply/undo, content predicates, timing, and memory. Browser-compatible bundling alone is insufficient. |
| Sync/external settings | Local native-editor/external-file interleavings preserve unrelated changes and reject same-rule conflicts. Next repeat on two disposable Sync devices, including revision history and invalid/new-schema reloads; do not overwrite incompatible settings. |
| Settings revisions | Change scalar types, ordering, scope, dry-run, and timing controls; restore an older revision through confirmation. Verify values return, runtime/recovery remain, and writes stay paused. Repeat with a concurrent editor/Sync change, quota failure, and plugin restart. Keep external writers quiescent during restore; the public API has no cross-process compare-and-swap. |
| Failed-work retry | Cross an age threshold, fail before mutation, then run a later sweep. Confirm retry is retained. Verify read/metadata/collision/stale failures appear with the correct trigger, a fresh inbox preview does not write, and uncertain mutations route to recovery rather than replay. |
| Pop-out windows/accessibility | A real pop-out preview, native rule editor, preview Tab/Escape and AX names/headers/disabled state were verified. Next physical screen reader, all confirmations/settings, and broader focus restoration cases. |
| Large vault | Indexed 1k/10k × 32-KiB synthetic notes measured reads, sampled memory, latency and cancellation; see cache qualifications. Next representative rules/vaults, batching off/on, retention and uninstrumented live-import/index completeness. |
| Interrupted writes | In an isolated test application only, interrupt around first rename/property write/history persistence. Verify startup pause, retained snapshots, no automatic rollback, identity-guarded recovery, and preservation of newer edits. Do not kill an application hosting real vaults. |
| Storage failure | Pre-write journal failure and completed-write runtime-history failure/restart were simulated safely; newer text and recovery records survived. Next read/backup/unknown-schema failures, physical disk-full and further interruption/durability boundaries. |
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
