// dsh-session-importer: import an exported Session-log ZIP (Host half).
//
// Entry points, both served by this file:
//   GET|POST /api/session.import   browser upload / host-path import / dry run
//   import_session_archive         model tool for a host-side archive path
//
// The import itself is deliberately built on Session services rather than on
// the filesystem. `@deepseek-ai/dsh-session-log-export` serializes the
// *logical* log, so the inverse is `ctx.sessionPersistence.create()` plus
// `handle.append()`: the backend owns the zstd frames, the checksum layout,
// the injective id escaping, and the project-directory naming, and the
// imported session is therefore identical to a natively written one no matter
// which persistence provider is mounted.
//
// Identity is preserved. Session ids inside an archive are referenced from
// other places in the same archive (subagent headers name their parent, tool
// results carry subagent ids), so regenerating ids would silently break the
// tree. A session that already exists is reported as skipped instead.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readZipEntries, ZipReadError } from './zip.js'
import { ArchiveError, buildImportPlan, classifyArchive, readRootHeader, remapAttachments } from './archive.js'

export const name = 'dsh-session-importer'
// Every dependency is optional: a browser profile provides `connection`, an
// agent profile provides `tools`, and a headless profile may provide neither.
// Waiting on a service a profile will never mount would park the plugin in
// PENDING forever, so each registration is deferred to its own appearance.
export const inject = []

/** Exact Connection Fetch route owned by this plugin (below the shared `/api` channel). */
export const SESSION_IMPORT_PATH = '/api/session.import'
/** Events appended per `handle.append` call. */
const APPEND_BATCH_EVENTS = 512
/** Hard ceiling for the JSON summary's session list. */
const MAX_REPORTED_SESSIONS = 500

/** Defaults for every deployment-varying knob; overridden by the row's `config`. */
const CONFIG_DEFAULTS = Object.freeze({
  /** Largest accepted request body (and largest accepted host-file archive). */
  maxUploadBytes: 268435456,
  /** Largest total inflated archive size, guarding against a decompression bomb. */
  maxExtractedBytes: 1073741824,
  /** Whether `?path=` / `{ path }` host-filesystem imports are accepted. */
  allowHostPath: true,
  /** Target-workspace policy when a request names none: `auto`, `original`, or `current`. */
  workspace: 'auto',
  /** Read every imported log back before reporting success. */
  verifyRead: true,
  /** Session-log root; empty resolves `$DSH_HOME/sessions`. */
  sessionsRoot: '',
})

