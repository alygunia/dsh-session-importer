// Minimal, dependency-free ZIP reader for DSH session-log archives.
//
// `@deepseek-ai/dsh-session-log-export` writes the archive with fflate's
// streaming DEFLATE writer, so every entry this reader must accept is either
// stored (method 0) or raw-deflated (method 8). Parsing the central directory
// with node:zlib keeps the importer free of runtime dependencies, which
// matters because a DSH plugin package is resolved from the profile's own
// node_modules.
//
// Scope on purpose: no ZIP64 (a session export is far below 4 GiB and 65535
// entries), no encryption, no multi-disk. Anything outside that scope is
// refused loudly rather than half-decoded.

import { inflateRawSync } from 'node:zlib'

/** End of central directory record signature. */
const EOCD_SIGNATURE = 0x06054b50
/** Central directory file header signature. */
const CDIR_SIGNATURE = 0x02014b50
/** Local file header signature. */
const LOCAL_SIGNATURE = 0x04034b50
/** Highest EOCD comment length, so the search window is bounded. */
const MAX_COMMENT_BYTES = 0xffff

/** Refusal raised for any archive this reader cannot decode safely. */
export class ZipReadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZipReadError'
  }
}

/**
 * Locate the end-of-central-directory record by scanning backwards from the
 * tail (the comment field makes its offset variable).
 * @param buffer - the complete archive bytes.
 * @returns the record's byte offset.
 * @throws {ZipReadError} when no plausible record exists.
 */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - MAX_COMMENT_BYTES - 22)
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) return offset
  }
  throw new ZipReadError('not a ZIP archive (no end-of-central-directory record)')
}

/**
 * Read one archive into memory as named entries.
 *
 * The returned map is small in entry count but each value holds the entry's
 * complete bytes; callers pass `maxExtractedBytes` so a hostile or corrupt
 * archive cannot exhaust the host's memory while being inspected.
 * @param input - the archive bytes.
 * @param options - extraction guards.
 * @param options.maxExtractedBytes - refuse the archive once the inflated total exceeds this.
 * @param options.maxEntries - refuse an archive with more entries than this.
 * @returns entry names mapped to their decoded bytes (directory rows omitted).
 * @throws {ZipReadError} for an unreadable, unsupported, or oversized archive.
 */
export function readZipEntries(input, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const maxExtractedBytes = options.maxExtractedBytes ?? 1 << 30
  const maxEntries = options.maxEntries ?? 4096
  const eocd = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new ZipReadError('ZIP64 archives are not supported by this importer')
  }
  if (entryCount > maxEntries) throw new ZipReadError(`archive has ${entryCount} entries; the limit is ${maxEntries}`)
  if (directoryOffset + directorySize > buffer.length) throw new ZipReadError('central directory extends past the end of the archive')

  const entries = new Map()
  let cursor = directoryOffset
  let extracted = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CDIR_SIGNATURE) {
      throw new ZipReadError(`central directory entry ${index + 1} is malformed`)
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    // Directory rows carry no payload and never name an import input.
    if (name.endsWith('/')) continue
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipReadError(`entry "${name}" has no local file header`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new ZipReadError(`entry "${name}" is truncated`)

    const raw = buffer.subarray(dataStart, dataEnd)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch (error) {
        throw new ZipReadError(`entry "${name}" failed to inflate: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else throw new ZipReadError(`entry "${name}" uses unsupported compression method ${method}`)

    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new ZipReadError(`entry "${name}" inflated to ${data.length} bytes, expected ${uncompressedSize}`)
    }
    extracted += data.length
    if (extracted > maxExtractedBytes) {
      throw new ZipReadError(`archive inflates past the ${maxExtractedBytes}-byte extraction limit`)
    }
    if (entries.has(name)) throw new ZipReadError(`archive contains duplicate entry "${name}"`)
    entries.set(name, data)
  }
  if (entries.size === 0) throw new ZipReadError('archive contains no files')
  return entries
}
