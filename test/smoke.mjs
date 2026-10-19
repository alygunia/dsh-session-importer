// Local smoke test for the archive half of dsh-session-importer.
//
// Runs with plain `node` and no dependencies: it exercises the ZIP reader and
// the import planner against the real exported archive that ships beside this
// package, then checks the planner's refusals on synthetic logs. The Host half
// (persistence writes, workspace grouping, the HTTP route) needs a live
// deployment and is covered by the manual checks in README.md.
//
//   node test/smoke.mjs [path/to/archive.zip]      (or set DSH_TEST_ARCHIVE)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { readZipEntries, ZipReadError } from '../src/zip.js'
import { classifyArchive, buildImportPlan, parseSessionLog, readRootHeader, remapAttachments, ArchiveError } from '../src/archive.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

/**
 * Locate the sample archive: explicit argv path, `DSH_TEST_ARCHIVE`, else a
 * `dsh-session-session-*.zip` beside this package. The archive is user data
 * rather than a checked-in fixture, so it may live anywhere.
 * @returns the archive path.
 */
function sampleArchive() {
  if (process.argv[2] !== undefined) return process.argv[2]
  if (typeof process.env.DSH_TEST_ARCHIVE === 'string' && process.env.DSH_TEST_ARCHIVE !== '') return process.env.DSH_TEST_ARCHIVE
  const candidate = fs.readdirSync(root).find((name) => name.startsWith('dsh-session-session-') && name.endsWith('.zip'))
  if (candidate === undefined) {
    throw new Error(`no sample archive found: pass one as the first argument, set DSH_TEST_ARCHIVE, or put a dsh-session-session-*.zip in ${root}`)
  }
  return path.join(root, candidate)
}

/** Build one minimal stored/deflated ZIP for reader tests. */
function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const body = Buffer.from(text, 'utf8')
    const deflated = deflateRawSync(body)
    const crc = crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBytes, deflated)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(deflated.length, 20)
    header.writeUInt32LE(body.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBytes)
    offset += local.length + nameBytes.length + deflated.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, eocd])
}

/** CRC-32 (IEEE) over one buffer, for building well-formed test archives. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const checks = []
/** Run one named check and record its outcome. */
function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error })
  }
}

// --- the real exported archive ------------------------------------------------

const archivePath = sampleArchive()
const bytes = fs.readFileSync(archivePath)
let entries
let archive
let plan

check('reads every entry of a real export', () => {
  entries = readZipEntries(bytes)
  assert.ok(entries.size >= 3, `expected several entries, got ${entries.size}`)
  // The export names the root log after the generation it holds, so the check
  // asserts the *shape* rather than one generation's filename.
  const rootEntry = [...entries.keys()].find((name) => /^session(\.v\d+)?\.jsonl$/u.test(name))
  assert.ok(rootEntry !== undefined, 'root log entry is missing')
})

check('classifies root, subagents, and media', () => {
  archive = classifyArchive(entries)
  assert.match(archive.root.name, /^session(\.v\d+)?\.jsonl$/u)
  assert.ok(archive.subagents.length >= 1, 'expected at least one subagent log')
  assert.ok(archive.media.length >= 1, 'expected at least one image')
  for (const image of archive.media) {
    assert.match(image.attachmentId, /^sha256:[0-9a-f]{64}$/u)
    assert.ok(image.mediaType.startsWith('image/'), image.mediaType)
  }
})

check('adopts the root header without parsing events', () => {
  const header = readRootHeader(archive.root)
  assert.equal(typeof header.id, 'string')
  assert.equal(header.isSeeded, false)
  assert.equal(header.delegationDepth, 0)
  assert.equal(header.parentSession, undefined)
})