/**
 * Hand-rolled Standard Schema for the row's `config` block.
 *
 * The plugin carries no runtime dependencies, so it cannot import Schemastery;
 * Cordis only requires `Config["~standard"].validate`, which this implements
 * directly. Invalid configuration fails the plugin fiber at load time with a
 * named field, exactly as a schema-backed plugin would.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-session-importer',
    validate(input) {
      const issues = []
      const config = { ...CONFIG_DEFAULTS }
      if (input === undefined || input === null) return { value: config }
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(CONFIG_DEFAULTS, key)) issues.push({ message: `unknown config field "${key}"`, path: [key] })
      }
      const positive = (key) => {
        const value = input[key]
        if (value === undefined) return
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          issues.push({ message: `${key} must be a positive integer`, path: [key] })
          return
        }
        config[key] = value
      }
      positive('maxUploadBytes')
      positive('maxExtractedBytes')
      if (input.allowHostPath !== undefined) {
        if (typeof input.allowHostPath !== 'boolean') issues.push({ message: 'allowHostPath must be a boolean', path: ['allowHostPath'] })
        else config.allowHostPath = input.allowHostPath
      }
      if (input.verifyRead !== undefined) {
        if (typeof input.verifyRead !== 'boolean') issues.push({ message: 'verifyRead must be a boolean', path: ['verifyRead'] })
        else config.verifyRead = input.verifyRead
      }
      if (input.workspace !== undefined) {
        if (input.workspace !== 'auto' && input.workspace !== 'original' && input.workspace !== 'current') {
          issues.push({ message: 'workspace must be "auto", "original", or "current"', path: ['workspace'] })
        } else config.workspace = input.workspace
      }
      if (input.sessionsRoot !== undefined) {
        if (typeof input.sessionsRoot !== 'string') issues.push({ message: 'sessionsRoot must be a string', path: ['sessionsRoot'] })
        else config.sessionsRoot = input.sessionsRoot
      }
      return issues.length > 0 ? { issues } : { value: config }
    },
  },
}

/** JSON response helper. */
function json(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** Error message helper for values that may not be `Error`s. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** DSH home directory, honouring the deployment's override. */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Session-log root, following the JSONL backend's shipped configuration. */
function sessionsRoot(config) {
  return config.sessionsRoot === '' ? path.join(dshHome(), 'sessions') : config.sessionsRoot
}

/** Whether a directory exists. */
function directoryExists(candidate) {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/** Whether a path is absolute for this platform. */
function isAbsolutePath(value) {
  return typeof value === 'string' && value !== '' && path.isAbsolute(value)
}

/**
 * Resolve the cwd stamped on every imported session header.
 *
 * The cwd decides which workspace group the session appears under, so the
 * policy is explicit: `original` keeps the archive's own workspace, `current`
 * files it under the importing session's workspace, and `auto` keeps the
 * archived workspace when that directory still exists locally and falls back
 * to the importing session otherwise.
 *
 * When `current` cannot be resolved the host still has to write something, so it
 * uses its own working directory — but it reports that as a fallback rather than
 * letting the request look like it honoured a workspace it never resolved.
 * @param ctx - host context (Session services are read through it).
 * @param rootHeader - the archive's root header.
 * @param request - explicit request inputs.
 * @returns the cwd to stamp, the policy that produced it, and whether a fallback was used.
 */
async function resolveTargetCwd(ctx, rootHeader, request) {
  if (isAbsolutePath(request.cwd)) return { cwd: request.cwd, source: 'request' }
  if (request.cwd !== undefined && request.cwd !== '') {
    throw new ArchiveError(`cwd must be an absolute path (received "${String(request.cwd)}")`)
  }
  const importingSessionCwd = async () => {
    if (request.sessionId === undefined) return undefined
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined || typeof persistence.stat !== 'function') return undefined
    try {
      return (await persistence.stat(request.sessionId))?.header.cwd
    } catch {
      return undefined
    }
  }
  const fallbackToHostDirectory = () => ({
    cwd: process.cwd(),
    source: 'process',
    fallback: true,
    fallbackBecause: request.sessionId === undefined
      ? 'the request carried no importing session, so "current" had no workspace to resolve'
      : `session "${request.sessionId}" has no stored cwd to resolve, so "current" had no workspace to resolve`,
  })
  const archived = rootHeader.cwd
  if (request.mode === 'original') {
    if (archived === undefined) throw new ArchiveError('the archive records no cwd, so "original" cannot be honoured')
    return { cwd: archived, source: 'original' }
  }
  if (request.mode === 'current') {
    const current = await importingSessionCwd()
    return current === undefined ? fallbackToHostDirectory() : { cwd: current, source: 'current' }
  }
  if (archived !== undefined && directoryExists(archived)) return { cwd: archived, source: 'original' }
  const current = await importingSessionCwd()
  return current === undefined ? fallbackToHostDirectory() : { cwd: current, source: 'current' }
}

/**
 * Read the archive bytes named by a `path` request, guarding size and type.
 * @param config - resolved plugin configuration.
 * @param rawPath - the caller's path.
 * @returns the archive bytes.
 */
function readArchiveFile(config, rawPath) {
  if (!config.allowHostPath) throw new ArchiveError('host-path imports are disabled by this deployment (config.allowHostPath is false)')
  if (!isAbsolutePath(rawPath)) throw new ArchiveError('path must be an absolute host path')
  let stat
  try {
    stat = fs.statSync(rawPath)
  } catch {
    throw new ArchiveError(`no such file: ${rawPath}`)
  }
  if (!stat.isFile()) throw new ArchiveError(`not a regular file: ${rawPath}`)
  if (stat.size > config.maxUploadBytes) throw new ArchiveError(`archive is ${stat.size} bytes, over the ${config.maxUploadBytes}-byte limit`)
  return fs.readFileSync(rawPath)
}

/**
 * Turn one request into archive bytes.
 * @param request - the Fetch request.
 * @param config - resolved plugin configuration.
 * @returns the archive bytes (undefined for a metadata-only request).
 */
async function archiveBytesFrom(request, config, body) {
  const url = new URL(request.url)
  const queryPath = url.searchParams.get('path')
  if (queryPath !== null) return readArchiveFile(config, queryPath)
  if (request.method === 'GET') return undefined
  if (body?.path !== undefined) return readArchiveFile(config, String(body.path))
  const length = Number(request.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(length) && length > config.maxUploadBytes) {
    throw new ArchiveError(`upload is ${length} bytes, over the ${config.maxUploadBytes}-byte limit`)
  }
  const bytes = Buffer.from(await request.arrayBuffer())
  if (bytes.length === 0) throw new ArchiveError('request body is empty (send the session-log ZIP as the raw body or set "path")')
  if (bytes.length > config.maxUploadBytes) {
    throw new ArchiveError(`upload is ${bytes.length} bytes, over the ${config.maxUploadBytes}-byte limit`)
  }
  return bytes
}

/**
 * Restore every attachment an archive references.
 *
 * Images and files are content-addressed, so restoring the same bytes
 * normally reproduces the same id the log already names. When the store
 * normalizes an object into a different id, the returned reference is carried
 * back into `remap` so the callers can rewrite the log's references.
 * @param ctx - host context.
 * @param plan - the import plan.
 * @returns restore counts, failures, and the id remap.
 */
async function restoreAttachments(ctx, plan) {
  const attachments = ctx.get('attachments')
  const errors = []
  const remap = new Map()
  const pending = plan.media.length + plan.files.length
  if (pending === 0) return { restored: 0, failed: 0, remap, errors, unavailable: false }
  if (attachments === undefined) {
    return { restored: 0, failed: 0, remap, errors, unavailable: true, pending }
  }
  let restored = 0
  let failed = 0
  for (const image of plan.media) {
    try {
      const ref = await attachments.saveImage({ data: new Uint8Array(image.data), mediaType: image.mediaType })
      if (String(ref.attachmentId) !== image.attachmentId) remap.set(image.attachmentId, ref)
      restored += 1
    } catch (error) {
      failed += 1
      errors.push(`image ${image.attachmentId}: ${messageOf(error)}`)
    }
  }
  for (const file of plan.files) {
    try {
      const ref = await attachments.saveFile({ data: new Uint8Array(file.data), name: file.fileName })
      if (String(ref.attachmentId) !== file.attachmentId || ref.name !== file.fileName) remap.set(file.attachmentId, ref)
      restored += 1
    } catch (error) {
      failed += 1
      errors.push(`file ${file.attachmentId}: ${messageOf(error)}`)
    }
  }
  return { restored, failed, remap, errors, unavailable: false, pending }
}

/**
 * Write one planned session through the persistence service.
 * @param persistence - the mounted persistence provider.
 * @param session - the planned session.
 */
async function writeSession(persistence, session) {
  const options = session.header.isSeeded ? { inheritedEventCount: session.inheritedEventCount } : {}
  const handle = await persistence.create(session.header, options)
  try {
    for (let offset = 0; offset < session.events.length; offset += APPEND_BATCH_EVENTS) {
      await handle.append(session.events.slice(offset, offset + APPEND_BATCH_EVENTS))
    }
    await handle.flush()
  } finally {
    await handle.close()
  }
}

/**
 * Read one imported log back, so an import never reports success for a session
 * the reader would refuse (an unknown event vocabulary, a broken invariant).
 * @param persistence - the mounted persistence provider.
 * @param sessionId - the session to read.
 * @returns the number of events read.
 */
async function verifySession(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(0, undefined)
    return events.length
  } finally {
    await handle.close()
  }
}

