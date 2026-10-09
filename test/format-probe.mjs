// Offline probe for the session-format migration used by the Host half.
//
// `src/format.js` reaches the installed format library through a bare
// `@deepseek-ai/*` specifier, which only the DSH loader routes to the running
// installation. A plain `node` process has no such routing, so this probe
// imports the same packages by absolute path and drives the same calls against a
// real archive: it is the fast way to see what a DSH release does to an old log
// without booting a whole instance.
//
//   node test/format-probe.mjs [path/to/archive.zip]
//
// The installation to read is discovered from this `node` (or from
// `$DSH_INSTALL`). Not part of `npm test`: it reads a machine-specific
// installation.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readZipEntries } from '../src/zip.js'
import { buildImportPlan, classifyArchive } from '../src/archive.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

/** Locate the archive to probe: explicit argv path, else the workspace copy. */
function sampleArchive() {
  if (process.argv[2] !== undefined) return process.argv[2]
  const candidate = fs.readdirSync(root).find((name) => name.startsWith('dsh-session-session-') && name.endsWith('.zip'))
  if (candidate === undefined) throw new Error('no sample archive found; pass one as the first argument')
  return path.join(root, candidate)
}

/**
 * Directories that may hold the installed `@deepseek-ai` packages: an explicit
 * override, the `node_modules` of every directory on `PATH` (which is where the
 * `dsh` shim is found), and the same relative to this `node` — including the one
 * nested inside the `dsh` package itself, which is where the format library
 * lives.
 * @returns the candidates, in preference order.
 */
function candidateInstalls() {
  const roots = []
  if (typeof process.env.DSH_INSTALL === 'string' && process.env.DSH_INSTALL !== '') roots.push(process.env.DSH_INSTALL)
  const bin = path.dirname(process.execPath)
  const bases = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== ''),
    bin,
    path.join(bin, 'bin'),
  ]
  for (const base of bases) {
    roots.push(path.join(base, 'node_modules', '@deepseek-ai'))
    roots.push(path.join(base, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  }
  return roots
}

const install = candidateInstalls()
  .find((dir) => fs.existsSync(path.join(dir, 'dsh-session-format-catalog', 'package.json')))
if (install === undefined) {
  throw new Error(`no installed @deepseek-ai packages found; set DSH_INSTALL to the directory that holds them (probed ${candidateInstalls().slice(0, 4).join(', ')} …)`)
}

/** Import one installed package by absolute path. */
const load = (relative) => import(pathToFileURL(path.join(install, relative)).href)

const catalogPackage = await load('dsh-session-format-catalog/lib/index.js')
const factsPackage = await load('dsh-session-format-v3-to-v4/lib/index.js')
const { sessionFormatCatalog, historicalSessionFormatCatalog, createSessionFormatCatalogWithChildren } = catalogPackage
const { historicalChildCatalogSource } = factsPackage
const { currentVersion } = sessionFormatCatalog

const entries = readZipEntries(fs.readFileSync(sampleArchive()))
const archive = classifyArchive(entries)
const plan = buildImportPlan(archive, { cwd: root })
console.log(`installed v${currentVersion} (historical catalog reads up to v${historicalSessionFormatCatalog.currentVersion})`)
console.log(`${plan.sessions.length} planned log(s):`)
for (const session of plan.sessions) {
  console.log(`  ${session.role.padEnd(8)} v${session.header.version} events=${String(session.events.length).padStart(5)} seeded=${session.header.isSeeded} inherited=${session.inheritedEventCount}`)
}

const headerRow = (session) => ({ type: 'session', ...session.header })
const restoreLog = (catalog, session) => {
  const restore = catalog.createRestore(headerRow(session), { recovery: 'strict', validation: 'current' })
  for (const event of session.events) restore.decodeRow(event)
  return restore.finish()
}

const stale = plan.sessions.filter((session) => session.header.version !== currentVersion)
if (stale.length === 0) {
  console.log('nothing to migrate: the archive is already current')
  process.exit(0)
}

// Child evidence in historical coordinates, exactly as `src/format.js` builds it.
const childrenByParent = new Map()
for (const session of stale) {
  if (session.header.origin !== 'subagent' || session.header.parentSession === undefined) continue
  const evidence = historicalChildCatalogSource(restoreLog(historicalSessionFormatCatalog, session))
  const existing = childrenByParent.get(session.header.parentSession)
  if (existing === undefined) childrenByParent.set(session.header.parentSession, [evidence])
  else existing.push(evidence)
}

for (const session of stale) {
  const catalog = createSessionFormatCatalogWithChildren(childrenByParent.get(session.header.id) ?? [])
  const artifact = restoreLog(catalog, session)
  const delta = artifact.events.length - session.events.length
  const dense = artifact.events.every((event, index) => event.seq === index)
  console.log(`v${session.header.version}→v${artifact.header.version} ${session.logName}: ${session.events.length} → ${artifact.events.length} events (${delta >= 0 ? '+' : ''}${delta}), dense=${dense}, inherited=${artifact.inheritedEventCount}`)
  const catalogFacts = artifact.events.filter((event) => event.type === 'subagent/catalog').length
  const sourceFacts = session.events.filter((event) => event.type === 'subagent/catalog').length
  if (catalogFacts !== sourceFacts) console.log(`   subagent/catalog facts: ${sourceFacts} → ${catalogFacts}`)
  const roles = new Set(artifact.events.filter((event) => event.type === 'tool/result').map((event) => event.data?.message?.role))
  if (roles.size > 0) console.log(`   tool/result message roles: ${[...roles].join(', ')}`)
}
console.log('migration reproduced without a DSH instance')