check('plans every session with contiguous events and preserved ids', () => {
  plan = buildImportPlan(archive, {})
  assert.equal(plan.sessions.length, 1 + archive.subagents.length)
  const root = plan.sessions.find((session) => session.role === 'root')
  assert.equal(root.header.id, readRootHeader(archive.root).id, 'root id must be preserved')
  assert.ok(root.events.length > 0, 'root log has no events')
  for (const session of plan.sessions) {
    assert.equal(session.events[0].seq, 0)
    assert.equal(session.events.at(-1).seq, session.events.length - 1)
  }
  const subagent = plan.sessions.find((session) => session.role === 'subagent')
  if (subagent !== undefined) {
    assert.equal(subagent.header.parentSession, root.header.id, 'subagent must name the preserved root id')
    assert.equal(subagent.header.origin, 'subagent')
  }
})

check('stamps the requested cwd on every header', () => {
  const target = process.platform === 'win32' ? 'C:\\imported-workspace' : '/imported-workspace'
  const stamped = buildImportPlan(archive, { cwd: target })
  for (const session of stamped.sessions) assert.equal(session.header.cwd, target)
})

check('rewrites attachment references through a remap', () => {
  const media = plan.media[0]
  if (media === undefined) return
  const reference = { type: 'image', attachment: { attachmentId: media.attachmentId, mediaType: media.mediaType, bytes: media.data.length, width: 1, height: 1 } }
  const synthetic = [{ events: [{ seq: 0, type: 'user/message', data: { message: { content: [reference] } } }] }]
  const replacement = { attachmentId: 'sha256:' + 'f'.repeat(64), mediaType: media.mediaType, bytes: 1, width: 1, height: 1 }
  const rewritten = remapAttachments(synthetic, new Map([[media.attachmentId, replacement]]))
  assert.equal(rewritten, 1)
  assert.equal(synthetic[0].events[0].data.message.content[0].attachment.attachmentId, replacement.attachmentId)
})

// --- synthetic refusals -------------------------------------------------------

/** A minimal valid log for one synthetic archive. */
function logText(header, events) {
  return [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n') + '\n'
}

const baseHeader = { type: 'session', version: 3, id: 'session-11111111-1111-1111-1111-111111111111', createdAt: 1, cwd: process.platform === 'win32' ? 'C:\\w' : '/w', isSeeded: false, delegationDepth: 0 }

check('round-trips a deflated archive built by the test', () => {
  const built = buildZip([['session.v3.jsonl', logText(baseHeader, [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])]])
  const classified = classifyArchive(readZipEntries(built))
  const built_plan = buildImportPlan(classified, {})
  assert.equal(built_plan.sessions.length, 1)
  assert.equal(built_plan.sessions[0].events.length, 1)
})

check('refuses a non-ZIP buffer', () => {
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all')), ZipReadError)
})

check('refuses an archive with no root log', () => {
  const built = buildZip([['media/sha256:' + 'a'.repeat(64) + '.png', 'x']])
  assert.throws(() => classifyArchive(readZipEntries(built)), ArchiveError)
})

check('refuses a header with an unknown field', () => {
  const header = { ...baseHeader, mystery: true }
  assert.throws(() => parseSessionLog(logText(header, []), 'log'), /unknown field "mystery"/u)
})

check('refuses a non-contiguous event log', () => {
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: 'completed' } }]
  assert.throws(() => parseSessionLog(logText(baseHeader, events), 'log'), /contiguous/u)
})

check('refuses a seeded log without its inherited marker', () => {
  const header = { ...baseHeader, isSeeded: true }
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]
  assert.throws(() => parseSessionLog(logText(header, events), 'log'), /inherited prefix/u)
})

check('derives the inherited cut from the inherited end-seed marker', () => {
  const header = { ...baseHeader, isSeeded: true }
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } },
    { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
  ]
  const parsed = parseSessionLog(logText(header, events), 'log')
  assert.equal(parsed.inheritedEventCount, 2)
})

// --- report -------------------------------------------------------------------

let failed = 0
for (const result of checks) {
  if (result.ok) console.log(`  ok   ${result.name}`)
  else {
    failed += 1
    console.error(`  FAIL ${result.name}\n       ${result.error && result.error.message}`)
  }
}
const summary = `${checks.length - failed}/${checks.length} checks passed against ${path.basename(archivePath)}`
if (failed > 0) {
  console.error(summary)
  process.exitCode = 1
} else console.log(summary)
