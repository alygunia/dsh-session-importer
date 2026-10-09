// Session-format compatibility for imported logs.
//
// An exported archive is the *logical* log of the generation that produced it:
// one `type: "session"` header row plus one row per event. DSH only ever writes
// the generation it implements — its format library refuses anything else with
// "encodeCurrent requires Session format vN" — so an archive exported by an
// older DSH cannot be handed to `sessionPersistence.create` unchanged. That is
// not a version bump: the v3-to-v4 edge lifts tool results to `role: "tool"`,
// renames message sources, closes evidenced interrupted turns (renumbering
// every later seq), namespaces unknown content tags, and appends a parent's
// missing subagent catalog facts. Reimplementing those rules here would be a
// second, divergent copy of correctness-critical code, so this module asks the
// installed format library to migrate and owns only the plumbing around it.
//
// The library is resolved through the running installation, so the plugin still
// ships with no runtime dependency of its own, and an archive from the same
// generation is written byte-for-byte as exported. DSH's loader routes a bare
// `@deepseek-ai/*` specifier to the installation only for modules it scopes;
// a plugin mounted by absolute path (a `link:` dependency, or this project's
// own verification overlay) sits outside that scope, so the resolution ladder
// below falls back to the running process's entry script, which lives *inside*
// the installation and therefore resolves its dependencies exactly as the
// installation itself does. See {@link importInstalled}.

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Package owning the installed format vocabulary, its codecs, and its migration chain. */
const CATALOG_PACKAGE = '@deepseek-ai/dsh-session-format-catalog'
/** Package owning the historical child evidence the v3-to-v4 edge consumes. */
const CHILD_FACTS_PACKAGE = '@deepseek-ai/dsh-session-format-v3-to-v4'

/** Literal importers, so each specifier stays statically visible for the loader. */
const IMPORTERS = new Map([
  [CATALOG_PACKAGE, () => import('@deepseek-ai/dsh-session-format-catalog')],
  [CHILD_FACTS_PACKAGE, () => import('@deepseek-ai/dsh-session-format-v3-to-v4')],
])

/** Refusal raised for an archive this installation cannot bring to its own format. */
export class FormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FormatError'
  }
}

/** Error message helper for values that may not be `Error`s. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Files to resolve first-party packages from, in preference order.
 *
 * A plugin's own location comes first (it is what DSH's routing scopes), then
 * the entry script of this process — inside the `dsh` package when DSH was
 * started through its CLI — then the `node` that runs it and every `PATH`
 * directory, whose `node_modules` is where a global installation lives. A
 * directory anchor gets a filename inside it, because Node computes a
 * `node_modules` lookup from the anchor's *parent*.
 * @returns absolute candidate filenames.
 */
function resolutionAnchors() {
  const anchors = []
  const push = (value) => {
    if (typeof value !== 'string' || value === '') return
    if (!anchors.includes(value)) anchors.push(value)
  }
  push(fileURLToPath(import.meta.url))
  push(process.argv[1])
  push(process.execPath)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '') push(path.join(dir, '.dsh-resolution-anchor.js'))
  }
  return anchors
}

/**
 * Load one first-party package from the installation that owns this process.
 *
 * The bare specifier is tried first so a loader-scoped plugin uses exactly the
 * copy DSH itself would; every later attempt resolves the same specifier from
 * an anchor inside the installation and imports the file Node picks, so a
 * plugin mounted by path reaches the same code.
 * @param specifier - exact package name to load.
 * @returns the module namespace.
 * @throws {FormatError} when no anchor resolves it.
 */
async function importInstalled(specifier) {
  let bareReason = 'no literal importer is registered for it'
  const bare = IMPORTERS.get(specifier)
  if (bare !== undefined) {
    try {
      return await bare()
    } catch (error) {
      bareReason = messageOf(error)
    }
  }
  const anchors = resolutionAnchors()
  for (const anchor of anchors) {
    let resolved
    try {
      resolved = createRequire(anchor).resolve(specifier)
    } catch {
      // Not resolvable from this anchor: that is the normal case for most of
      // them, so it is not collected as a reason.
      continue
    }
    try {
      return await import(pathToFileURL(resolved).href)
    } catch (error) {
      // Resolved but unusable is a different failure from "not found", and
      // trying another anchor would only hide it.
      throw new FormatError(`${specifier} resolved to ${resolved} but could not be loaded (${messageOf(error)})`)
    }
  }
  throw new FormatError(`importing an archive needs ${specifier} from the running DSH installation, but it could not be resolved from ${anchors.length} anchors (bare import: ${bareReason})`)
}

/** Cached format-library handle, so the two imports happen once per process. */
let supportPromise

/**
 * Load the installed format library.
 *
 * Both packages are first-party members of the running installation: the JSONL
 * persistence backend imports the catalog unconditionally and refuses to serve
 * sessions when its `currentVersion` disagrees with `@deepseek-ai/dsh-session`,
 * so a deployment that can store a session at all also has these.
 * @returns the migration entry points.
 * @throws {FormatError} when the installation does not expose them.
 */
