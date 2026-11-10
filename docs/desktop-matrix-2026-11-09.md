# Isolated desktop matrix follow-up — 2026-11-09

## Scope and verdict

The native-window-aware standalone smoke completed all **13 stages** on minimum **Obsidian 1.14.4** and current public **1.15.0**, including native Settings, apply/undo, Bases and asynchronous CLI handlers. Additional 1.15.0 checks exercised native rule editing with external writers, newer editor text against a stale preview, pop-out owner documents, preview keyboard/AX semantics, completed-write history-storage failure and restart, and 1k/10k-note synthetic planning.

This is selected **macOS arm64 application evidence**, not a completed release matrix. Physical mobile devices, other desktop operating systems, multi-device Sync, a physical screen reader, representative user vaults, and power-loss/disk durability remain unverified. The earlier [desktop report](desktop-validation-2026-11-09.md) retains the actual rename-boundary kill/restart, journal-preparation fault, settings history and adversarial external-settings evidence.

No further plugin bug was reproduced in these follow-up cases. Several scratch controllers failed navigation/readiness/cleanup assertions; their original partial reports were retained. An important index shortfall during live bulk creation is described below, without attributing its cause to Vault Flow or Obsidian.

## Provenance and isolation

- Plugin bundle SHA-256: `83f2a89962638b4718ece320d24f7e28b3ceff919ab9f857382333e3571cf488`, matching the recovery fix in `006a253f44fc41db80dbd92ab1a81e5485b9c5ea` and subsequent documentation/harness-only revisions.
- Smoke harness/source revision: `da4124d7a05de2ec9ad22e820c2d388773147209`; local source checks passed **734 tests in 44 files**, lint, typecheck, peer/version/bundle checks and production build. These checks are not host evidence.
- Both frontend and installer versions were checked. The first-party desktop feed identified **1.15.0 as public and 1.15.1 as beta**, correcting the earlier review's current-version label.
- The official 1.14.4 DMG matched release SHA-256 `dcf818dd20ee5d9dd3e782eee0c0c4c47cc225383b051c2fc9af7d5772f59f70`; its temporary app copy passed code-signature verification and macOS notarization assessment. The installed application was not replaced.
- Only generated notes and unique temporary profiles were used, each registering exactly its synthetic vault. Automatic updates were disabled in those profiles. Plugin trust and CLI enablement were scoped to those profiles; PATH registration was skipped.
- CDP used the current profile's `DevToolsActivePort` and exact loopback endpoint. Scratch controllers checked profile, executable, main PID and vault before operations. Native Settings and pop-outs were separately identified; the shared native CLI lane was coordinated with the other session.
- All owned test instances were stopped after readback. Normal Obsidian and the peer's test application were preserved. No push, publication, normal-profile plugin activation, manifest platform change or fixture cleanup occurred.

Retained artifact parent: `vault-flow-host-matrix-20261109.rYrP9C/` outside Git. It contains profiles, fixtures, controllers, screenshots, logs, before-images, note hashes and the aggregate `validation-summary.json`. All attempted fixtures are evidence, not reusable baselines.

## Full standalone smoke

| App / installer | Case directory and fixture | Report | Outcome |
| --- | --- | --- | --- |
| 1.14.4 / 1.14.4 | `minimum-1.14.4/vault-flow-smoke-GsGdWL` | `.vault-flow-smoke-result-1794272008919.json` | 13 stages passed |
| 1.15.0 / 1.15.0 | `public-1.15.0/vault-flow-smoke-c9rtJR` | `.vault-flow-smoke-result-1794271793848.json` | 13 stages passed |

Each was a fresh, single-attempt run with main and native Settings screenshots. Both ended with no captured application errors. The older partial smoke report is unchanged; these are new passing runs, not a reinterpretation of it.

## Targeted desktop checks

