# dsh-session-importer

English | [中文](README.zh.md)

Import an exported session-log ZIP back into DeepSeek Harness (DSH) from the
web GUI. The session, its sub-session logs, and the attachments they reference
are restored through the ordinary Session services, so an imported session is
indistinguishable from one created natively — it appears in the sidebar and
opens, pages, and resumes like any other.

The archive format is the one produced by `@deepseek-ai/dsh-session-log-export`
(the **Download session log** menu item in the session header, or `/export`):
`dsh-session-<id>.zip`.

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
item array with no contribution point for another plugin, so the item is added
by injecting markup into the rendered menu ([details](#the-header-menu-item));
the sidebar entry is the one that needs no such cooperation, and it stays
available in every composition.

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
menu from a literal `items` array, so there is no slot, service, or hook another
plugin can use to add an entry. The import item is therefore injected into that
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
| `session.v3.jsonl` | the root session (the row that shows in the sidebar) |
| `subagents/<id>/session.v3.jsonl` | one session per subagent, keeping its lineage |
| `media/<attachmentId>.<ext>` | an image restored into the attachment store |
| `files/<xx>/<digest>/<name>` | a verbatim file restored into the attachment store |

Logs are written through `ctx.sessionPersistence.create()` /
`handle.append()` / `handle.flush()` rather than by writing files: the
persistence provider owns the zstd framing, the checksum layout, the injective
id escaping, and the project-directory naming, and the import therefore works
against any mounted backend instead of only the JSONL one.

### Guarantees

- **Identity is preserved.** Session ids inside an archive reference each other
  (subagent headers name their parent, tool results name subagent sessions), so
  ids are recreated verbatim; the tree stays internally consistent, and the
  subagent view inside the imported session works.
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
- **Grouping is best effort.** The root session is filed under its workspace
  through `ctx.workspaceRegistry`. If the workspace record cannot be written or
  the archived cwd no longer exists locally, the session is still imported and
  visible — it simply groups under "Ungrouped", and the dialog says so.

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

**`GET /api/session.import`** — capability probe; returns the effective limits
and usage text. No body required.

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
filesystem and report what changed.

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
- **The header menu item depends on another plugin's markup.** It is injected
  into the Session-log export plugin's menu (see
  [The header menu item](#the-header-menu-item)), so a release that changes that
  markup drops the item — quietly, and without affecting the sidebar entry. A
  composition without that plugin never gets the item at all.

## Development

No build step: `src/index.js` is the host half, `src/client.js` is the browser
half as a classic `window.__ModuleLoader__.load` bundle, and the only runtime
dependencies are Node built-ins (`node:fs`, `node:path`, `node:zlib`). The ZIP
reader in `src/zip.js` is a deliberate ~150-line central-directory parser so the
package needs no dependency install in a profile.

```sh
npm test              # syntax checks + archive smoke test
npm run verify:e2e    # 24 checks against a throwaway DSH instance (PowerShell 7)
node test/smoke.mjs path/to/other.zip
```

`test/smoke.mjs` exercises the ZIP reader and the import planner against a real
exported archive: entry classification, header adoption, per-session plans with
contiguous events, id preservation, cwd stamping, attachment remapping, and the
planner's refusals (no root log, unknown header field, non-contiguous log,
seeded log without its marker). It needs no DSH instance.

`scripts/verify-e2e.ps1` boots a throwaway `dsh web` and drives the whole path
over HTTP, then (with a Chromium-family browser installed) drives the real GUI
headless through the DevTools Protocol. It asserts on outcomes rather than on
logs, because the browser half of this plugin is the part that cannot be checked
any other way:

| Group | Checks |
|---|---|
| Composition | the overlay keeps exactly one plugin row and points it at this checkout |
| Plugin halves | bundle present in `__DSH_BOOT__`, served bundle is this client half, fiber `active`, route answers a probe |
| Import planning | a dry run plans every log without writing, entry accounting adds up, the root keeps its id |
| Import | every session written, every log read back by the reader, attachments restored, root filed under its workspace |
| Visibility | `session/list` carries the sessions with the right cwd, `session/page` loads the root and a subagent child |
| Idempotency | a repeat import writes nothing and reports `alreadyImported`, a dropped descendant is repaired by re-importing |
| Workspace choice | `workspace=current` resolves against the named session, an unresolvable one reports the directory it fell back to, and a repeat import with a different choice explains that an existing session cannot be moved |
| Refusals | raw-body upload imports, a non-ZIP answers 400, an unknown event vocabulary is refused and rolled back with no leftover |
| Browser (headless) | the client half boots in a real browser, a Session opens, its more-actions menu shows **Import session** directly after **Download session log**, clicking the item opens the import dialog, and the dialog's fields and workspace menu stay legible and fully on screen (composited contrast on the trigger and every menu option, no clipped label, and the list inside the viewport — all under the deployment's own skin and material) |

```sh
pwsh -NoProfile -File scripts/verify-e2e.ps1                 # sample archive in the repo root
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
the beta notice, pick the workspace that owns the imported sessions, open an
imported session — and writes screenshots of both asserted states to
`docs/evidence/`. It needs no dependency: the DevTools Protocol runs over Node's
global `WebSocket`.

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
