# dsh-session-importer

English | [中文](README.zh.md)

Import an exported session-log ZIP back into DeepSeek Harness (DSH) from the
web GUI. The session, its sub-session logs, and the attachments they reference
are restored through the ordinary Session services, so an imported session is
indistinguishable from one created natively — it appears in the sidebar and
opens, pages, and resumes like any other.

The archive format is the one produced by `@deepseek-ai/dsh-session-log-export`
(the **Download session log** menu item in the session header, or `/export`):
`dsh-session-<id>.zip`. An archive exported by an *older* DSH is migrated to the
installed session format on import, so a download stays usable across upgrades.

The plugin follows the deployed harness rather than pinning one release: the
host half uses only the long-standing Session service contracts, and the browser
half uses the primitives' current icon names. The two things it needs from the
installation are used defensively and reported when missing rather than assumed
— the session-format library (present wherever the JSONL persistence backend is
mounted) and the session list's `retainedBy.mainView`, which is how the shell
itself decides which session is open. See `format.migrationUnavailable` and the
dialog's workspace fallback line.

### Compatibility

Verified against `@deepseek-ai/dsh` **0.2.1-rc.2** (session format generation 4).

| DSH | Status |
|---|---|
| 0.2.1-rc.2 | verified — the current target |
| 0.2.0-rc.2 | verified earlier; the browser half opens the imported Session through `uiWorkspace.openSession()`, which both releases provide |

Two upstream details moved between those releases and are handled here: the
session list snapshot no longer carries a `current` field (the open session is
read from `retainedBy.mainView` instead), and the icons lost their old
size-suffixed aliases. The **Open session** button in the dialog asks the
workspace facade to reveal the imported Session — `ISessions.open()` does not
exist in DSH 0.2.x, so the earlier `typeof service.open === 'function'` guard
silently did nothing.

## Install

```sh
dsh plugin --profile web add E:/Project/dsh-ext/dsh-session-importer
```

That installs the package into the profile and activates its bundle layer. If
the profile does not already link this directory, use an absolute path, or add
the patch row by hand:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: session-importer
      name: 'E:/Project/dsh-ext/dsh-session-importer/src/index.js'