function loadSupport() {
  if (supportPromise === undefined) {
    supportPromise = (async () => {
      const catalog = await importInstalled(CATALOG_PACKAGE)
      const facts = await importInstalled(CHILD_FACTS_PACKAGE)
      const { sessionFormatCatalog, historicalSessionFormatCatalog, createSessionFormatCatalogWithChildren } = catalog
      const { historicalChildCatalogSource } = facts
      if (typeof sessionFormatCatalog?.currentVersion !== 'number'
        || typeof createSessionFormatCatalogWithChildren !== 'function'
        || typeof historicalSessionFormatCatalog?.createRestore !== 'function'
        || typeof historicalChildCatalogSource !== 'function') {
        throw new FormatError(`this DSH installation exposes no session-format migration API (${CATALOG_PACKAGE}), so an archive written by an older DSH cannot be imported here`)
      }
      return {
        currentVersion: sessionFormatCatalog.currentVersion,
        createCatalogWithChildren: createSessionFormatCatalogWithChildren,
        historicalCatalog: historicalSessionFormatCatalog,
        childSource: historicalChildCatalogSource,
      }
    })()
  }
  return supportPromise
}

/**
 * The physical header row of one planned session.
 *
 * The archive's own first line is rebuilt from the adopted header, so the cwd
 * the plan decided on is what gets migrated, and the codecs — which require
 * `type: "session"` and refuse unknown keys — see exactly the physical shape
 * they validate.
 * @param session - one planned session.
 * @returns the physical header row.
 */
function headerRow(session) {
  return { type: 'session', ...session.header }
}

/**
 * Restore one planned log through one catalog.
 * @param catalog - a format catalog, current or historical.
 * @param session - the planned session to restore.
 * @returns the restored artifact (`header`, `events`, `inheritedEventCount`).
 */
function restoreLog(catalog, session) {
  const restore = catalog.createRestore(headerRow(session), { recovery: 'strict', validation: 'current' })
  for (const event of session.events) restore.decodeRow(event)
  return restore.finish()
}

/**
 * Historical child evidence for one stale subagent log.
 *
 * The v3-to-v4 edge appends a parent's missing `subagent/catalog` facts from its
 * direct children's own descriptors, so a child has to be restored in
 * historical coordinates first. A log that does not declare itself a direct
 * subagent child is not catalog evidence — the edge would refuse it — and is
 * skipped; its parent's migration then records an unknown-mode membership
 * instead of inventing one.
 * @param support - the loaded format library.
 * @param session - one planned session.
 * @returns the child evidence, or undefined when the log is not a direct child.
 */
function childEvidence(support, session) {
  if (session.header.origin !== 'subagent' || session.header.parentSession === undefined) return undefined
  return support.childSource(restoreLog(support.historicalCatalog, session))
}

/**
 * The session-format generation this installation writes, or null when the
 * installation exposes no format library at all.
 * @returns the installed version, or null.
 */
export async function installedFormatVersion() {
  try {
    return (await loadSupport()).currentVersion
  } catch {
    return null
  }
}

/**
 * Report an archive's format generation against the installed one, without
 * migrating anything. Used for the plan summary, so a dry run says whether an
 * import would need a migration.
 * @param sessions - the planned sessions.
 * @returns the comparison, or why it is unknown.
 */
export async function describeFormat(sessions) {
  const versions = [...new Set(sessions.map((session) => session.header.version))].sort((left, right) => left - right)
  const archivedVersion = versions.length === 0 ? null : versions[0]
  let support
  try {
    support = await loadSupport()
  } catch (error) {
    return { archivedVersion, installedVersion: null, migrationRequired: null, unavailable: messageOf(error) }
  }
  return {
    archivedVersion,
    installedVersion: support.currentVersion,
    migrationRequired: versions.some((version) => version !== support.currentVersion),
    mixedGenerations: versions.length > 1,
  }
}

/**
 * Bring every planned log to the installed session-format generation.
 *
 * A plan that is already current is returned untouched, so the ordinary case —
 * an archive exported by this same DSH — costs one version comparison and
 * nothing else.
 * @param plan - the plan from `buildImportPlan`.
 * @returns the plan to import, plus what happened.
 * @throws {FormatError} when a log is newer than this installation, or the
 * migration refuses it.
 */
export async function migratePlan(plan) {
  let support
  try {
    support = await loadSupport()
  } catch (error) {
    // Nothing can be migrated without the format library, so the log is written
    // exactly as exported: the persistence layer accepts a current log and
    // refuses an older one with its own version message. The caller reports the
    // reason this fallback was taken.
    return { plan, migratedSessions: 0, unavailable: messageOf(error) }
  }
  const { currentVersion } = support
  const stale = plan.sessions.filter((session) => session.header.version !== currentVersion)
  if (stale.length === 0) return { plan, migratedSessions: 0, currentVersion }
  for (const session of stale) {
    if (session.header.version > currentVersion) {
      throw new FormatError(`"${session.logName}" is Session format v${session.header.version}, but this DSH writes v${currentVersion}; import it on a DSH that understands v${session.header.version}`)
    }
  }
  // Evidence is collected for the whole tree before anything is migrated: a
  // parent's catalog facts describe children that are themselves migrated.
  const childrenByParent = new Map()
  for (const session of stale) {
    const evidence = childEvidence(support, session)
    if (evidence === undefined) continue
    const parent = session.header.parentSession
    const existing = childrenByParent.get(parent)
    if (existing === undefined) childrenByParent.set(parent, [evidence])
    else existing.push(evidence)
  }
  const sessions = []
  for (const session of plan.sessions) {
    if (session.header.version === currentVersion) {
      sessions.push(session)
      continue
    }
    const catalog = support.createCatalogWithChildren(childrenByParent.get(session.header.id) ?? [])
    const artifact = restoreLog(catalog, session)
    sessions.push({
      ...session,
      header: artifact.header,
      events: artifact.events,
      inheritedEventCount: artifact.inheritedEventCount,
      migratedFrom: session.header.version,
    })
  }
  return { plan: { ...plan, sessions }, migratedSessions: stale.length, currentVersion }
}
