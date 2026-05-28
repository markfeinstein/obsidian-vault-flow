# Vault Flow

Vault Flow is an Obsidian plugin for deterministic, rule-based note organization. It plans and applies moves, renames, frontmatter updates, and frontmatter-tag changes using metadata, paths, tags, headings, note content, and file age.

Vault Flow is currently early-stage (`0.1.0`). Global dry-run is enabled by default. Review previews on a representative folder before allowing automatic writes.

## Installation

Vault Flow is not yet listed in Obsidian's Community Plugins directory. Until it is listed, install only from a release published by this repository or build the plugin from source.

### From a GitHub release

1. Download `main.js`, `manifest.json`, and `styles.css` from the same [Vault Flow release](https://github.com/markfeinstein/obsidian-vault-flow/releases). Do not mix files from different versions.
2. Create `<vault-config>/plugins/vault-flow/`, where `<vault-config>` is the vault configuration directory (normally `.obsidian`).
3. Copy the three files into that folder.
4. Reload Obsidian, open **Settings → Community plugins**, and enable **Vault Flow**.
5. Keep global dry-run enabled and follow [Recommended First Run](#recommended-first-run).

GitHub release tags are numeric versions such as `0.1.0` and must match the version in `manifest.json`.

### From source

Install the development requirements below, run `npm ci` followed by `npm run check`, then copy or symlink `main.js`, `manifest.json`, and `styles.css` into `<vault-config>/plugins/vault-flow/`. Never test file-mutation changes first against an irreplaceable vault.

## Requirements

- Obsidian `1.14.4` or newer
- Markdown notes stored inside the vault
- Node.js `22.13.0` or newer for development

The plugin bundle is checked for browser/mobile compatibility, but physical-device mobile behavior has not yet been verified.

## Safety Model

Vault Flow keeps automation inspectable and bounded:

- Global dry-run starts enabled.
- Rules use declarative predicates and actions rather than arbitrary JavaScript.
- Only in-vault Markdown files are processed; external files and protected configuration paths are rejected.
- Monitored folders, exclusion globs, and a per-note disable property limit scope. Any truthy YAML value in the configured disable property protects the note, including nonempty strings, nonzero numbers, arrays, and objects; use `false`, `0`, an empty string, or no property to leave it eligible. Malformed scope settings disable automation without overwriting the settings file; they never silently become whole-vault scope.
- A device-session pause parks queued work and blocks new apply/undo transactions. Use **Pause or resume writes (this device session)** or the Automation settings toggle. Resume explicitly; pause is not synced and resets when the plugin reloads.
- Write limits default to **100 transaction starts per rolling minute** and **100 selected rows per reviewed apply batch**. Configure **Maximum writes per minute** and **Maximum batch writes** in Advanced settings. The rolling limit also counts undo and failed starts; reaching it pauses writes until explicit resume. Dry-run planning consumes no write budget.
- Live writes are parked while the target note is active and resume when the active file changes. Activity is rechecked after waiting for the mutation lock and during destination-folder preparation. Manual runs remain explicit.
- Disabling the plugin stops transactions that are still preparing. A transaction whose first note mutation has already started finishes or attempts rollback rather than abandoning a half-applied move/property update. Preparation may leave an empty destination folder.
- Destination collisions can be skipped or resolved with a numeric suffix.
- Vault-wide preview planning uses bounded concurrency, reports progress, can be cancelled, and allows row selection without changing global dry-run. Its apply table renders 100 pending rows per page and retains selections across pages.
- Apply operations revalidate the preview baseline and serialize mutations before writing. **Cancel remaining** (or closing the preview) stops work before the next mutation; a transaction already writing finishes or attempts rollback. Apply progress reports applied/skipped/failed/remaining counts. Completed, cancelled, and stopped batches retain bounded device-local receipts.
- Successful transactions retain before/after paths, complete frontmatter snapshots when properties changed, and a SHA-256 content/stat after-state fingerprint in a separate undo journal. Routine diagnostics cannot evict them. The journal retains at most 100 transactions, seven days, and 1 MiB of UTF-8 JSON; oversized transactions are not retained, and a notice reports that limitation. Undo, including path-only undo, rejects edited or replaced notes. If fingerprint capture fails, the write remains completed but undo is unavailable and a notice explains why.
- Settings have a schema version. Data from a newer unsupported schema disables automation rather than being silently downgraded.
- Runtime history, sweep state, and rule statistics use Obsidian's device-local storage instead of synced plugin settings.

No plugin can make file automation risk-free. Keep backups or version history, test narrowly, and review Sync behavior before broad runs.

## Recommended First Run

1. Install or build Vault Flow.
2. Leave **Dry run** enabled in Vault Flow settings.
3. Set a monitored test folder.
4. Add one narrowly scoped rule.
5. Run **Vault Flow: Preview active note changes** on a known note.
6. Run **Vault Flow: Preview vault changes** and select only the expected rows.
7. Review **Vault Flow: Open diagnostics**.
8. Disable global dry-run only after results are repeatable.

Per-rule dry-run is also available. A matching dry-run rule reports its hypothetical mutations while leaving the note unchanged.

## Rule Examples

Move notes tagged `#project` into `Projects`:

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

Rename notes from a `title` property, but only during manual runs:

```json
{
  "id": "rename-from-title",
  "name": "Rename from title",
  "enabled": true,
  "priority": 20,
  "order": 1,
  "when": { "type": "frontmatterExists", "property": "title" },
  "then": { "renameTo": "{title}" },
  "runOn": "manual",
  "dryRun": true
}
```

Mark old drafts for review:

```json
{
  "id": "old-draft-review",
  "name": "Old draft review",
  "enabled": true,
  "priority": 30,
  "order": 2,
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

## Rule Model

Rules are evaluated by ascending `priority`, then `order`. A rule contains `id`, `name`, `enabled`, `priority`, `order`, `when`, and `then`. Optional controls are:

- `stopOnMatch`: stop the complete reconciliation after this rule applies.
- `runOn`: limit the rule to a trigger context.
- `dryRun`: evaluate and report hypothetical actions without applying them.

Supported `runOn` values:

- `always`: every trigger.
- `live`: metadata, create, or rename activity while Obsidian is open.
- `sweep`: startup and periodic modification-time sweeps.
- `manual`: commands, context menus, previews, and the Vault Flow Bases view.

Supported predicates:

- Tags: `tag`, `tagPrefix`
- Paths and names: `pathGlob`, `basename`
- Body: `bodyH1`, `contentContains`, `contentRegex`, `wordCount`
- Frontmatter: `frontmatterValue`, `frontmatterExists`, `frontmatterMissing`, `frontmatterContains`, `frontmatterRegex`, `frontmatterDateAge`
- URLs and file time: `sourceUrl`, `fileAge`
- Composition: `all`, `any`, `not`

Supported actions:

- Paths: `moveTo`, `renameTo`
- Frontmatter tags: `addTags`, `removeTags`, `replaceTags`
- Properties: `setProperties`, `deleteProperties`, `initProperties`, `appendToProperty`

Inline body tags participate in matching, but tag actions modify only the frontmatter `tags` property. Tag matching and removal follow Obsidian's case-insensitive semantics while preserving the first existing display casing, and imported tag values are validated against Obsidian's documented tag format. Content and word-count predicates inspect the Markdown body after YAML frontmatter rather than treating properties as body text. Frontmatter values are limited to JSON scalars, arrays of scalars, and shallow objects with scalar values. Deeper YAML values are not exposed as rule values, but their keys and complete write baseline are tracked: unrelated writes preserve them, `initProperties` does not overwrite them, and an explicit `deleteProperties` action can remove them safely.

### Regex safety and compatibility

Rule regexes use the bundled [RE2JS](https://github.com/le0pard/re2js) linear-time engine, not JavaScript's backtracking engine. Matching is case-insensitive. Patterns are limited to 512 characters and 10,000 compiled instructions, and compiled patterns are shared in a bounded cache. Capture groups, character classes, alternation, and greedy/lazy quantifiers are supported. Lookarounds and backreferences are not supported. RE2 syntax and Unicode/anchor semantics are not identical to JavaScript RegExp; for example, `$` means the end of input, not the position before a final newline.

Unsupported patterns are rejected by the rule editor and imports. If existing saved settings contain an unsupported pattern, automation and settings writes are disabled, and a notice identifies the affected rule IDs. **The original settings file is not overwritten.** Back up `<vault-config>/plugins/vault-flow/data.json`, update those patterns there, then reload the plugin. Review existing regex rules in dry-run before upgrading; use literal `contentContains`/`frontmatterContains` predicates where possible. Linear-time matching prevents catastrophic backtracking, but very large notes and broad automatic rules still cost CPU.

Rename templates support `{property}`, `{basename}`, `{now}`, `{now:FORMAT}`, `{date:FORMAT}`, regex captures such as `{1}`, and `{{` for a literal `{`. Plain `{date}` reads the frontmatter `date` property; it is not an alias for today's date.

Captures follow the branch that actually matched: `any` uses its first successful child; `all` uses the first nonempty basename/body capture set from successful children; `not` exports no captures. Failed and short-circuited branches cannot supply rename values.

Move actions can declare `moveToKind: "folder"` or `"file"`. Choose **Folder** in the rule editor for a folder containing dots, such as `Projects/Client.v2`; choose **Complete file path** for a path including the Markdown filename. Omitted/`"auto"` preserves legacy inference (a trailing slash or a final segment without a dot means a folder).

Settings now use schema version **3** so older builds cannot silently discard write limits; rule exports remain schema version **2**. Version-1/2 settings migrate with conservative write-limit defaults and preserve legacy destination inference. Version-1 rule imports still migrate. Back up settings before upgrading or downgrading.

Periodic sweeps reconsider unchanged notes when sweep/always rules cross file-age or property-date thresholds, or when a current-date path template would render a different value. They no longer re-plan every unchanged note on every interval merely because one time-dependent rule exists. Startup, clock rollback, and changed-settings revisions still force a complete monitored pass. Live/manual runs do not mark sweep-only rules as evaluated. Periodic evaluation requires **Periodic sweep** to be enabled; the plugin does not schedule background jobs while Obsidian is closed.

The visual editor supports normal rules directly. Imported rules that cannot be represented without loss are kept in an advanced raw-JSON editor instead of being converted to a blank draft.

The editor and import report warn about potentially repeated appends and self-referential name/path templates. Editor saves require acknowledging these warnings, but never silently change the rule. Warnings are heuristics: a guarded rule may be intentional. `stopOnMatch` ends one reconciliation only; it does **not** prevent another live event after the rule's own write. Prefer a condition that becomes false after the intended change, or a manual-only rule for intentional one-shot appends.

## Bases Integration

Obsidian Bases can supply the files for a manual batch workflow:

1. Create or open a Base.
2. Add the **Vault Flow plan** view.
3. Filter, sort, group, and limit files with native Base controls. Vault Flow follows the current grouped and limited result set.
4. Choose one planning mode in the view options:
   - **Run Vault Flow manual rules** evaluates the current manual/always rules.
   - **Move using a Base property or formula** reads a selected text, link, or file-valued source. Choose **Folder** or **Complete file path** explicitly, or retain **Auto (legacy)** for existing views. Unsupported lists, objects, dates, numbers, and booleans are reported instead of being coerced into folder names.
   - **Rename using a Base text property or formula** uses the computed text as the basename, retaining the note's extension and folder.
   - **Set a property using a Base value or formula** assigns the selected text, finite number, or boolean to the configured target property. Zero and false are preserved; unsupported types are rejected. For dates, use a formula that formats a Properties-compatible date string. The special `tags` property retains Vault Flow's existing merge semantics; use an explicit `replaceTags` rule for replacement.

   Formula-derived names and paths are literal values, not a second round of Vault Flow template evaluation.
5. Choose a bounded page size, select planned rows, and choose **Open apply preview**.
6. Recheck the rows, then choose **Apply selected**.

Bases provides the filtered entry set and display context. Vault Flow caches unchanged plans, paginates rendering, respects native grouping, and rechecks the Base result/configuration snapshot through lock waits and preparation before the first write. Once writing starts, the reviewed selection is frozen so its own changes can update the query without invalidating the remaining rows. Each note still undergoes stale-baseline checks; use **Cancel remaining** if you change the Base criteria mid-batch. Active-note, vault, and Bases previews offer expandable before/after property details; errors show their reason, and failed Bases refreshes offer **Retry**. It still performs eligibility checks, planning, collision handling, per-note stale-baseline checks, serialized writes, diagnostics, and undo capture.

## When To Use Built-In Obsidian Features Instead

Vault Flow is for repeatable automation and reviewed batch mutations, not a replacement for Obsidian's organization tools. Start with the smallest native workflow that meets your need:

| Need | Prefer built-in Obsidian | Use Vault Flow when… |
| --- | --- | --- |
| Find notes by tags, paths, properties, or text | [Search](https://obsidian.md/help/plugins/search); save frequently used searches with [Bookmarks](https://obsidian.md/help/plugins/bookmarks). | Matching should trigger a move, rename, or property action automatically. |
| Inspect a filtered set of notes | [Bases](https://obsidian.md/help/bases) filters, sorting, grouping, formulas, and table/cards/list views. | You want to preview and apply rules to that Base result set. |
| Track status or manually move files between folder columns | Native [Bases Kanban](https://obsidian.md/help/bases/views/kanban). Group by a note property to update it by dragging cards; **group by `file.folder` to move files between folders**. | A status change should trigger an automatic move, or destinations need calculation, collision handling, reviewed batches, or transaction undo. |
| Insert standard properties and dates on demand | [Templates](https://obsidian.md/help/plugins/templates), optionally with Daily notes. Inserting a template also merges its properties into an existing note. | Initialization must be conditional, automatic, or applied across a reviewed batch. |
| Edit metadata manually | [Properties](https://obsidian.md/help/properties), or native Base table cells with selection, copy/paste, and property undo/redo. Rename a property name from All Properties. Formula values are derived, not stored updates; general conditional bulk editing still needs another tool. | Changes must be conditional, repeated, or applied as a reviewed batch. |
| Move or rename selected files once | [File Explorer](https://obsidian.md/help/plugins/file-explorer) and native move/rename commands. | Destinations or names should be derived from rules, properties, or formulas. |
| Recover older note content | File recovery and, when enabled, Obsidian Sync version history. Keep independent backups too. | You want to reverse a specific recent Vault Flow transaction without overwriting newer frontmatter changes. Native recovery is a safety net, not a substitute for transaction undo. |

### Let Bases select; let Vault Flow apply

For manual workflows, keep selection logic in the Base rather than duplicating it in rule predicates. For example:

1. Create a Base that filters project notes and groups them by `status`.
2. Add a formula named `destination`: `if(note.status == "done", "Archive", "Projects")`.
3. Add the **Vault Flow plan** view, choose **Move using a Base property or formula**, and select that formula.
4. Review the plans, select rows, and open the apply preview. Pagination renders at most 100 pending rows at once; selections are retained across pages and the summary counts every selected page.
5. Confirm **Apply selected** only after checking the proposed destinations. This explicit operation writes even if global dry-run is enabled.

The current supported public 1.15 release also improves native Bases filter reordering and result-limit reporting. Vault Flow does not need a second filter editor to benefit from those improvements. The minimum remains 1.14.4; there is no need to raise it for this workflow. Bases still does not expose a supported headless query API for Vault Flow's live/startup/periodic automation.

## Commands

- **Vault Flow: Pause or resume writes (this device session)**
- **Vault Flow: Reconcile active note**
- **Vault Flow: Preview active note changes**
- **Vault Flow: Reconcile entire vault**
- **Vault Flow: Reconcile current folder**
- **Vault Flow: Explain this note**
- **Vault Flow: Show diagnostic log**
- **Vault Flow: Open diagnostics**
- **Vault Flow: Find duplicate source URLs**
- **Vault Flow: Preview vault changes**
- **Vault Flow: Show undo history**
- **Vault Flow: Show apply batch receipts**
- **Vault Flow: Export diagnostics to Markdown**
- **Vault Flow: Export settings to clipboard**

File and multi-file context menus also expose manual reconciliation for eligible Markdown files. Commands that need an active Markdown note are unavailable when their preconditions are not met.

### Obsidian CLI inspection

On Obsidian 1.14.4 or newer with the official CLI enabled, Vault Flow registers three read-only JSON commands:

```sh
obsidian vault="VAULT" vault-flow:status
obsidian vault="VAULT" vault-flow:diagnostics limit=20 outcome=error
obsidian vault="VAULT" vault-flow:plan path="Inbox/Example.md" trigger=manual
```

`vault-flow:plan` uses an exact vault-root path and evaluates `manual`, `live`, or `sweep` rules without writing. Its bounded summary includes paths, rule IDs, mutation kinds, and changed property names, but omits note bodies and property values. Diagnostics can still contain private paths and rule identifiers; review output before sharing. The Obsidian app must be running as required by the official CLI.

## Diagnostics And Undo

Recent decisions include outcomes, involved rules, mutations, desired paths, and transaction snapshots when a write occurred. History is device-local and bounded; it is not written to a hardcoded `.obsidian` path or synced as normal plugin settings.

Runtime persistence failures produce a notice: in-memory undo may remain available, but it may not survive restart. The mtime cache and diagnostics view refreshes are batched to reduce large-scan overhead.

**Export diagnostics to Markdown** creates a timestamped note through the Obsidian Vault API. Exported diagnostics can contain note paths and rule identifiers, so review them before sharing.

**Explain this note** performs a fresh, read-only evaluation using the same planner and engine as automation. Switch between manual/live/sweep triggers to inspect predicate outcomes, short-circuited branches, exported captures, intermediate paths/property changes, missing template values, and convergence results. It shows up to 200 rule evaluations with lazy, bounded predicate details. This is a rules snapshot, not confirmation that collisions, write permissions, or unsaved editor text permit an actual write.

Undo is optimistic rather than destructive: Vault Flow verifies the path, SHA-256 digest, creation/modification times, file size, and complete frontmatter after-state before restoring the recorded before-state. This is deliberately conservative: even body-only edits or automatic link updates can make an older transaction unavailable. Legacy records without a verified fingerprint cannot be undone. Keep native recovery and independent backups for broader recovery needs.

**Undo batch** attempts retained members of a reviewed batch in reverse order, checking every note independently. It is not an all-or-nothing transaction: changed, replaced, missing, conflicting, or no-longer-retained notes are preserved, and write limits still apply.

**Show apply batch receipts** displays per-batch totals and paginated per-row outcomes and actual destination paths. Stored receipts link to journal transactions by ID. Receipts retain at most 20 batches, seven days, and 256 KiB of UTF-8 JSON, with at most 2,000 detailed rows per batch; truncation is labelled. They omit note bodies and frontmatter snapshots but still contain private paths and error text. Receipts are finalized when a batch returns; a process crash can leave undo-journal transactions without a final batch receipt.

## Development

```sh
npm ci
npm run check
```

Useful scripts:

- `npm run dev`: watch and rebuild `main.js`.
- `npm run typecheck`: type-check against the declared Obsidian API.
- `npm run lint`: run the recommended `eslint-plugin-obsidianmd` flat configuration plus project rules.
- `npm test`: run the Vitest suite.
- `npm run build`: type-check and create a production bundle.
- `npm run verify:mobile-bundle`: bundle for a browser with only `obsidian` external, rejecting accidental Node.js or Electron dependencies.
- `npm run check`: lint, type-check, test, verify metadata and mobile compatibility, and rebuild.
- `npm run sync:version`: derive `manifest.json` and `versions.json` from `package.json`.
- `npm run test:obsidian:prepare`: create a fresh synthetic test vault without launching Obsidian.
- `npm run test:obsidian -- --root … --vault … --cli … --allow-runtime`: explicitly opt into the isolated desktop smoke driver after manually opening the generated vault. The driver validates the exact generated path and bundle before touching UI or notes, writes its evidence into that fixture, and never treats mock-CLI tests as real-app verification.

Copy or symlink `main.js`, `manifest.json`, and `styles.css` into `<vault-config>/plugins/vault-flow/` for local testing.

## Releases

Version metadata has one source of truth: `package.json`.

1. Run `npm version <patch|minor|major>`. The lifecycle check runs the full suite, then updates `manifest.json` and `versions.json`.
2. Review and push the generated version commit and its numeric tag (for example, `0.2.0`; do not prefix it with `v`).
3. The release workflow validates that the tag exactly matches `manifest.json`, audits dependencies, rebuilds the tracked bundle, and publishes an immutable release. It refuses to overwrite an existing release tag or its assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`

Pull requests and pushes to `main` run the same checks on the minimum supported Node line and current Node.

## Known Limitations

- Only Markdown files are processed. Canvas support is intentionally not advertised or partially enabled.
- Vault-wide changes are not atomic across multiple files; each selected note is validated and transacted independently.
- Undo history is bounded and device-local (100 transactions, seven days, 1 MiB). Native File recovery, Sync history, and independent backups remain necessary.
- Native Bases has no supported headless query API, so live and sweep automation continue to use Vault Flow's planner rather than a Base query.
- Rule and exclusion globs use a linear-time matcher, have a 1,024-character limit, and retain the `*`, `**`, and `?` dialect. Invalid saved patterns disable automation and settings writes without overwriting the original settings. Matching uses RE2 Unicode case-insensitive semantics.
- User regexes use linear-time RE2-compatible syntax rather than the full JavaScript RegExp syntax. Scope full-content automatic rules narrowly; large inputs can still be expensive.
- The synthetic Obsidian 1.15.1 desktop smoke flow has been exercised, but minimum-version desktop, physical mobile devices, Sync, external-file views, pop-out windows, accessibility, and very large vaults still need real-application verification before a public release.

## License

MIT. See [LICENSE](LICENSE).