/**
 * Locate one session's on-disk directory, for cleanup after a failed import.
 * Session ids are escaped injectively by the backend, and every character a
 * real id uses is safe, so the id is also its own directory name.
 * @param config - resolved plugin configuration.
 * @param sessionId - the session to locate.
 * @returns matching directories.
 */
function findSessionDirectories(config, sessionId) {
  const root = sessionsRoot(config)
  const found = []
  let slugs
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const candidate = path.join(root, slug.name, sessionId)
    if (directoryExists(candidate)) found.push(candidate)
  }
  return found
}

/**
 * File the imported root session under its workspace group.
 *
 * Session-list membership comes from a persistence directory scan, so an
 * imported log is visible without this step — but a session no workspace
 * accounts for is grouped under "Ungrouped". The workspace registry owns the
 * canonical-cwd contract, and no RPC exposes session attachment, so this runs
 * in-process against `ctx.workspaceRegistry` and stays best-effort: an
 * unwritable workspace record must never undo a completed import.
 * @param ctx - host context.
 * @param cwd - the cwd stamped on the imported root header.
 * @param sessionId - the imported root session.
 * @returns the group outcome.
 */
async function attachToWorkspace(ctx, cwd, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.resolveByPath !== 'function' || typeof registry.create !== 'function') {
    return { grouped: false, reason: 'this profile mounts no workspace registry, so the session is grouped under "Ungrouped"' }
  }
  try {
    const workspace = (await registry.resolveByPath(cwd)) ?? (await registry.create(cwd))
    await workspace.attachSession(sessionId)
    return { grouped: true, workspaceId: String(workspace.id), path: workspace.path }
  } catch (error) {
    return { grouped: false, reason: `could not file the session under "${cwd}": ${messageOf(error)}` }
  }
}

