# Isolated desktop validation — 2026-11-09

## Scope and verdict

**Subsequent follow-up:** the first-party desktop feed confirmed public 1.15.0 and beta 1.15.1, correcting the earlier current-version label below. The updated window-aware harness now has fresh, fully passing 1.14.4 and 1.15.0 runs; see [current desktop smoke evidence](validation.md#required-application-matrix). This document preserves the earlier partial reports and targeted recovery evidence rather than relabeling them as full smoke passes.

Actual host: **Obsidian 1.15.0, macOS arm64**. Only newly generated synthetic vaults and temporary application profiles were controlled. Normal Obsidian, real notes, existing plugin installations, and another agent's separate test instance were not controlled. All validation-owned application processes were stopped afterward; fixtures, profiles, logs, reports, and screenshots were retained locally.

This establishes selected real-host behavior, **not completion of the application release matrix**. In particular, the installed version was neither the declared minimum 1.14.4 nor the 1.15.1 current-version gate recorded during review. Physical mobile, multi-device Sync, accessibility, representative large-vault performance, and comprehensive crash/storage coverage remain unverified.

The initial CLI smoke report is **partial, not a green end-to-end run**: it passed eleven stages, then timed out looking for native settings in the main document. Obsidian 1.15 opened settings in a separate native window. The settings page and changed-value restore were subsequently tested through independently guarded window-specific CDP control. The smoke driver's native-window assumption still needs updating before another fresh full run.

## Artifact identity

| Fixture | Source | Copied `main.js` SHA-256 | Purpose |
| --- | --- | --- | --- |
| `vault-flow-smoke-ryYnUV` | `de4fafbf82080caf322d7da952cf090f1bcef190` | `cf8c2f7821b521b7e1c7fee74b3f6973d5bf53809dce66a1d3474bbdb7eede0d` | Broad smoke, native settings, external reloads, storage failure, and controlled interruption/restart. |
| `vault-flow-smoke-IFsI4b` | `006a253f44fc41db80dbd92ab1a81e5485b9c5ea` | `83f2a89962638b4718ece320d24f7e28b3ceff919ab9f857382333e3571cf488` | Fresh fixed-bundle recovery inspection, through the real command palette. |

The original smoke fixture was attempted exactly once. Subsequent targeted cases used exclusive case markers and exact state readbacks; no uncertain note mutation was automatically replayed. Temporary controller failures were retained separately: an obsolete close selector, a too-deep `JSON.stringify` in the test preparer before writing the adversarial file, and an incorrect recovery command ID. None was presented as a plugin failure or a successful full smoke run. Continuations verified their exact starting state before proceeding with new actions.

## Observed outcomes

| Scenario | Actual evidence and boundary |
| --- | --- |
| Startup and APIs | Generated plugin trusted through the test UI; CLI registered status, diagnostics, asynchronous single/multi-note planning, and synthetic rule fixtures. Exact profile and vault identity were checked. |
| Preview/apply/undo | Active-note preview and property details rendered. Explicit apply moved into the dotted `Archive/Client.v2` folder, retained `false` and `0`, and updated a synthetic link through public FileManager behavior. Confirmed undo restored the original path and properties. Completed apply/undo left no pending-write records. |
| Reviewed batch destinations | Two different note bodies reserved, refreshed, confirmed, and reached `Archive/Shared.md` and `Archive/Shared 1.md` exactly. |
| Late collision and inbox | A deliberately added destination occupant caused a collision skip, not an overwrite or an unreviewed suffix. Inbox replanning opened a fresh read-only review of `Archive/Contended 1.md`. Resolved-work filtering and the inbox entry point worked. |
| Settings history | Review cancellation, confirmation, dry-run retention, paused writes, and explicit resume worked. Through the native settings numeric control, debounce changed from 500 to 750; restoring the startup revision returned it to 500 and recovered the complete baseline configuration, preserved runtime diagnostics, and left all note hashes unchanged and writes paused. |
| External saved settings | Obsidian's actual settings watcher loaded a changed configuration and a new disabled rule. An externally saved 8,000-level predicate disabled automation without crashing the host or overwriting the rejected file. Restoring compatible settings recovered validation, retained the paused state, and changed no note hashes. This is local external-writer coverage, not multi-device Sync coverage. |
| Bases and native settings | Native Base paths fed bounded planning; the custom Bases view rendered. The plugin's native settings landing page and Advanced numeric control rendered in the settings window. |
| Journal save failure | A temporary, test-only override made the public device-local journal save throw during real apply. No rename or property write began, the note bytes/path survived, and no false pending snapshot was published. The override was restored afterward. This simulates a storage API failure; it is not a physical disk-full test. |
| Interrupted write and restart | The real public FileManager rename finished; its returned promise was deliberately held before property mutation. Only the temporary test process was killed. After a newer synthetic external edit and profile restart, the same started journal record survived, writes paused with `Pending writes need recovery inspection`, the moved note's newer bytes survived exactly, and the original source was not recreated. No automatic rollback or completion occurred. |
| Recovery inspection | The restarted UI disabled restoring an unverified started write into verified history. Canceling acknowledgment retained its snapshot. A further missing-destination case exposed the product bug described below. |

The original application error capture reported no errors. The fixed-bundle targeted case captured no runtime exceptions. Absence of captured exceptions is supplemental evidence, not a substitute for path/content/journal assertions.

## Product bug found and fixed

**Reproduced:** after an interrupted write, move its synthetic destination elsewhere, then click **Open current destination note** in recovery. `workspace.openLinkText()` created a zero-byte note at the now-missing old destination. The newer synthetic note remained intact under its moved path, but a supposedly inspect-only action had mutated the vault.

**Fix:** resolve the exact destination `TFile` at click time and open that file directly. Missing destinations show a notice; file-open failures are handled without link resolution, implicit file creation, or journal acknowledgment.

**Verification:** four headless regressions cover existing, missing, moved-after-render, and failed-open cases. The full local check passed **724 tests in 43 files**, complete peer validation, zero-warning lint, typecheck, version checks, browser/mobile bundle verification, and production bundling. The generated artifact is committed with the source.

A second fresh vault/profile loaded the corrected bundle. Its pending entry was deliberately seeded for this inspection test; it was **not represented as a second actual crash**. Through the real command palette and recovery button:

1. A missing exact destination produced the expected notice without creating or changing any note.
2. After creating a new synthetic file at that exact destination, the same action opened it without changing note hashes or the pending record.

## Retained local evidence

The operator's validation directory contains these principal artifacts; they are not checked in because profiles and recovery/property snapshots may contain sensitive data in non-synthetic use:

- Original fixture: `.vault-flow-smoke-result-1794264416630.json` — eleven passed stages, partial overall result, native-settings timeout.
- `native-settings.png`, `settings-real-host-result.json` — native settings and changed-value restore assertions; the latter also records the controller's subsequent close-selector failure.
- `external-settings-continuation-result.json` — completed external watcher, deep-input rejection, and compatible reload checks.
- `quota-result.json` — safe journal-storage failure.
- `arm-interruption-result.json`, `interruption-disk-state.json`, `restart-recovery-continuation-result.json`, `pending-recovery-after-restart.png` — interruption boundary, post-kill newer edit, and verified restart behavior.
- `missing-recovery-destination-result.json` — pre-fix zero-byte-note reproduction, with the newer note preserved.
- `fixed-recovery-inspection-result.json`, `fixed-recovery-inspection.png` — corrected-bundle identity, real UI assertions, unchanged recovery data, and no captured exceptions.

Pending synthetic recovery records were intentionally retained rather than acknowledged as if the interrupted note had been repaired. Keep the generated fixtures as consumed evidence; prepare a new one for another smoke attempt.

## Harness hazards and remaining work

- `--user-data-dir` separates Electron profiles, but the native CLI socket is shared at `~/.obsidian-cli.sock`. Coordinate concurrent instances, explicitly target a vault, and verify its exact root before control. Do not use an active-vault fallback.
- Read the debugging port from the exact profile's `DevToolsActivePort`. Verify `app.getPath("userData")` and the vault adapter's base path before mutations; never attach to another instance's port or target.
- Native Settings is a separate renderer in this host version. Its active document can remain selected even when the main window appears focused. Close only the owned settings window when appropriate, focus the corresponding main BrowserWindow, and verify `activeDocument === document` before main-window modal actions.
- Update the smoke driver's settings-window handling and run it once on a fresh fixture. Do not weaken exact-target or single-attempt guards to obtain a green report.
- Complete the remaining [application matrix](validation.md#required-application-matrix), especially minimum/current desktop, physical mobile, multi-device editor/restore conflicts, accessibility, and large-vault measurements.
- Controlled process termination and synchronous public storage APIs do **not** establish fsync/power-loss durability, every storage failure, or independent/cross-device backup.