| Scenario | Actual observation | Principal evidence |
| --- | --- | --- |
| Minimum-version renderer reload | New plugin/CLI registration, compatible dry-run settings, journal and all five note paths/hashes survived. An independent readback classified the earlier log assertion separately. | `minimum-reload-observed/vault-flow-smoke-Zxd0wz`, `reload-analysis-readback.json` |
| Current-version renderer reload | Plugin and CLI re-registered; safety state, journal and all note hashes survived, with no new reload errors. | `extended-public/vault-flow-smoke-ERlR3e`, `reload-result-*.json` |
| Native visual rule editor and unrelated writer | A disabled synthetic `frontmatterValue` rule displayed string `001` as `"001"`. A native form edit preserved that string while retaining an externally changed different rule and debounce `750`. | `native-settings-optimistic-editing-result.json`, `native-editing.png` |
| Same-rule external conflict | An external writer changed the open rule to string `002`. Saving its older draft showed the conflict notice, retained newer settings, and left the editor open to cancel. Original synthetic configuration was then restored through the real watcher; all notes were unchanged. | Same native editing report and retained external before-images |
| Newer editor text versus reviewed apply | A public Editor API edit was saved after planning. Explicit one-note apply skipped as stale; newer bytes, original path and unrelated notes survived, with no pending write. | `concurrent-editor-preview-result.json` (partial controller), `concurrent-editor-independent-readback-result.json` |
| Keyboard and accessibility semantics | CDP-dispatched Tab reached the next named preview control; Escape dismissed the modal. The actual AX tree exposed search/checkbox names, table column headers and disabled apply state. This is not a screen-reader audit. | First two verified checks in `popout-keyboard-accessibility-result.json` |
| Real native pop-out | The public Workspace API moved the synthetic note to a native window. The actual plugin command and expanded property details appeared only in that pop-out document, not the main document. Screenshot, closure and unchanged note hashes were verified. | `popout-stable-window-continuation-result.json`, `popout-preview.png` |
| Completed write, failed history storage | A confirmed one-note rename/frontmatter write completed with typed `false`/`0` and the existing body. A runtime-history storage API fault paused writes and preserved the completed, verified pending snapshot rather than acknowledging it. | `completed-write-runtime-storage-failure-result.json` |
| Newer text after that write | A later public Editor API edit changed the destination identity. Recovery-history restore refused it without altering the note or journal. Canceling explicit acknowledgment retained the snapshot. | Same completed-write fault report |
| Restart after history-storage fault | The fault remained active through graceful shutdown, preventing unload from silently retaining the failed history. After actual process restart, the injector was absent, the completed journal survived exactly, the newer note hash was unchanged, the source was not recreated, and writes paused for inspection. | `runtime-failure-restart-result.json`, `runtime-failure-after-restart.png` |

Except where shown otherwise, targeted evidence above is in `extended-public/`. The restart retained destination SHA-256 `e2e28d88db53924bd81008cf618d22502a0c94af33bfb11371ab929774fa0517`. Its pending record was intentionally left unresolved, not acknowledged as though the note had been repaired. Storage fault injection is not physical disk-full testing; graceful restart is not a power-loss or fsync guarantee.

## Synthetic host planning measurements

Fixture: `performance-public/vault-flow-smoke-6W3k6D`, actual Obsidian 1.15.0. There were 1,000 then 10,000 monitored Markdown notes, each exactly **32 KiB**, one heading/link, two frontmatter tags, and 10% matching candidates. Total generated note data at 10k was **312.5 MiB**. Metadata and body predicates independently produced exactly 100 / 1,000 pending changes. No apply was requested.

| Monitored notes | Predicate | UI planning wall time | `cachedRead` / underlying `read` calls | Peak sampled renderer heap | Peak summed own-app working sets |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | Metadata | 137 ms | 0 / 0 | 54.6 MiB | 627.0 MiB |
| 1,000 | Body contains | 128 ms | 1,000 / 0 | 57.7 MiB | 640.4 MiB |
| 10,000 | Metadata | 664 ms | 0 / 0 | 60.3 MiB | 768.6 MiB |
| 10,000 | Body contains | 1,171 ms | 10,000 / 9,905 | 395.2 MiB | 1,179.4 MiB |

Interpretation and limits:

- Timings are poll-sampled wall times, including exact-root guard/CLI overhead, the actual registered command, preview rendering and up to a 100 ms polling interval. Metadata caches were complete and the owned window was foreground/visible. These are not engine-only timings or performance SLAs.
- Metadata-only previews made **zero body-read API calls**. Body reads observed a maximum of four concurrent calls per API. `cachedRead` can call `read`; these are not independent physical I/O counts or eight independent workers.
- Cache conditions differ: 1k body reads hit the application's cache; the 10k measurement followed restart and mostly called underlying `read`. OS page-cache state was not controlled. Do not infer a scaling ratio or a cold-disk benchmark from these four samples.
- Memory is sampled, not an exact peak. Renderer heap and summed process working sets are different metrics; the latter can double-count shared mappings and is not unique physical memory. This was one workload, not a retention/leak or mobile-memory certification.
- A 25 ms heartbeat observed at most 6.9 ms additional delay in these samples; this is not comprehensive frame-rate or long-task tracing.
- In a separate **simulated slow-read** cancellation check, the actual Cancel control drained four in-flight cached reads in **108 ms** with no further preview or note writes. Only this cancellation check added an 8 ms read delay; timing rows did not.
- All 10,000 generated contents were checked against their expected SHA-256 hashes, all original notes were unchanged, the test configuration was restored, and all API wrappers/timers/listeners were removed. Final readback found the full index, no stray modal, no pending writes and no captured application errors.

Evidence: two verified 1k benchmark records inside `synthetic-host-performance-continuation-result.json` (overall partial because the later live-index gate timed out); the new `synthetic-host-performance-tenk-result.json` (passed), `performance-note-hashes.json`, and `performance-final-readback-result.json`. The 10k phase verified existing bytes without recreating or rewriting any notes.

### Observed index shortfall during live bulk creation

The fast filesystem import created all 10,000 notes, but Obsidian's loaded file index showed **9,905** after the bounded 150-second readiness wait. Every indexed file had the expected metadata; **95 intact disk files were absent from the host index**. The plugin's monitored scope was back to `Inbox`, the read instrumentation was removed after failure, and the partial report was retained. No 10k preview was benchmarked against that incomplete selection.

After exact disk/index readback and a controlled restart of only that profile, the initial index contained all 10,000. Every note hash matched the pre-restart snapshot; only then did the 10k measurements proceed. `performance-index-inspection.json` retains the missing-path inventory, alongside `performance-pre-restart-note-hashes.json`.

This demonstrates a completeness boundary of the **observed host index**, not note loss or a proven causal bug in the plugin or host. The import was instrumented; reproduce it without wrappers before attributing the cause. Preview/sweep counts reflect files Obsidian has loaded, not an independent complete filesystem inventory. Further uninstrumented external-import and real Sync checks remain necessary.

## Preserved partial controllers

- The first minimum reload controller encountered a transient navigating-target read error. A later fresh controller's all-ever-log assertion included a pre-reload Chromium `navigator.vibrate` intervention from an automated trust click. In the observed fixture, its timestamp conclusively preceded the persisted before-reload snapshot; actual reload postconditions and a separate live readback passed. Earlier reports were not overwritten or relabeled.
- The concurrent-editor controller tried to close a preview which had already auto-closed after the completed stale skip. The independent readback confirmed all safety assertions, unrelated note hashes and an empty journal.
- The first pop-out controller inspected native-window identity before it stabilized. It stopped before invoking the preview there. After exact state inspection, continuation used that existing owned window; it did not create another window or replay a note mutation.
- A first scale preparer generated a separate 1k link-dense set, then waited for an unusable incremental `resolved` signal. It ran no benchmark. A fresh profile used the intended one-link dataset, but initially timed out on readiness too. Its byte-verified existing 1k notes were not rewritten; continuation measured them, created only the remaining 9k, then encountered the index shortfall above.

These controller failures and the observed index shortfall remain visible in the aggregate. None turns a partial report into a passing full run. The new standalone smokes, separately verified postconditions and completed benchmark phases are identified individually.

## Remaining release gates

- Physical iOS/Android testing or an explicitly authorized desktop-only scope decision; the manifest still advertises mobile support.
- Other supported desktop platforms, real multi-device Sync, concurrent settings restore with Sync/external writers, and broader import/index completeness checks.
- Physical screen-reader navigation, all settings/confirmation keyboard paths, broader pop-out/focus cases and representative real-vault/rule distributions, including batching off/on.
- Additional interruption points, storage read/unknown-schema/backup failures, physical disk-full, sudden power loss and durability. Existing simulated faults and one controlled kill are bounded evidence only.
- Remote CI on the final revision, manual privacy/history/assets review, naming resolution and release preparation. No push or publication is authorized by these tests.
- The documented ESLint 9 support deferral remains; no unsupported upgrade or dropped official checks were used.