```

Then **restart `dsh web`** — a new plugin is loaded from the profile at boot,
and the browser needs the new client bundle. Check that the row appears in
`dsh --profile web --dump-config`.

## Use

Two entry points open the same dialog:

| Where | What |
|---|---|
| Session header → more-actions menu | **Import session**, directly under **Download session log** |
| Sidebar footer | **Import session** (always available; collapses to an icon in the rail) |

The header entry sits inside the menu the Session-log export plugin owns, so the
two export/import actions read as one pair. That menu is built from a literal
item array, so the item is added by injecting markup into the rendered menu
([details](#the-header-menu-item)); the sidebar entry is the one that needs no
such cooperation, and it stays available in every composition.

DSH 0.2.1 does expose a first-class slot for Session-header entries,
`conversation.session.header.utilities`, which the export plugin itself
registers into. An entry registered there renders as **its own cell in the
header**, not inside the more-actions menu, so it cannot take the place of the
menu item — the injection below remains how this plugin sits *next to* the
download action.

In the dialog:

1. Drop a `dsh-session-<id>.zip` on the drop zone, or click it to choose a
   file. For a deployment that keeps archives on the server, type an absolute
   host path instead.
2. Choose where the session should be filed: keep the archived workspace
   (default when that directory exists), the current session's workspace, or an
   explicit path.
3. **Import**. The dialog reports what was written — sessions, attachments,
   workspace group — and then offers **Open session**.

The session also appears in the sidebar immediately, because the client asks
the host to re-read its session list when the import succeeds. Nothing else
needs a reload.

### The header menu item

`@deepseek-ai/dsh-session-log-export` renders the Session header's more-actions
menu from a literal `items` array, so the import item is injected into that
menu's DOM when it opens:

- the injected node is a **clone of the download item**, so it inherits the
  primitive's own classes, hover treatment, and locale-agnostic styling without
  this plugin knowing a single hashed class name;
- the menu walks `button:not(:disabled)` live for arrow-key navigation, so the
  injected button joins the keyboard model for free;
- the menu is rebuilt on every open, so nothing long-lived needs keeping in
  sync — injection is driven by the menu's own insertion rather than by a
  blanket body observer, so streaming conversation updates cost nothing, and a
  menu without a recognizable download item is left alone;
- the observer and every injected node belong to the plugin's fiber and are
  removed on disposal.

The coupling is documented rather than hidden because it is the only way to sit
*next to* the download action instead of beside it: if a future DSH release
changes that menu's markup, the item silently stops appearing and the sidebar
entry keeps working. `scripts/verify-e2e.ps1` checks the real rendered menu, and
`-ProbeUi` dumps what the page actually rendered when that check fails.

## What an import writes

| Archive entry | Imported as |
|---|---|
| `session[.vN].jsonl` | the root session (the row that shows in the sidebar) |
| `subagents/<id>/session[.vN].jsonl` | one session per subagent, keeping its lineage |
| `media/<attachmentId>.<ext>` | an image restored into the attachment store |
| `files/<xx>/<digest>/<name>` | a verbatim file restored into the attachment store |

Logs are written through `ctx.sessionPersistence.create()` /
`handle.append()` / `handle.flush()` rather than by writing files: the
persistence provider owns the zstd framing, the checksum layout, the injective
id escaping, and the project-directory naming, and the import therefore works
against any mounted backend instead of only the JSONL one.

An archive carries the **format generation** it was exported at, while DSH only
ever writes the generation it implements. An archive from an older DSH is
therefore handed to that installation's own format library for migration before
anything is written — the same code DSH uses to read an old log, so nothing is
reimplemented here and nothing is guessed. The migration is not a version
number: an older edge lifts tool results into the current role, renames message
sources, closes evidenced interrupted turns, and appends a parent's missing
subagent catalog facts. The plan, the response, and the dialog all report the
archive's generation, the installed one, and whether a migration happened.

### Guarantees

- **Identity is preserved.** Session ids inside an archive reference each other
  (subagent headers name their parent, tool results name subagent sessions), so
  ids are recreated verbatim; the tree stays internally consistent, and the
  subagent view inside the imported session works.
- **Older generations are migrated, newer ones are refused.** An archive whose
  logs predate the installed generation is translated by the installed format
  library first. An archive from a *newer* DSH is refused with the two version
  numbers rather than imported as something this build would misread.
- **Never destructive.** A session id that already exists is *skipped*, never
  overwritten. Re-importing an archive is a no-op that reports
  `alreadyImported: true`, and an import that only partially succeeded can be
  repaired by importing the same archive again — the sessions that are missing
  get written, the ones already present are skipped.
- **Verified or rolled back.** After writing, every imported log is read back
  through the persistence read path, which is where the harness validates the
  event vocabulary and replay invariants. A log this build cannot interpret
  (for example an archive from a newer harness) fails loudly and its files are
  removed again, so a broken session never lands in the sidebar.
- **Grouping is best effort — and says why when it fails.** The root session is
  filed under its workspace through `ctx.workspaceRegistry`. If the workspace
  record cannot be written or the archived cwd no longer exists locally, the
  session is still imported and visible — it groups under "Ungrouped" and the
  dialog prints the registry's own reason, because the registry can also drop
  the membership silently. Membership is read back after the attach, so "the
  registry wrote nothing" never passes for success.
- **An id that was permanently deleted can be imported and filed again.** A
  plugin that deletes sessions can leave a *tombstone* for the id (the shipped
  `@michengai/dsh-archive-manager` does), making the registry's header index
  refuse to re-index it — that is how it stops a stale `list()` from
  resurrecting a log it just removed. Re-importing after a delete is exactly
  the flow this plugin's own dialog recommends, so the log it writes carries
  such a reused id: before filing, the import asks the deployment's own
  forget-hook (`clearTombstone`, called only when it exists) to drop the stale
  tombstone.

### What is *not* restored

- **Projection-cache rows** (titles, token counts, derived summaries). These are
  display hints that self-heal from the log; none of them decides list
  membership.
- **Workspace display order and archive flags.** Importing does not reorder the
  sidebar, and an imported id is never added to the archived set.
- **Live agent state.** Nothing is resumed: the session is durable history until
  you open it and send a message.

## Configuration

All fields are optional; the defaults below come from the plugin's `Config`
schema. A patch row that sets `config` must restate every key it wants
(a patch replaces the whole config).

| Field | Default | Meaning |
|---|---|---|
| `maxUploadBytes` | `268435456` (256 MiB) | Largest accepted request body, and largest accepted host-path archive |
| `maxExtractedBytes` | `1073741824` (1 GiB) | Largest total inflated archive size, guarding against a decompression bomb |
| `allowHostPath` | `true` | Whether `?path=` / `{"path": …}` imports from the host filesystem are accepted |
| `workspace` | `'auto'` | Default target-workspace policy: `auto`, `original`, or `current` |
| `verifyRead` | `true` | Read every imported log back before reporting success |
| `sessionsRoot` | `''` | Session-log root used only for rollback cleanup; empty resolves `$DSH_HOME/sessions` |

```yaml
- id: session-importer
  config:
    maxUploadBytes: 67108864
    maxExtractedBytes: 268435456
    allowHostPath: false
    workspace: current
    verifyRead: true
    sessionsRoot: ''