/**
 * Execute one import plan against the host's Session services.
 * @param ctx - host context.
 * @param plan - the plan from {@link buildImportPlan}.
 * @param config - resolved plugin configuration.
 * @param targetCwd - the cwd stamped on the plan, used for workspace grouping.
 * @returns the import summary.
 */
async function executeImport(ctx, plan, config, targetCwd) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new ArchiveError('session import is unavailable: this profile mounts no session-persistence provider')
  const attachments = await restoreAttachments(ctx, plan)
  const remapped = attachments.remap.size === 0 ? 0 : remapAttachments(plan.sessions, attachments.remap)

  const imported = []
  const skipped = []
  const errors = []

  // Each logical log is decided on its own id, so re-importing an archive after
  // a partial failure completes the missing sessions instead of reporting the
  // whole archive as already present. The root still leads the plan: a root
  // that could not be written aborts the remaining descendants, because they
  // would reconstruct a tree nothing can reach.
  for (const session of plan.sessions) {
    const id = session.header.id
    try {
      if ((await persistence.stat(id)) !== undefined) {
        skipped.push({ sessionId: id, role: session.role, reason: 'a session with this id already exists' })
        continue
      }
      await writeSession(persistence, session)
      imported.push({ sessionId: id, role: session.role, events: session.events.length, logName: session.logName })
    } catch (error) {
      errors.push(`${session.logName} (${id}): ${messageOf(error)}`)
      if (session.role === 'root') break
    }
  }

  // Verification is the only check that exercises the reader's full event
  // vocabulary and replay invariants; a session that fails it is removed again
  // rather than left as an unopenable row in the sidebar.
  const verified = []
  if (config.verifyRead) {
    for (const entry of [...imported]) {
      try {
        const events = await verifySession(persistence, entry.sessionId)
        verified.push({ sessionId: entry.sessionId, events })
      } catch (error) {
        errors.push(`verify failed for ${entry.sessionId}: ${messageOf(error)}`)
        let removed = false
        for (const dir of findSessionDirectories(config, entry.sessionId)) {
          try {
            fs.rmSync(dir, { recursive: true, force: true })
            removed = true
          } catch {
            // Cleanup is best effort: the verification failure is the report.
          }
        }
        imported.splice(imported.indexOf(entry), 1)
        errors.push(`import of ${entry.sessionId} was rolled back${removed ? '' : ' (its files could not be removed, so a restart may be needed to drop it from the list)'}`)
      }
    }
  }

  const rootImported = imported.find((entry) => entry.role === 'root')
  const rootSkipped = skipped.find((entry) => entry.role === 'root')
  const workspace = rootImported === undefined
    ? rootSkipped === undefined
      ? { grouped: false, reason: 'no root session was imported' }
      // A session's workspace is not accounting that can be re-pointed: the
      // registry only groups a session whose header cwd canonicalizes to the
      // workspace path, and a stored header is immutable. Re-importing therefore
      // cannot move an existing session, and saying so is the whole answer.
      : {
        grouped: false,
        unchanged: true,
        reason: `session "${rootSkipped.sessionId}" already exists, so nothing was written and its workspace is unchanged: a session belongs to the workspace whose path matches the cwd recorded in its header, and a stored header cannot be rewritten. Delete that session, then import again to file it elsewhere.`,
      }
    : await attachToWorkspace(ctx, targetCwd, rootImported.sessionId)
  return {
    imported,
    skipped,
    errors,
    verified,
    attachments,
    remapped,
    workspace,
    // "Already imported" is a success-shaped no-op: the root was present and this
    // run added nothing, which is what a repeated import should report.
    alreadyImported: rootSkipped !== undefined && imported.length === 0,
  }
}

