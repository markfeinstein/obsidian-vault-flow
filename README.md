# Vault Flow

Vault Flow is an Obsidian plugin that organizes Markdown notes with rules. A rule can move or rename a note, update its properties, or change its frontmatter tags.

The plugin is still early (`0.1.0`). Dry-run mode is enabled by default. Start with a test folder and review the previews before allowing automatic writes.

## Features

- Match notes by path, name, tags, properties, headings, body text, file age, or property dates.
- Move and rename notes using fixed destinations or templates.
- Set, initialize, append to, or delete properties.
- Add, remove, or replace frontmatter tags without changing inline body tags.
- Run rules on live changes, scheduled sweeps, or manual commands.
- Preview one note, a folder, the whole vault, or the current result set of an Obsidian Base.
- Detect stale previews and destination collisions before writing.
- Pause writes, limit write rates, cancel the rest of a batch, and undo recent transactions when the note has not changed.
- Inspect rule decisions, batch receipts, duplicate source URLs, and per-note rule traces.

## Requirements

- Obsidian 1.14.4 or newer
- Markdown notes stored inside the vault
- Node.js 22.13.0 or newer when building from source

The runtime bundle is checked for browser and mobile compatibility. Physical-device mobile testing is still pending.

## Installation

Vault Flow is not yet in the Community Plugins directory.

### From a GitHub release

