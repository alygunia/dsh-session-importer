# What makes a session appear in the dsh web sidebar (evidence report)

Base path `$B = C:\Users\alygu\scoop\persist\nodejs-lts\bin\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
(compiled, installed copy; all quotes are from `lib/*.js` / `lib/types/*.d.ts` / `README.md`).

## 1. Who produces the sidebar session list, and who owns *membership*

Chain, browser → host:

- `dsh-client-ui-sidebar` is only a shell: "ui-workspace fills `sidebar.workspaces`" (`dsh-client-ui-sidebar/README.md:28`).
- `dsh-client-ui-workspace/lib/client.js` renders `WorkspaceBrowser` into that slot (line 2794 `ctx.slots.inject("sidebar.workspaces", ...)`) and derives rows from **two inputs**: the client session-list snapshot and the workspace projection.
  `lib/types/client/tree.d.ts:2-4`:
  > Derives the workspace browser tree from Host Workspace order and membership.
  > Unassigned Sessions trail under Ungrouped; only the selected blank Session remains visible.
  `deriveGroups(list: SessionListState, workspaces, archivedSessionIds, ...)` (`tree.d.ts:109`).
- The session-list snapshot itself comes from the **session controller client**: `dsh-api-session-controller/lib/client.js:2486` `refreshList()` → `:2496` `await this.remote.session.list({})` → `SessionManager.summaries` → `buildListSnapshot()` (`:2892`, reads `displayTitle`, `projectionValues`).
- Host-side, `session.list` is served by `ApiSessionList.list()` in `dsh-api-session-controller/lib/index.js:1829-1847`:
  ```js
  async list(signal) {
      const records = await this.ctx.sessionQuery.listSessions(signal);   // :1831  <-- universe
      ...
      const live = this.ctx.sessions.get(record.header.id);
      if (live !== void 0) { items.push(this.summaryFor(live)); continue; }
      if (record.header.cwd === void 0) continue;                        // :1841  <-- cwd REQUIRED
      cold.push(record.header);
      ...
      items.sort((left, right) => right.updatedAt - left.updatedAt);
  ```
- `ctx.sessionQuery.listSessions()` (`dsh-session-query/lib/index.js:94-115`) = persisted listing ∪ live `ctx.sessions.list()`, and `listPersisted` (`:282-284`) is literally `persistence.list()`:
  ```js
  return (await persistence.list(...)).map((snapshot) => snapshot.header);
  ```
- `dsh-session-persistence-jsonl` `list()` (`lib/index.js:2454-2481`) → `listArtifacts()` (`:2858-2888`) = a **fresh `readdir` walk** of `<root>/<project>/<session>/` reading each header frame. `listProjectDirs` (`:3256-3266`), `listSessionDirs` (`:3268-3275`).

**Source of truth for membership = the persistence directory scan** (`sessionQuery.listSessions` → `sessionPersistence.list()`), exposed as `session.list`.
**`dsh-workspace` is not a membership source**: its `sessionIds` only assigns a session to a *group*. `dsh-api-workspace-controller` only projects those records; `dsh-session-projection-cache` only supplies display hints (`blank`, `lastPromptAt`, title).

Grouping filter (`dsh-client-ui-workspace/lib/client.js:389-405`):
```js
for (const workspace of workspaces) {
  for (const id of workspace.sessionIds) { const summary = list.byId[id]; if (summary === void 0) continue;
    accounted.add(id); ... }
}
const stray = list.ids.map((id) => list.byId[id])
  .filter((s) => s !== void 0 && !accounted.has(s.id) && sessionVisible(s, list.current, archived));
if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", ...));   // Ungrouped
```
Row visibility (`client.js:338-340`):
```js
function sessionVisible(session, current, archived) {
  return session.origin !== "subagent" && !archived.has(session.id) && (!session.blank || session.id === current);
}
```

## 2. Is writing a valid session log directory enough? Is a `storageDomain` row required?

**A valid directory is enough for the row to appear — under *Ungrouped*.** No `workspace`/`workspaces` row and no `session_projcache` row is required for membership. Workspace accounting *is* required for the session to be filed under its project group.

Preconditions the code actually enforces for appearance:

- header parses in the current (or migratable) format and is self-identifying at its path — `dsh-session-persistence-jsonl/lib/index.js:3218-3227`:
  ```js
  expectedPath = generationLogPath(this.root, meta.cwd, meta.id, storedVersion, this.compression);
  if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal))
      throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${expectedPath}"`);
  ```
- `header.cwd` must exist, else the row is dropped (`dsh-api-session-controller/lib/index.js:1841`).
- not `origin: 'subagent'`, not in `archivedSessionIds`, not a blank non-selected session (`client.js:338-340`).
- `sessionIds` absent only changes the group label ("Ungrouped", `group.ungrouped` locale at `client.js:2635`), never visibility.

Workspace bootstrap that would auto-file pre-existing sessions runs **once**, only when the domain is uninitialized — `dsh-workspace/lib/index.js:336-353`:
```js
this.state = domain.global.get();
await this.recoverPendingMutation();
this.validateStoredState(this.state);
if (!this.state.initialized) {                 // :344  only the FIRST start
    const headers = await this.listStoredHeaders();
    await this.replaceHeaderIndex(headers);
    await this.bootstrap(headers);
} else if (this.table.size > 0) await this.replaceHeaderIndex(await this.listStoredHeaders());
```
`bootstrap()` (`:595-667`) groups stored headers by canonical cwd and writes/appends `sessionIds`. After the first start `initialized: true`, an imported log is therefore **never** auto-attached.

Projection cache: optional hints only. `ApiSessionList.projectionsFor` (`:1948-1960`) uses `sessionProjectionCache.cachedSnapshot(...) ?? cachedPredecessorTitle(...)` and degrades to "serve the row without it"; `summarizeCold` uses `metadata?.blank ?? false`. Cache README:65 — "a missing or stale record reads as absent". Missing cache ⇒ the row shows the cwd basename or raw id instead of the durable title (`dsh-api-session-controller/lib/client.js:2992-3003 displayTitleOf`), and it self-heals on the first cold fold (`dsh-session-projection-cache/lib/index.js:282-289 coldSnapshot` folds from the log and writes the row back).

## 3. Workspace record shape, key, and the exact slug encoding

Domain `workspace` v2, `single`-layout JSON unit (live file `C:\Users\alygu\.dsh\storages\workspace.json`):

```json
{ "unit": { "name": "workspace", "version": 2 },
  "global": { "initialized": true,
              "workspaceIds": ["6c3ebe08-…","6f738947-…"],
              "archivedSessionIds": ["session-687e614e-…"] },
  "tables": { "workspaces": {
      "6f738947-ceb0-4842-a149-14cd0713ed25": {
        "path": "E:\\Project\\off-target", "title": "off-target",
        "sessionIds": ["session-7239ba84-5a00-4e14-9eb9-b927e738a876"],
        "createdAt": "2026-09-14T02:21:10.992Z", "updatedAt": "2026-09-14T02:21:11.136Z" } } }
```

- Table `workspaces`, key = `WorkspaceId` (a generated uuid, never the path): `dsh-workspace/lib/types/spec.d.ts:53-84`; `types.d.ts:9-13` "A generated uuid, never the path".
- Record schema `dsh-workspace/lib/types/spec.d.ts:15-21`: `{ path: string; title: string; sessionIds: SessionId[]; createdAt: string; updatedAt: string }`. `sessionIds` array order **is** the manual display order.
- `global` (`spec.d.ts:33-44`): `initialized` (bootstrap marker), `workspaceIds` = "the authoritative display order", `archivedSessionIds` = registry-global archive set (archived ids keep their `sessionIds` slot, `spec.d.ts:27-31`).
- Membership = id in `sessionIds` **and** header cwd canonicalizes to `path`: `dsh-workspace/lib/types/entity.js:51-53`
  ```js
  get sessionIds() { return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path); }
  ```
- Writing the durable record must go through the registry (in-memory table is authoritative for the `single` layout, and `table.update` stamps `updatedAt` + prunes): `entity.js:136-154`.
- Minimal correct registration for one imported session id whose cwd equals the workspace path:
  ```js
  const ws = (await ctx.workspaceRegistry.resolveByPath(cwd)) ?? (await ctx.workspaceRegistry.create(cwd));
  await ws.attachSession(sessionId);       // entity.js:57-89 → prepends, validates cwd, remembers path, table.update
  ```
  `attachSession` validation (`entity.js:62-88`): reads the stored header (`host.readSessionHeader` re-lists persistence on a cache miss, `dsh-workspace/lib/index.js:748-761`), requires `header.cwd` defined, `realpathNormalize(cwd)` to resolve, to be a directory, and to equal `record.path`; otherwise it rejects without writing. New id is **prepended**: `sessionIds: [sessionId, ...record.sessionIds]`.
  There is **no Remote/RPC method** for attaching a session — `dsh-api-workspace-controller/lib/typert.remote-client.d.ts:15-23` lists only `archiveSession, create, delete, follow, insertBefore, insertSessionBefore, rename`, and `insertSessionBefore` rejects unaccounted ids ("workspace/move-invalid").

Slug encoding — `projectKey(cwd)` in `dsh-session-persistence-jsonl/lib/index.js:874-893`:
```js
for (...) { if (ch === "/" || ch === "\\" || ch === ":") { if (!separatorRun) readable += "-"; separatorRun = true; }
            else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false; }
            else { readable += "~" + code.toString(16).toUpperCase().padStart(4, "0"); separatorRun = false; } }
return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
```
So `E:\Project\off-target` → separators `:`+`\` collapse to one `-` → `--E-Project-off-target--` (confirmed live: `C:\Users\alygu\.dsh\sessions\--E-Project-off-target--`).
Path layout: `projectDir(root, cwd) = join(root, projectKey(cwd))` (`:901-904`, `undefined` cwd → `_no-cwd`), `sessionDir = join(projectDir, encodeSegment(id))` (`:913-914`), filename `generationLogFilename(3, 'zstd') = 'session.v3.jsonl.zstd'` (`:760-762`, `SESSION_FORMAT_VERSION = 3` in `dsh-session/lib/types/types.js:54`).
Session-id segment escaping (`:852-864`): `[A-Za-z0-9._-]` literal, everything else `~XXXX` (so `session-2bc3…` stays literal).

## 4. Cache/index invalidation after a log directory appears

- **No host-side list index exists.** `session.list` re-scans the directory tree on every call (`dsh-session-persistence-jsonl/lib/index.js:2858-2888`), so a new directory is picked up by the next `session.list`.
- **The GUI only re-reads on (re)connect / page load.** `dsh-api-session-controller/lib/client.js:3531-3534`:
  ```js
  ctx.on("connection/reset", () => { sessions.handleConnected(); });
  if (ctx.remote.$host.home !== void 0) sessions.handleConnected();
  ```
  → `handleConnected()` (`:2787-2793`) → `refreshList()` → `remote.session.list`. The explicit face is `ctx.sessions.refresh()` (`:3141-3143`, declared in `lib/types/client/contract/sessions.d.ts:68-72`); no bundled package calls it.
- **Nothing pushes an imported session.** Host list additions come only from live sessions: `dsh-api-session-controller/lib/index.js:2749-2751`
  ```js
  ctx.on("session/created", (session) => { ctx.emit("api-session/added", this.listState.summaryFor(session)); });
  ```
  forwarded to the browser via `ctx.remote.$on('api-session/added', …)` (`lib/types/client/index.js:25`). A file that merely appears on disk emits nothing ⇒ **reload (or an explicit client-side refresh) is required** unless the importer makes the session live (`session.create({sessionId})` → resume → `session/created`).
- **Projection cache**: no invalidation needed; identity/version/watermark guarded per read, cold reads refold from the log and write the row back (`dsh-session-projection-cache/lib/index.js:282-289`; README:57 "the next write self-heals").
- **SQLite FTS index** (`dsh-session-query-sqlite`): derived, disposable, reconciled per search against persistence revisions — README:105 "Each search runs one serialized observation: list persistence snapshots, compare per-session revisions with the indexed rows, read only new or changed logs … commit the reconciliation in one transaction before running the query." No manual refresh.
- **Cold observation cache**: keyed by persistence `stat` revision (device/inode/size/ns timestamps), bounded LRU — `dsh-session-query/lib/types/observation.d.ts:39-48`; irrelevant for a brand-new id.
- **Workspace projection is live** (no reload needed for regrouping): `ctx.workspaceController.follow()` "synchronously attaches to durable Workspace changes, emits one complete baseline first, then … `upsert`" (`dsh-api-workspace-controller/README.md:25`); a reconnect starts a new baseline.
- No "rescan"/"refresh" host API exists for persistence; the only refresh faces are the client `ctx.sessions.refresh()` and page reconnect.

## 5. Browser-facing endpoints

- Unary RPC: `POST <origin>/api/<namespace>/<method>` with JSON envelope. `dsh-client-connection/lib/client.js:6197-6211`:
  ```js
  async call(channel, endpoint, payload, signal) {
      const message = { type: "client-request", rpcId, method: endpoint, payload };
      const response = await send(new URL(`${channel}/${endpoint}`, resolveBase()), { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(message), ... });
  ```
  endpoint = `${namespace}/${method}` (`dsh-api-gateway/lib/client.js:1797-1799`, `:990-992`), channel `/api`, response `{ type:"server-response", rpcId, result:{ ok:true, value } | { ok:false, error:{code,message,details} } }`.
  ⇒ Session list: **`POST /api/session/list`**, body `{"type":"client-request","rpcId":"<uuid>","method":"session/list","payload":{}}`.
  Response: `{ items: SessionSummary[] }`, `SessionSummary = { sessionId, updatedAt:number, running:boolean, blank:boolean, parentSessionId?, origin?:'subagent', cwd?, projections?:{asOfSeq, values} }` (`dsh-api-session-controller/lib/types/types.d.ts:145-154, 240-242`), ordered by activity desc.
- Streams: WebSocket **`/api/remote.mux`** (`dsh-api-gateway/lib/types/stream-protocol.d.ts:4`), logical endpoints `session/follow`, `session/page`, `session/control`, `workspace/follow` (`dsh-api-session-controller/lib/typert.remote-client.d.ts:14-31`; `dsh-api-workspace-controller/lib/typert.remote-client.d.ts:15-23`).
- Other exact Fetch routes seen: `GET/HEAD /api/session.export?sessionId=…&includeDescendants=true` (`dsh-session-log-export/lib/types/index.d.ts:10`; ZIP entries `session.v3.jsonl`, `subagents/<id>/session.v3.jsonl`, `media/…`, `files/…` — `lib/index.js:15,63,253,270`), `/api/session/uploadFileBinary`, `/api/present.open`, `/api/present.host`.
- All `/api` routes pass the trusted-host/origin fence and browser auth (`dsh-client-connection/lib/index.js:552-556`).

## Minimal import recipe

Host-side plugin (`apply(ctx)`), after unzipping and parsing the export:

1. **Locate/parse the log.** Read ZIP entry `session.v3.jsonl` (root) → line 1 = `SessionHeader`, remaining lines = current-format events in `seq` order. Root log only is enough for the session to appear; `subagents/<id>/session.v3.jsonl` entries would import the same way (they are `origin:'subagent'` and stay hidden from the sidebar).
2. **Make sure the cwd directory exists** — `mkdir -p header.cwd`; a cwd that does not resolve to a real directory makes the session ungroupable (`entity.js:76-83`) and drops it if `cwd` is undefined (`api-session-controller/lib/index.js:1841`).
3. **Write the log through the persistence seam (never hand-place the file)** so path/compression/`zstd` frames are backend-owned:
   ```js
   const handle = await ctx.sessionPersistence.create(header, { inheritedEventCount }); // 0/unset unless isSeeded
   await handle.append(events);      // events[0].seq must be 0 and contiguous
   await handle.flush();             // durability + materialization barrier
   await handle.close();
   ```
   (`dsh-session-persistence/lib/types/index.d.ts:99-155`, `handle.d.ts:75-105`.) For `isSeeded` headers the cut must match the log's inherited `session/end-seed` marker (`dsh-session-format-v2-to-v3/lib/index.js:567,574-576`: cut = `seq` of the accepted marker) — else the reader refuses the log.
   Direct-write alternative: `<root>/<projectKey(cwd)>/<encodeSegment(id)>/session.v3.jsonl.zstd` (Checksummed zstd frames, header frame first) or `session.v3.jsonl` when the root is `compression:'none'`; the backend will reject a mismatch (`assertStoredIdentity`, `format.mjs` scan).
4. **File it under its project** (optional; without it the row lands in "Ungrouped" and only appears on reload):
   ```js
   const ws = await ctx.workspaceRegistry.resolveByPath(header.cwd)
           ?? await ctx.workspaceRegistry.create(header.cwd);
   await ws.attachSession(header.id);        // prepends; durable; emits workspace upsert
   ```
   Do not hand-edit `storages/workspace.json` while DSH runs: the `single` layout keeps memory authoritative (`dsh-storage-json/README.md:71`).
5. **Ensure it is not filtered**: `header.origin !== 'subagent'`, id absent from `ctx.workspaceRegistry.archivedSessionIds` (unarchive is not exposed; `dsh-workspace/README.md:163` "Archiving is one-way").
6. **Make it visible now, or accept a reload.** Either (a) tell the user to reload — the sidebar re-pulls `session.list` on connect (`client.js:3531-3534`); or (b) if the plugin has a client half, call `ctx.sessions.refresh()` (`contract/sessions.d.ts:68-72`); or (c) host-side, adopt it live via `ctx.sessionController.create({ sessionId, cwd })` — it takes the `checkPersistedIdentity` branch, `observeSession`s the imported log, resumes the agent and therefore emits `session/created` → `api-session/added` → the row appears without reload (`dsh-api-session-controller/lib/index.js:408-455, 2749-2751`). Option (c) activates an agent for that session.
7. Nothing else to invalidate: no list index, no FTS rebuild, no projection-cache seeding required (the first cold read creates the cache row).

## Update: re-checked against `@deepseek-ai/dsh` 0.2.0-rc.2

The membership/grouping conclusions above still hold — list membership is still a persistence directory scan, and `dsh-workspace` still only decides the group — but three concrete details moved, and the importer depends on all three.

1. **`SessionListState` no longer carries `current`.** It is now `{ ids, byId, phase, projectionsBySession }` (`dsh-api-session-controller/lib/types/client/sessions/service.d.ts:43-52`), and every `current` in the 0.1.x code above is gone. The open session is defined instead by local retention: `UiSession.publishMain` picks the session whose `retainedBy.mainView > 0`, reading `list.byId` first and `sessions.retainInfo(id)` as the guard (`dsh-client-ui-session/lib/client.js:281-289`). `mainView` is a declared `SessionReferenceSource` in that package's public types (`.../client/index.d.ts:94-98`), so `byId[id].retainedBy.mainView` is reproducible from the public list snapshot — which is what the browser half now does. Anything that read `list.current` silently lost `workspace=current`.
2. **A log in an older format is migrated on read, not on write.** `SESSION_FORMAT_VERSION` is 4 (`dsh-session/lib/index.js:56`) and the format catalog's `currentVersion` is 4 (`dsh-session-format-catalog/lib/types/generated.js:14`). `sessionPersistence.create()` accepts any header, but the writer encodes with the current codec and refuses anything else — `encodeCurrent requires Session format v4` (`dsh-session-format/lib/index.js:346`). Old logs are served by restoring them through the catalog (`dsh-session-persistence-jsonl/lib/index.js:2603-2629`), and the v3→v4 edge is a real transformation, not a version bump (`dsh-session-format-v3-to-v4/README.md:69-198`). An importer therefore has to migrate before writing, using the installed catalog (`createSessionFormatCatalogWithChildren` + `createRestore().decodeRow()/finish()`), with each parent's direct-child evidence collected from its children's *historical* artifacts (`historicalChildCatalogSource`).
3. **The physical generation moved with it.** The canonical filename is `session[.vN].jsonl[.zstd]` for the generation it holds (`dsh-session-persistence-jsonl/lib/types/format.d.ts:19-37`); the exporter writes the current generation's name (`dsh-session-log-export/lib/index.js:14-18`), and the ZIP layout (`subagents/<id>/`, `media/<id>.<ext>`, `files/<xx>/<digest>/<name>`) is unchanged.

Resolution note for a plugin that wants the format library: DSH routes a bare `@deepseek-ai/*` specifier to the running installation only for modules it scopes, so a plugin mounted by absolute path (a `link:` dependency resolved through the profile is scoped; this project's verification overlay is not) has to fall back to resolving from `process.argv[1]` — the `dsh` entry script inside the installation — which reaches the same copy (`dsh-app-boot/lib/index.js:1386-1419, 1471-1510`).

## Update: this profile's plugin set patches the registry (why a re-import landed in "Unrouped")

`@michengai/dsh-archive-manager` (installed in `profile web`) does not merely *use* `ctx.workspaceRegistry` — it rewrites the live instance in place (`lib/workspace.js`, `installArchiveWorkspace(registry)`): every method of its `ArchiveWorkspaceRegistry` subclass is copied onto the real registry object, `protectArchivedSessionPath` wraps `registry.host.sessionPath`, and its `deleteSession`/`deleteArchivedSessions` remotes are registered on the `workspaceRegistry` namespace. Two of those pieces change what an importer can rely on.

1. **A deletion tombstone makes the id un-indexable for the process lifetime.** `deleteSessionCore` removes the log, then `forgetIndexedSession(id)` clears the parent's `headers` / `sessionPaths` / `invalidSessionPaths` entries and records the id in `deletedSessionIds` with its identity (`createdAt`, `cwd`). From then on the copied `indexHeader` returns early for that id:
   ```js
   async indexHeader(header) {
       if (this.deletedSessionIds.has(header.id)) return;   // ← skips ANY log with that id
       return super.indexHeader(header);
   }
   ```
   The skip is *identity-blind*, while the overlay's own reuse path (`sessionKnown` → `coldReuseKnown`) only forgives an id when the listed log's identity differs from the deleted one. Nothing else ever clears `deletedSessionIds`.

2. **`attachSession` reads the header through that index.** `WorkspaceEntity.attachSession` (`dsh-workspace/lib/types/entity.js:57-89`) starts with `host.readSessionHeader(id)` — not live, not cached, a fresh `listStoredHeaders()` → `indexHeaders()` → the skipped `indexHeader` → `headers.get(id) === undefined` → `throw new Error("cannot validate session '<id>': session persistence holds no such session")`. The registry therefore refuses to file a log that is on disk and readable. The importer catches that (grouping is best effort) and the session stays in "Ungrouped".

Consequences for this plugin (all now handled in `src/index.js`):

- **Re-import after a delete is the recommended flow, and it is exactly the poisoned case.** The dialog tells the user to delete a session and import again to file it elsewhere; the re-import writes the *same* id. Before attaching, the importer now calls the deployment's own forget-hook (`clearTombstone`, duck-typed, called only when present), which drops the tombstone and the projection-cache tombstone, so the header indexes and the attach validates.
- **`attachSession` can also resolve without writing anything.** The registry prunes ids it cannot index inside its `update` chain, so a "successful" attach can leave the record unchanged. Membership is now read back from `workspace.sessionIds` and reported as a failure with the registry's state instead of as success.
- **There is no official session delete in 0.2.0-rc.2.** `dsh-api-session-controller/lib/typert.remote-client.d.ts` lists `session/{attachment,cancel,create,fork,list,page,projection,rename,search,selectModel,prompt,…}` and no delete; the only delete in this profile is the overlay's `workspaceRegistry/deleteSession`. So a deleted session in this deployment is always a tombstoned one.

Live evidence for the diagnosis (this machine, 2026-10-19): the user's import of `dsh-session-session-b631e372….zip` (archive `cwd: E:\Project\virtual_cell`, which no longer exists) ended up in `sessions/--E-Project-Research--/session-b631e372….jsonl.zstd` with `cwd: E:\Project\Research` — a workspace that *does* exist and *is* registered — while `storages/workspace.json` never listed that id and its `Research` record was last written two minutes earlier. A control import of a fresh synthetic archive against the same target workspace grouped correctly, and an earlier copy of the same archive had been deleted out of `--E-Project-virtual_cell--` (that directory's mtime), which is what creates the tombstone.

### Resolution ladder, second edition (pnpm nests the format edges)

In this installation `@deepseek-ai/dsh-session-format-v3-to-v4` is **not** at `dsh/node_modules/@deepseek-ai/`; it exists only inside `dsh-session-format-catalog/node_modules/@deepseek-ai/`, so no anchor outside the catalog package can resolve it — `createRequire(argv[1]).resolve(...)` reaches the catalog but not the edges, and the plugin's first ladder therefore found the catalog and lost the edges (`installed v(unknown)` in the live route's dry run). `src/format.js` now resolves the catalog first and offers *its* resolved files as extra anchors for the edge packages, which is the scope the catalog itself imports them from. Verified against this installation: `installedFormatVersion()` → 4 and `describeFormat` → `{ archivedVersion: 3, installedVersion: 4, migrationRequired: true }`. Without it, `migratePlan` fell back to "write as exported" and the writer then refused the v3 header (`encodeCurrent requires Session format v4`), i.e. no pre-v4 archive could be imported at all.

Nothing was modified in the DSH installation.