/**
 * Run one import request end to end.
 * @param ctx - host context.
 * @param request - the Fetch request.
 * @param config - resolved plugin configuration.
 * @returns the JSON response payload and status.
 */
async function runImport(ctx, request, config) {
  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === 'true'
  let body
  if (request.method === 'POST' && (request.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      body = JSON.parse(await request.text() || '{}')
    } catch (error) {
      return { status: 400, payload: { ok: false, error: `invalid JSON body: ${messageOf(error)}` } }
    }
  }
  const mode = body?.workspace ?? url.searchParams.get('workspace') ?? config.workspace
  if (mode !== 'auto' && mode !== 'original' && mode !== 'current') {
    return { status: 400, payload: { ok: false, error: 'workspace must be "auto", "original", or "current"' } }
  }
  const bytes = await archiveBytesFrom(request, config, body)
  if (bytes === undefined) {
    return {
      status: 200,
      payload: {
        ok: true,
        service: name,
        dryRun: true,
        limits: { maxUploadBytes: config.maxUploadBytes, maxExtractedBytes: config.maxExtractedBytes, allowHostPath: config.allowHostPath },
        usage: 'POST the session-log ZIP as the raw request body, or pass ?path=<absolute host path>. Add ?dryRun=true to inspect without importing.',
      },
    }
  }
  const entries = readZipEntries(bytes, { maxExtractedBytes: config.maxExtractedBytes })
  const archive = classifyArchive(entries)
  const rootHeader = readRootHeader(archive.root)
  const target = await resolveTargetCwd(ctx, rootHeader, {
    mode,
    cwd: body?.cwd ?? url.searchParams.get('cwd') ?? undefined,
    sessionId: body?.sessionId ?? url.searchParams.get('sessionId') ?? undefined,
  })
  const plan = buildImportPlan(archive, { cwd: target.cwd })
  const planSummary = {
    archiveBytes: bytes.length,
    entries: entries.size,
    root: archive.root.name,
    subagents: archive.subagents.length,
    media: archive.media.length,
    files: archive.files.length,
    ignored: archive.ignored,
    targetCwd: target.cwd,
    targetCwdSource: target.source,
    ...(target.fallback === true ? { targetCwdFallback: target.fallbackBecause } : {}),
    rootId: rootHeader.id,
    createdAt: rootHeader.createdAt,
    agentPreset: rootHeader.agentPreset ?? null,
    sessions: plan.sessions.slice(0, MAX_REPORTED_SESSIONS).map((session) => ({
      sessionId: session.header.id,
      role: session.role,
      logName: session.logName,
      events: session.events.length,
      createdAt: session.header.createdAt,
    })),
    warnings: plan.warnings,
  }
  if (dryRun) return { status: 200, payload: { ok: true, dryRun: true, plan: planSummary } }
  const result = await executeImport(ctx, plan, config, target.cwd)
  const warnings = [...plan.warnings]
  // The workspace outcome travels as a structured field rather than as a warning
  // line: the browser renders it localized, and duplicating it in `warnings`
  // would print the same fact twice.
  const workspace = result.workspace ?? { grouped: false, reason: 'no workspace step ran' }
  if (target.fallback === true) {
    warnings.push(`target workspace: ${target.cwd} was used because ${target.fallbackBecause}`)
  }
  return {
    status: result.imported.length === 0 && !result.alreadyImported ? 500 : 200,
    payload: {
      ok: result.imported.length > 0 || result.alreadyImported,
      dryRun: false,
      plan: planSummary,
      imported: result.imported,
      skipped: result.skipped,
      verified: result.verified,
      attachments: {
        restored: result.attachments.restored,
        failed: result.attachments.failed,
        unavailable: result.attachments.unavailable === true,
        remappedReferences: result.remapped,
      },
      workspace,
      errors: result.errors,
      warnings,
      rootSessionId: result.imported.find((entry) => entry.role === 'root')?.sessionId ?? null,
      alreadyImported: result.alreadyImported,
    },
  }
}