1. Download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub release](https://github.com/markfeinstein/obsidian-vault-flow/releases).
2. Create `<vault-config>/plugins/vault-flow/`, where `<vault-config>` is usually `.obsidian`.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Vault Flow** under **Settings → Community plugins**.

### From source

```sh
npm ci
npm run check
```

Then copy or symlink `main.js`, `manifest.json`, and `styles.css` into `<vault-config>/plugins/vault-flow/`.

Do not test file-moving rules for the first time in an irreplaceable vault.

## First run

1. Leave **Dry run** enabled.
2. Set a monitored test folder.
3. Add one narrowly scoped rule.
4. Run **Vault Flow: Preview active note changes** on a known note.
5. Run **Vault Flow: Preview vault changes** and inspect the proposed paths and properties.
6. Check **Vault Flow: Open diagnostics** if a result is unexpected.
7. Disable dry-run only after the same rule produces repeatable results.

A reviewed apply action writes the selected rows even when global dry-run is enabled. This is intentional: selecting rows and confirming the apply is the write authorization.

## Rules

Rules run by ascending `priority`, then `order`. A basic rule has this shape:

```json
{
  "id": "projects-by-tag",
  "name": "Projects by tag",
  "enabled": true,
  "priority": 10,
  "order": 0,
  "when": { "type": "tag", "tag": "project" },
  "then": { "moveTo": "Projects" },
  "runOn": "always"
}
```

A time-based rule can combine predicates and property updates:

```json
{
  "id": "old-draft-review",
  "name": "Old draft review",
  "enabled": true,
  "priority": 20,
  "order": 1,
  "when": {
    "type": "all",
    "predicates": [
      { "type": "pathGlob", "glob": "Drafts/**" },
      { "type": "fileAge", "field": "mtime", "olderThanDays": 30 }
    ]
  },
  "then": {
    "addTags": ["review"],
    "setProperties": { "needs-review": true }
  },
  "runOn": "sweep"
}
```

### Trigger contexts

- `always`: every trigger
- `live`: create, rename, or metadata changes while Obsidian is open
- `sweep`: startup and periodic sweeps
- `manual`: commands, previews, context menus, and the Vault Flow Bases view

A rule can also set `dryRun: true` or `stopOnMatch: true`. `stopOnMatch` stops the current reconciliation; it does not prevent a later live event from running the rule again.

### Predicates

- Tags: `tag`, `tagPrefix`
- Paths and names: `pathGlob`, `basename`
- Body: `bodyH1`, `contentContains`, `contentRegex`, `wordCount`
- Properties: `frontmatterValue`, `frontmatterExists`, `frontmatterMissing`, `frontmatterContains`, `frontmatterRegex`, `frontmatterDateAge`
- Other: `sourceUrl`, `fileAge`
- Composition: `all`, `any`, `not`

### Actions

- Paths: `moveTo`, `renameTo`
- Tags: `addTags`, `removeTags`, `replaceTags`
- Properties: `setProperties`, `deleteProperties`, `initProperties`, `appendToProperty`

Tag actions update only the frontmatter `tags` property. Inline tags in the note body are left alone. Rule property values can be JSON scalars, arrays of scalars, or shallow objects with scalar values; unrelated nested YAML is preserved when a note is updated.

Rename and destination templates support property placeholders, `{basename}`, `{folder}`, `{path}`, `{extension}`, `{now}`, `{now:FORMAT}`, `{today}`, `{date:FORMAT}`, and regex captures such as `{1}`. Use `{{` for a literal opening brace.

Set `moveToKind` to `folder` or `file` when the destination would otherwise be ambiguous. This matters for folder names containing dots, such as `Projects/Client.v2`.

### Editing rules safely

Property equality values accept JSON scalars: use `"001"` or `"true"` for text, and `1` or `true` for numbers and booleans. Existing value types are preserved when editing. Delete-property lists accept a JSON string array (recommended for names containing commas) or comma-separated names; spaces within a name are preserved. Every nonempty numeric bound must be valid before saving.

Adding a rule leaves existing execution priorities unchanged. If settings sync while an editor is open, unrelated rule changes are retained; a conflicting change to the edited rule must be resolved by reopening it.

### Regular expressions

User patterns run through bundled RE2JS rather than JavaScript's backtracking regular expressions. Patterns are case-insensitive and limited to 512 characters / 10,000 compiled instructions. Active immutable rule sets retain compiled patterns up to 1,024 patterns / 100,000 instructions per flag mode; larger sets fall back to the 64-entry cross-edit cache without changing matching semantics.

Strict RE2 syntax remains the default: lookarounds and backreferences are rejected. A rule may explicitly opt in to **Allow captureless regex lookbehind** (`regexLookbehind: true`), enabling positive/negative lookbehind with no captures inside the lookbehind. Captures outside it still work in templates. Lookaheads and backreferences remain unsupported. Lookbehind can disable faster matching paths, so use it only when necessary. Unsupported saved patterns still disable automation without overwriting settings.

**Batch body regex matching** (`useRegexSet: true`) is a separate experimental opt-in, off by default. It uses RE2Set only for immutable body-regex inputs, never precomputed paths or properties. Sets are capped at 128 patterns / 20,000 combined instructions with a 4 MiB DFA budget per flag group, and fall back to individual matching on limits or errors. Captures and traces remain equivalent. Run `npm run bench:regex` for a synthetic headless comparison and benchmark representative vault rules before enabling; it is not Obsidian/mobile runtime confirmation.

## Write safety

- Monitored folders, exclusion globs, and a per-note disable property control the processing scope.
- Invalid scope settings disable automation instead of falling back to whole-vault access.
- Live writes wait while the target note is active.
- Startup sweeps retain their trigger for notes indexed after the workspace appears.
- Metadata and body-read failures stop after three attempts, with exponential retry backoff capped at 30 seconds.
- Planning and writing recheck the file path, metadata, body content when needed, settings revision, and destination collision state.
- Mutations are serialized. If a property write fails after a rename, Vault Flow attempts to move the note back.
- A device-local pause stops new writes. The default circuit breaker allows 100 transaction starts per rolling minute and 100 selected rows per reviewed batch.
- Collision handling can skip the note or choose an available numeric suffix.
- Closing an apply preview cancels rows that have not started. A transaction already writing is allowed to finish or roll back.

Undo records are kept separately from diagnostics. Vault Flow retains up to 100 transactions for seven days, capped at 1 MiB. Before undoing, it checks the current path, file statistics, SHA-256 content fingerprint, and complete frontmatter after-state. If the note was edited, replaced, moved elsewhere, or deleted, undo is refused.

Runtime history, batch receipts, sweep state, and rule statistics are stored in Obsidian's device-local plugin storage rather than synced settings.

## Bases

The **Vault Flow plan** Bases view uses the Base's current filters, sorting, grouping, and result limit.

It can:

- run manual Vault Flow rules;
- move notes using a text, link, file, or formula value;
- rename notes using a text or formula value;
- set a property from a text, finite number, or boolean value.

Select the rows you want, open the apply preview, and confirm the batch. Vault Flow rechecks the Base snapshot before the first write and validates each note again before changing it.

## Commands

- **Pause or resume writes (this device session)**
- **Reconcile active note**
- **Preview active note changes**
- **Reconcile entire vault**
- **Reconcile current folder**
- **Explain this note**
- **Show diagnostic log**
- **Open diagnostics**
- **Find duplicate source URLs**
- **Preview vault changes**
- **Show undo history**
- **Show apply batch receipts**
- **Export diagnostics to Markdown**
- **Export settings to clipboard**

File and multi-file context menus also offer manual reconciliation for eligible Markdown files.

## Obsidian CLI

With the official Obsidian CLI enabled, Vault Flow provides read-only JSON commands:

```sh
obsidian vault="VAULT" vault-flow:status
obsidian vault="VAULT" vault-flow:diagnostics limit=20 outcome=error
obsidian vault="VAULT" vault-flow:plan path="Inbox/Example.md" trigger=manual
obsidian vault="VAULT" vault-flow:plan-many paths='["Inbox/Example.md","Projects/Some note.md"]' limit=100 trigger=manual
obsidian vault="VAULT" vault-flow:test-rule rule="archive-reviewed"
```

The plan output contains paths, rule IDs, mutation kinds, and changed property names. It omits note bodies and property values. Diagnostics can still contain private paths and rule identifiers.

## Development

```sh
npm ci
npm run check
```

Useful commands:

- `npm run dev`: watch and rebuild `main.js`
- `npm run lint`: run ESLint
- `npm run typecheck`: run TypeScript without emitting files
- `npm test`: run the Vitest suite
- `npm run bundle`: rebuild the production `main.js`
- `npm run verify:mobile-bundle`: reject accidental Node.js or Electron runtime dependencies
- `npm run verify:versions`: check version metadata
- `npm run sync:version`: update `manifest.json` and `versions.json` from `package.json`
- `npm run test:obsidian:prepare`: create an isolated synthetic test vault
- `npm run test:obsidian -- --root … --vault … --cli … --allow-runtime`: run the opt-in desktop smoke driver against that exact generated vault

`main.js` is generated but committed because it is a release asset.

## Releases

`package.json` is the version source of truth. Release tags are numeric versions such as `0.1.0` and must match `manifest.json`. The release workflow checks the build and publishes `main.js`, `manifest.json`, and `styles.css`.

`plan-many` accepts a JSON path array or a newline-separated exact path list (for example, the output of the official `base:query path=… view=… format=paths` command). It deduplicates paths, defaults to 100 notes, caps requests at 200 notes / 64 KiB, runs at concurrency 4, and limits output to 1 MiB. Planning stops launching notes after 10 seconds or a settings change. An in-flight Obsidian read or synchronous engine evaluation cannot be forcibly aborted. Results never include body text or property values; property-name lists are bounded and mark truncation. There is deliberately no CLI apply command. The official CLI connects to a running Obsidian instance; it is not a headless, in-process Bases query API.

`test-rule` runs one configured rule’s synthetic fixtures with the same fixed defaults as the editor and does not read vault notes.

## Interrupted-write recovery

Before the first note mutation, Vault Flow synchronously saves a device-local write-ahead snapshot (`vault-flow:pending-writes:v1`). Successful transactions are saved to undo history immediately before their pending record is acknowledged. Startup pauses writes when unresolved or unsupported recovery data is present. Open **Inspect pending-write recovery** to inspect/export before/after properties, restore a verified completed write to history, or acknowledge an entry after manual inspection. These actions never automatically repair or overwrite a note; resume writes explicitly afterwards.

Unknown/interrupted outcomes require manual inspection and independent backups. Only completed writes whose captured identity still matches can be recovered into history. Unresolved entries are not automatically expired or evicted (40 entries / 1 MiB maximum); overlapping writes and storage failures block new writes. Property values are retained locally and included in recovery exports, so store exports securely. Device-local storage is not a cross-device backup or a guarantee against filesystem/power-loss failure.

## Bulk review and retained undo history

Vault previews support path, status, and rule filters; folder/rule grouping; select-page/select-filtered controls bounded by the batch limit; and explicit deselection. Selection persists across pages and filters, with hidden selections counted before apply. The final confirmation summarizes the scope and duplicate proposed destinations. “Copy selected plan summary” exports paths, rule IDs, and property names, not note bodies or property values.

Undo history now paginates and searches all retained transactions, rather than exposing only the latest 20. Individual and batch undo require confirmation and retain identity/frontmatter checks. Batch undo explicitly includes other pages and filtered-out entries from that batch; older entries without verified identities remain non-undoable. Retention limits still apply: this is not a substitute for backups.

## Rule fixtures and semantic save review

The editor shows condition, action, execution-order, and fixture changes before saving. Repetition warnings and failed fixtures require explicit acknowledgment. Add up to 20 synthetic fixtures (200 KB total per rule) in the editor and run them without reading or writing vault notes. A disabled rule is enabled only for its fixture run; `runOn` is still honored. Fixtures default to a fixed clock (`now: 0`), the manual trigger, and 10 iterations. Use explicit `now`/timestamps for age tests. Expected frontmatter is a subset; `absentProperties` asserts deletion.

```json
[{
  "name": "Archive reviewed note",
  "note": { "path": "Inbox/example.md", "frontmatter": { "status": "reviewed" }, "body": "Synthetic example" },
  "expected": { "path": "Archive/example.md", "changed": true, "status": "converged" }
}]
```

Fixtures are saved and exported with rules: do not copy private note content into them. Settings schema 4 and rule-export schema 3 preserve the new data and make older plugin versions fail closed. Existing settings and rule exports migrate without changing their rule semantics.

## Planning performance

Planning first evaluates metadata and earlier rule actions in memory, loading a note body only if evaluation reaches a body-dependent condition. Compiled regexes are retained for the active immutable rule set. Vault and Bases previews release retained note text in favor of SHA-256 body baselines, and vault previews discard unchanged rows as planning completes. These optimizations preserve stale-plan checks and sequential rule semantics.

## Known limitations

- Only Markdown files are processed.
- A multi-file batch is not one atomic transaction; each note is validated and written independently.
- Undo history is bounded and device-local. Keep backups or version history.
- Bases does not expose a supported headless query API, so live and sweep automation use Vault Flow's own planner.
- Globs use the `*`, `**`, and `?` dialect and are limited to 1,024 characters.
- Regexes use RE2-compatible syntax rather than the full JavaScript RegExp syntax.
- The synthetic Obsidian 1.15.1 desktop smoke flow has been exercised. Minimum-version desktop, physical mobile devices, Sync, external-file views, pop-out windows, accessibility, and very large vaults still need real-application testing.

## License

MIT. See [LICENSE](LICENSE).
