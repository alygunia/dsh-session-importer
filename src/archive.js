// Archive reading and import planning for DSH session-log ZIPs.
//
// The archive contract is owned by `@deepseek-ai/dsh-session-log-export`:
//   session.v3.jsonl                        the root logical log (vN = format generation)
//   subagents/<session-id>/session.v3.jsonl one log per subagent descendant
//   media/<attachmentId>.<ext>              referenced raster images
//   files/<xx>/<sha256>/<name>              referenced verbatim files
// No manifest is written, so the layout itself is the contract and everything
// else in the archive is reported as ignored rather than refused.
//
// Both the on-disk log and the exported log are the same logical JSONL (one
// `type: "session"` header line, then one line per event in `seq` order),
// which is why an import can be planned as pure data and handed to
// `ctx.sessionPersistence` without touching zstd frames or directory naming.

/** Canonical log basename for any format generation (`session.jsonl`, `session.v3.jsonl`). */
const LOG_BASENAME = /^session(?:\.v(\d+))?\.jsonl$/
/** `subagents/<id>/<log basename>`. */
const SUBAGENT_PATH = /^subagents\/([^/]+)\/([^/]+)$/
/** `media/<attachmentId>.<ext>`. */
const MEDIA_PATH = /^media\/(.+)\.([A-Za-z0-9]+)$/
/** `files/<digest prefix>/<sha256 digest>/<leaf name>`. */
const FILE_PATH = /^files\/([0-9a-fA-F]{2})\/([0-9a-fA-F]{64})\/(.+)$/
/** Extensions the export writes for raster media types. */
const IMAGE_MEDIA_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])
/** Header keys accepted on a logical session header line. */
const REQUIRED_HEADER_KEYS = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth']
const OPTIONAL_HEADER_KEYS = ['cwd', 'parentSession', 'origin', 'agentPreset']
const HEADER_KEYS = new Set([...REQUIRED_HEADER_KEYS, ...OPTIONAL_HEADER_KEYS])

/** Refusal raised for an archive or log this importer cannot turn into sessions. */
export class ArchiveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArchiveError'
  }
}

/** Whether a path is a logical session log at any location. */
function logGeneration(name) {
  const match = LOG_BASENAME.exec(name)
  return match === null ? undefined : match[1] === undefined ? 0 : Number(match[1])
}

/** Whether a JSON value is a plain object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is an absolute path on this platform or a POSIX absolute path. */
function isAbsoluteCwd(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value)
}

/**
 * Adopt the root log's header line without parsing the whole log.
 *
 * The target workspace is decided from the header before the (potentially
 * large) event log is parsed, so this reads only the first line.
 * @param entry - the root log archive entry.
 * @returns the adopted header.
 * @throws {ArchiveError} when the header line is unreadable.
 */