/**
 * Register the browser route and the model tool.
 * @param ctx - the composed Host context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config = CONFIG_DEFAULTS) {
  const registerRoute = (hostCtx) => {
    hostCtx.effect(() => hostCtx.connection.fetch.register({
      path: SESSION_IMPORT_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const { status, payload } = await runImport(ctx, request, config)
          return json(status, payload)
        } catch (error) {
          const status = error instanceof ArchiveError || error instanceof ZipReadError ? 400 : 500
          return json(status, { ok: false, error: messageOf(error) })
        }
      },
    }), 'session-importer: route')
  }
  const connection = ctx.get('connection')
  if (connection !== undefined) registerRoute(ctx)
  else ctx.inject(['connection'], (sub) => registerRoute(sub))

  const registerTool = (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'import_session_archive',
      description: 'Import a Session-log ZIP previously exported from DSH (the `dsh-session-<id>.zip` download) into this deployment. Restores the root session, every subagent session, and the referenced attachments, preserving their session ids. Use dry_run to inspect an archive without importing it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute host path of the session-log ZIP to import.' },
          dry_run: { type: 'boolean', description: 'Inspect the archive and report the plan without importing it.' },
          cwd: { type: 'string', description: 'Absolute workspace path to file the imported sessions under. Omit for the deployment default.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const query = new URLSearchParams({ path: String(args.path) })
        if (args.dry_run === true) query.set('dryRun', 'true')
        if (typeof args.cwd === 'string' && args.cwd !== '') query.set('cwd', args.cwd)
        const request = new Request(`http://dsh.internal${SESSION_IMPORT_PATH}?${query.toString()}`, { method: 'GET' })
        try {
          const { payload } = await runImport(ctx, request, config)
          if (payload.ok !== true) return `import failed: ${payload.error ?? 'unknown error'}`
          if (payload.dryRun === true) {
            const plan = payload.plan
            return [
              `archive: ${plan.root} (${plan.sessions.length} session log(s), ${plan.media} image(s), ${plan.files} file(s))`,
              `root session: ${plan.rootId}`,
              `target workspace: ${plan.targetCwd} (${plan.targetCwdSource})`,
              `events: ${plan.sessions.reduce((total, session) => total + session.events, 0)}`,
              ...plan.warnings.map((warning) => `warning: ${warning}`),
            ].join('\n')
          }
          const lines = [
            `imported: ${payload.imported.length} session(s), ${payload.attachments.restored} attachment(s) restored`,
            `root session id: ${payload.rootSessionId ?? '(none)'}`,
            payload.workspace?.grouped === true
              ? `workspace group: ${payload.workspace.path}`
              : `workspace group: none (${payload.workspace?.reason ?? 'not grouped'})`,
          ]
          if (payload.skipped.length > 0) lines.push(`skipped: ${payload.skipped.map((entry) => entry.sessionId).join(', ')}`)
          for (const error of payload.errors) lines.push(`error: ${error}`)
          for (const warning of payload.warnings) lines.push(`warning: ${warning}`)
          return lines.join('\n')
        } catch (error) {
          return `import failed: ${messageOf(error)}`
        }
      },
    }), 'session-importer: tool')
  }
  const tools = ctx.get('tools')
  if (tools !== undefined) registerTool(ctx)
  else ctx.inject(['tools'], (sub) => registerTool(sub))
}