```

## HTTP contract

The host route is an exact Fetch route on the shared API channel, so the
browser session cookie applies and any deployment-provided `/api` policy is
honoured.

**`GET /api/session.import`** — capability probe; returns the effective limits,
the session-format generation this deployment writes
(`format.installedVersion`), and usage text. No body required.

**`POST /api/session.import`** — import. Query parameters:

| Parameter | Meaning |
|---|---|
| *(raw body)* | the ZIP bytes; this is what the dialog sends |
| `path` | absolute host path of the archive, instead of a body |
| `workspace` | `auto` \| `original` \| `current` |
| `cwd` | absolute path overriding `workspace` |
| `sessionId` | the importing session, used to resolve `workspace=current` |
| `dryRun=true` | parse and plan, write nothing |

`Content-Type: application/json` with `{"path": …}` is accepted as an
alternative to `?path=`. A JSON response describes the plan, what was
imported, what was skipped, whether the sessions verified, attachments
restored, the workspace outcome, and any errors or warnings. Invalid archives
answer `400`; a failed import answers `500` with the per-session errors.

Every response and the plan carry a `format` block:

| Field | Meaning |
|---|---|
| `archivedVersion` | format generation found in the archive's logs |
| `installedVersion` | generation this deployment writes (`null` if unknown) |
| `migrationRequired` | whether importing would translate the logs (plan only) |
| `migratedSessions` | how many logs were translated (import response only) |
| `migrationUnavailable` | why the generation could not be checked, when it could not |

```sh
# inspect without importing
curl -X POST 'http://127.0.0.1:8080/api/session.import?path=E:/backup/dsh-session-x.zip&dryRun=true'
# import
curl -X POST --data-binary @dsh-session-x.zip -H 'content-type: application/zip' \
     'http://127.0.0.1:8080/api/session.import?workspace=current'