export function readRootHeader(entry) {
  const text = entry.data.toString('utf8', 0, Math.min(entry.data.length, 1 << 20))
  const end = text.indexOf('\n')
  const line = (end === -1 ? text : text.slice(0, end)).trim()
  if (line === '') throw new ArchiveError(`${entry.name}: the log has no header line`)
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new ArchiveError(`${entry.name}: the header line is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  return adoptHeader(parsed, entry.name)
}

/**
 * Split the archive's entries by role.
 * @param entries - archive entries from {@link readZipEntries}.
 * @returns the root log, subagent logs, attachment objects, and ignored rows.
 * @throws {ArchiveError} when no root log exists or a path is malformed.
 */
export function classifyArchive(entries) {
  let root
  const subagents = []
  const media = []
  const files = []
  const ignored = []
  for (const [name, data] of entries) {
    if (logGeneration(name) !== undefined) {
      if (root !== undefined) throw new ArchiveError(`archive has more than one root log ("${root.name}" and "${name}")`)
      root = { name, data }
      continue
    }
    const subagent = SUBAGENT_PATH.exec(name)
    if (subagent !== null && logGeneration(subagent[2]) !== undefined) {
      subagents.push({ name, dir: subagent[1], data })
      continue
    }
    const image = MEDIA_PATH.exec(name)
    if (image !== null) {
      const mediaType = IMAGE_MEDIA_TYPES.get(image[2].toLowerCase())
      if (mediaType === undefined) {
        ignored.push({ name, reason: `unsupported image extension ".${image[2]}"` })
        continue
      }
      media.push({ name, attachmentId: image[1], mediaType, data })
      continue
    }
    const file = FILE_PATH.exec(name)
    if (file !== null) {
      files.push({ name, attachmentId: `sha256:${file[2].toLowerCase()}`, fileName: file[3], data })
      continue
    }
    ignored.push({ name, reason: 'not part of the session-log archive layout' })
  }
  if (root === undefined) throw new ArchiveError('archive has no root session log (expected "session.v3.jsonl" at the archive root)')
  return { root, subagents, media, files, ignored }
}

/**
 * Validate and adopt one exported header line.
 * @param value - the parsed first line.
 * @param label - archive path used in diagnostics.
 * @returns the header to recreate, with no unknown keys.
 * @throws {ArchiveError} when the header is not a current-generation session header.
 */
function adoptHeader(value, label) {
  if (!isPlainObject(value)) throw new ArchiveError(`${label}: the first line is not a session header object`)
  for (const key of REQUIRED_HEADER_KEYS) {
    if (!Object.hasOwn(value, key)) throw new ArchiveError(`${label}: session header is missing "${key}"`)
  }
  for (const key of Object.keys(value)) {
    if (!HEADER_KEYS.has(key)) throw new ArchiveError(`${label}: session header carries unknown field "${key}"`)
  }
  if (value.type !== 'session') throw new ArchiveError(`${label}: the first line is not a session header`)
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 0) {
    throw new ArchiveError(`${label}: session header version must be a non-negative integer`)
  }
  if (typeof value.id !== 'string' || value.id === '') throw new ArchiveError(`${label}: session header id must be a non-empty string`)
  if (typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new ArchiveError(`${label}: session header createdAt must be a non-negative integer`)
  }
  if (typeof value.isSeeded !== 'boolean') throw new ArchiveError(`${label}: session header isSeeded must be a boolean`)
  if (typeof value.delegationDepth !== 'number' || !Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0) {
    throw new ArchiveError(`${label}: session header delegationDepth must be a non-negative integer`)
  }
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !isAbsoluteCwd(value.cwd))) {
    throw new ArchiveError(`${label}: session header cwd must be an absolute path`)
  }
  if (value.parentSession !== undefined && typeof value.parentSession !== 'string') {
    throw new ArchiveError(`${label}: session header parentSession must be a string`)
  }
  if (value.origin !== undefined && value.origin !== 'subagent') {
    throw new ArchiveError(`${label}: session header origin must be "subagent" when present`)
  }
  if (value.agentPreset !== undefined && typeof value.agentPreset !== 'string') {
    throw new ArchiveError(`${label}: session header agentPreset must be a string`)
  }
  return {
    version: value.version,
    id: value.id,
    createdAt: value.createdAt,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.parentSession === undefined ? {} : { parentSession: value.parentSession }),
    isSeeded: value.isSeeded,
    ...(value.origin === undefined ? {} : { origin: value.origin }),
    delegationDepth: value.delegationDepth,
    ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }),
  }
}

/**
 * Validate the event envelope and contiguity of an adopted log.
 * @param events - parsed event objects.
 * @param label - archive path used in diagnostics.
 * @throws {ArchiveError} when an event is malformed or the sequence is not contiguous from 0.
 */
function assertEventLog(events, label) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!isPlainObject(event)) throw new ArchiveError(`${label}: event ${index} is not an object`)
    if (typeof event.type !== 'string' || event.type === '') throw new ArchiveError(`${label}: event ${index} has no type`)
    if (event.type === 'session') throw new ArchiveError(`${label}: event ${index} repeats the session header`)
    if (event.seq !== index) throw new ArchiveError(`${label}: event ${index} declares seq ${String(event.seq)}; the log must be contiguous from 0`)
    if (event.time !== undefined && (typeof event.time !== 'number' || !Number.isSafeInteger(event.time))) {
      throw new ArchiveError(`${label}: event ${index} has a non-integer time`)
    }
    if (!Object.hasOwn(event, 'data')) throw new ArchiveError(`${label}: event ${index} has no data field`)
  }
}

/**
 * Parse one logical session log (header line plus event lines).
 * @param text - the exported JSONL text.
 * @param label - archive path used in diagnostics.
 * @returns the adopted header, its events, and the fork-inherited cut.
 * @throws {ArchiveError} when a line is unparsable or the log is inconsistent.
 */
export function parseSessionLog(text, label) {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) throw new ArchiveError(`${label}: the log is empty`)
  const parse = (line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new ArchiveError(`${label}: line ${index + 1} is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  const header = adoptHeader(parse(lines[0], 0), label)
  const events = lines.slice(1).map((line, index) => parse(line, index + 1))
  assertEventLog(events, label)

  // A seeded log's inherited cut is not part of the exported header line; the
  // storage layer derives it from the last accepted inherited end-seed marker,
  // so the importer must recreate exactly that value.
  let inheritedEventCount = 0
  if (header.isSeeded) {
    for (const event of events) {
      if (event.type === 'session/end-seed' && isPlainObject(event.data) && event.data.inherited === true) inheritedEventCount = event.seq + 1
    }
    if (inheritedEventCount === 0) {
      throw new ArchiveError(`${label}: the header is seeded but the log carries no inherited end-seed marker, so its inherited prefix cannot be restored`)
    }
  }
  return { header, events, inheritedEventCount }
}

/**
 * Build the complete import plan for one archive.
 *
 * Session ids are preserved rather than regenerated: the root log, every
 * subagent log, and the ids referenced from tool results and lineage metadata
 * are mutually consistent, and rewriting them would silently break that
 * consistency. A colliding id is therefore an "already imported" outcome that
 * the caller reports instead of overwriting.
 * @param archive - classification from {@link classifyArchive}.
 * @param options - planning inputs.
 * @param options.cwd - absolute cwd to stamp on every imported session header (undefined keeps the archived cwd).
 * @returns the sessions to write, the attachments to restore, and non-fatal observations.
 * @throws {ArchiveError} when the archive cannot be imported as a session tree.
 */
export function buildImportPlan(archive, options = {}) {
  const warnings = []
  const root = parseSessionLog(archive.root.data.toString('utf8'), archive.root.name)
  if (root.header.parentSession !== undefined) {
    throw new ArchiveError(`${archive.root.name}: the root log declares a parent session; import the full archive of that parent instead`)
  }
  const sessions = [{
    role: 'root',
    logName: archive.root.name,
    header: root.header,
    events: root.events,
    inheritedEventCount: root.inheritedEventCount,
  }]
  const seen = new Set([root.header.id])
  for (const entry of archive.subagents) {
    const parsed = parseSessionLog(entry.data.toString('utf8'), entry.name)
    if (parsed.header.parentSession === undefined) {
      warnings.push(`${entry.name}: subagent log declares no parent session; it will be imported as a detached session`)
    }
    if (seen.has(parsed.header.id)) throw new ArchiveError(`${entry.name}: session id "${parsed.header.id}" appears twice in the archive`)
    seen.add(parsed.header.id)
    sessions.push({
      role: 'subagent',
      logName: entry.name,
      header: parsed.header,
      events: parsed.events,
      inheritedEventCount: parsed.inheritedEventCount,
    })
  }
  for (const session of sessions) {
    if (options.cwd !== undefined) session.header = { ...session.header, cwd: options.cwd }
    else if (session.header.cwd === undefined) warnings.push(`${session.logName}: no cwd recorded, so the session shows under "no workspace"`)
  }
  return { sessions, media: archive.media, files: archive.files, ignored: archive.ignored, warnings }
}

/**
 * Rewrite `image`/`file` content-block attachment references through a remap,
 * for the case where the attachment store normalized or re-keyed an object
 * while restoring it. The carriers walked here are the same ones the export
 * scans when it collects attachments.
 * @param sessions - planned sessions (mutated in place, events are owned by the plan).
 * @param remap - old attachment id to the restored reference.
 * @returns how many references were rewritten.
 */
export function remapAttachments(sessions, remap) {
  if (remap.size === 0) return 0
  let rewrites = 0
  const walk = (content) => {
    if (!Array.isArray(content)) return
    const pending = [...content]
    while (pending.length > 0) {
      const value = pending.pop()
      if (!isPlainObject(value)) continue
      if ((value.type === 'image' || value.type === 'file') && isPlainObject(value.attachment)) {
        const replacement = remap.get(String(value.attachment.attachmentId))
        if (replacement !== undefined) {
          value.attachment = replacement
          rewrites += 1
        }
      }
      if (Array.isArray(value.content)) pending.push(...value.content)
    }
  }
  for (const session of sessions) {
    for (const event of session.events) {
      const data = event.data
      if (!isPlainObject(data)) continue
      walk(data.content)
      if (isPlainObject(data.message)) walk(data.message.content)
      if (Array.isArray(data.inserted)) for (const message of data.inserted) if (isPlainObject(message)) walk(message.content)
      if (Array.isArray(data.stream)) {
        for (const record of data.stream) {
          if (isPlainObject(record) && record.type === 'chunk' && isPlainObject(record.chunk) && record.chunk.type === 'block-end') walk([record.chunk.block])
        }
      }
    }
  }
  return rewrites
}