```

In the running web GUI these calls need the browser-session cookie; drive them
from the page (or from the dialog) rather than from a bare shell.

## Model tool

The plugin also registers `import_session_archive` (`path`, optional `dry_run`,
optional `cwd`), so the agent can import an archive it can see on the host
filesystem and report what changed. A model call has no dialog to pick a
workspace, so the **calling session is the importing session**: with no `cwd`
the import is filed exactly as the dialog would file it — the archived workspace
when that directory still exists locally, otherwise the calling session's own
workspace. The Host process's launch directory is only the last resort, and the
dry run names which one it used.

## Limits

- **One import at a time per request.** The dialog collapses a double-click, but
  concurrent imports of different archives are independent requests.
- **The browser path buffers the archive.** Uploads go through the buffered
  Fetch route (the deployment caps it at 300 MiB overall); the plugin's own
  `maxUploadBytes` is the tighter limit. For a very large archive, use a host
  path instead of an upload.
- **cwd must exist.** Workspace grouping needs the archived directory to exist
  so the registry can canonicalize it; a cwd that resolves elsewhere is filed
  under "Ungrouped" rather than moved.
- **Seed cut reconstruction.** A fork-seeded log (`isSeeded: true`) is restored
  with the inherited cut derived from its inherited `session/end-seed` marker.
  An archive that lost that marker is refused rather than imported with a
  guessed cut.
- **An archive newer than the deployment is refused.** Migration runs forward
  only; a log from a *newer* DSH is rejected with both version numbers instead of
  being written as something this build would misread. The
  [format probe](#development) shows what a given installation does to an old
  log without booting an instance.
- **Rollback is filesystem-level.** A verified-bad import removes its log
  directories; the in-process session registry may still list the id until the
  next restart if the removal itself failed (the response says so when that
  happens).
- **An existing session cannot be moved between workspaces.** A session belongs
  to the workspace whose path matches the `cwd` recorded in its log header, and a
  stored header is immutable (the log is append-only). Re-importing an archive
  therefore never relocates a session, whatever workspace you pick — delete that
  session and import again to file it elsewhere. The dialog says this instead of
  reporting a silent no-op.
- **"Current workspace" means the session you have open.** The browser sends the
  selected session id and the host reads its stored `cwd`. With no session open
  there is nothing to resolve, and the host falls back to its own working
  directory — which the response and the dialog both report, because that
  directory decides the group.
- **A deletion overlay can change what "import again" means.** The
  delete-and-re-import route assumes the id is clean once the log is gone. A
  plugin that keeps a tombstone for deleted ids is asked to forget it (see
  [Guarantees](#guarantees)); when the mounted registry offers no such hook, or
  hides ids some other way, grouping fails and the dialog shows the registry's
  own message instead of an unexplained "Ungrouped".
- **The header menu item depends on another plugin's markup.** It is injected
  into the Session-log export plugin's menu (see
  [The header menu item](#the-header-menu-item)), so a release that changes that
  markup drops the item — quietly, and without affecting the sidebar entry. A
  composition without that plugin never gets the item at all.

## Development

No build step: `src/index.js` is the host half, `src/client.js` is the browser
half as a classic `window.__ModuleLoader__.load` bundle, `src/format.js` is the
only part that imports anything beyond Node built-ins (it loads the running
installation's session-format library by resolved path — the catalog first, then
the historical edge packages *from the catalog's own scope*, because a pnpm
installation nests them under it), and the ZIP reader in
`src/zip.js` is a deliberate ~150-line central-directory parser so the package
needs no dependency install in a profile.

```sh
npm test                      # syntax checks + archive smoke test
npm test -- path/to/archive.zip   # …against a specific archive
npm run verify:e2e            # 28 checks against a throwaway DSH instance (PowerShell 7)
node test/smoke.mjs path/to/other.zip
node test/format-probe.mjs path/to/archive.zip   # what this DSH does to an old log
```

Both the smoke test and the E2E leg need a real exported archive, which is user
data rather than a checked-in fixture: pass it as an argument, set
`DSH_TEST_ARCHIVE`, or put a `dsh-session-*.zip` next to `package.json`.

`test/smoke.mjs` exercises the ZIP reader and the import planner against a real
exported archive: entry classification, header adoption, per-session plans with
contiguous events, id preservation, cwd stamping, attachment remapping, and the
planner's refusals (no root log, unknown header field, non-contiguous log,
seeded log without its marker). It needs no DSH instance.

`test/format-probe.mjs` drives the installed session-format library directly
against an archive, using absolute paths because a plain `node` process has none
of the loader's resolution. It prints each log's source generation, the migrated
generation, event-count deltas, seq density, and the transformations it can see
(tool-result roles, parent catalog facts), which is the fastest way to find out
what a DSH upgrade will do to an existing archive.

`scripts/verify-e2e.ps1` boots a throwaway `dsh web` and drives the whole path
over HTTP, then (with a Chromium-family browser installed) drives the real GUI
headless through the DevTools Protocol. It asserts on outcomes rather than on
logs, because the browser half of this plugin is the part that cannot be checked
any other way:

| Group | Checks |
|---|---|
| Composition | the overlay keeps exactly one plugin row and points it at this checkout |
| Plugin halves | bundle present in `__DSH_BOOT__`, served bundle is this client half, fiber `active`, route answers a probe with this deployment's session format |
| Import planning | a dry run plans every log without writing, entry accounting adds up, the root keeps its id, the archive's generation is compared against the installed one |
| Import | every session written, the reported migration count matches the plan, every log read back by the reader, attachments restored, root filed under its workspace |
| Visibility | `session/list` carries the sessions with the right cwd, `session/page` loads the root and a subagent child |
| Idempotency | a repeat import writes nothing and reports `alreadyImported`, a dropped descendant is repaired by re-importing |
| Workspace choice | `workspace=current` resolves against the named session, an unresolvable one reports the directory it fell back to, and a repeat import with a different choice explains that an existing session cannot be moved |
| Refusals | raw-body upload imports a current-generation archive without migrating it, a non-ZIP answers 400, an unknown event vocabulary is refused and rolled back with no leftover |
| Browser (headless) | the client half boots in a real browser, the **imported** session's own row opens (selected by session id, not by label), its more-actions menu shows **Import session** directly after **Download session log**, clicking the item opens the import dialog, and the dialog's fields and its 3 policy options stay legible and fully on screen (composited contrast on the trigger and every option, no clipped label, and the list inside the viewport — all under the deployment's own skin and material) |

```sh
pwsh -NoProfile -File scripts/verify-e2e.ps1                 # sample archive in the repo root
pwsh -NoProfile -File scripts/verify-e2e.ps1 -Archive x.zip  # a specific archive (or set DSH_TEST_ARCHIVE)
pwsh -NoProfile -File scripts/verify-e2e.ps1 -SkipUi         # HTTP half only, no browser
pwsh -NoProfile -File scripts/verify-e2e.ps1 -ProbeUi        # dump the rendered shell instead of asserting
pwsh -NoProfile -File scripts/verify-e2e.ps1 -Archive x.zip -KeepScratch
```

It builds the scratch instance from a copy of the target profile with its
`node_modules` linked (a boot runs no package install, so this needs no network
and installs nothing), mounts the plugin by absolute source path — patching the
row rather than inserting it when the package is already installed in the
profile, which would otherwise be a duplicate-id failure — and boots on an
OS-assigned port. It also copies the deployment's theme state
(`dream-skin.json`, `settings.yaml`; `-ThemeHome` points somewhere else) into the
scratch home, so the browser leg renders the skin, material preset, and wallpaper
the user actually has. Nothing is written to the real DSH home, and the run ends
by stopping both processes, removing the scratch tree, and re-checking that the
real profile's install is still there.

The browser leg (`scripts/verify-ui.mjs`) walks the real first-run flow — dismiss
the beta notice, pick the workspace that owns the imported sessions, open the
session the run imported by its `data-row-key` — and writes screenshots of both
asserted states to `docs/evidence/`. It needs no dependency: the DevTools
Protocol runs over Node's global `WebSocket`. Two details of that flow are worth
knowing before changing it: a first-run workspace pick starts a *blank draft*
whose sidebar row is unlabelled in exactly the same way an imported session with
no title projection is, which is why the row is addressed by session id rather
than by label; and the page can legitimately hold several menus, so the dialog's
policy list is identified as the one the trigger's own click added, never as
"the first menu with enough items" (a session row's context menu has five).

Both scripts are PowerShell 7 only (junctions/symlinks, `-SkipHttpErrorCheck`)
and work on Windows, Linux, and macOS. Three environment behaviours they work
around, all of them normal under a restricted Windows policy: `taskkill /T` and
`Get-NetTCPConnection` can be refused, so descendant cleanup falls back to
`netstat -ano` plus `Stop-Process`; killing the direct child is what lets the
script return at all (PowerShell keeps draining a spawned process's redirected
streams until that child's handles close); and a sandbox that blocks named pipes
stops Chromium from starting at all, in which case the browser leg cannot run
(`-SkipUi` makes that explicit).

`notes/dsh-session-list-state.md` records the session-list findings this design
rests on (membership comes from the persistence directory scan; `workspace`
accounting decides grouping only; nothing pushes a new row for a cold session).
