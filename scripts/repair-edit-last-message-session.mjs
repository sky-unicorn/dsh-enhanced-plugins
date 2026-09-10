/** Prepare historical edit attribution for DSH format migration, preserving message identities and surface operations. */
import {
  constants, zstdCompressSync, zstdDecompressSync,
} from 'node:zlib'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile, open, readFile, rename, rm,
} from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const ZSTD_MAGIC = 0xFD2FB528
const CHECKSUM_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyMarker(source, label) {
  if (!isRecord(source)) return undefined
  const marker = source.kind === 'edit-last-message' ? source
    : source.kind === 'plugin' && source.plugin === 'edit-last-message' && Object.hasOwn(source, 'editLastMessage')
      ? source.editLastMessage : undefined
  if (marker === undefined) return undefined
  if (!isRecord(marker)
    || marker.version !== 1
    || !Number.isSafeInteger(marker.rootSeq)
    || marker.rootSeq < 0
    || typeof marker.rootMessageId !== 'string'
    || marker.rootMessageId.length === 0) {
    throw new Error(`${label} contains an invalid legacy editLastMessage marker`)
  }
  return marker
}

function repairMessage(message, label) {
  if (!isRecord(message)) return false
  const marker = legacyMarker(message.source, `${label} source`)
  if (marker === undefined) return false
  // Same wire convention as createEditSource(). The offline repair stays
  // standalone so it can run before DSH is able to open the old artifact.
  message.source = {
    kind: 'plugin',
    plugin: 'dsh-enhanced/edit-last-message/v2/' + encodeURIComponent(marker.rootMessageId),
  }
  return true
}

function repairRecord(record, affectedSeqs) {
  if (!isRecord(record)) throw new Error('session JSONL member must be an object')
  let replacements = 0
  if (record.type === 'agent/inbox/spliced' && isRecord(record.data) && Array.isArray(record.data.inserted)) {
    for (const [index, message] of record.data.inserted.entries()) {
      if (repairMessage(message, `agent/inbox/spliced ${String(record.seq)} inserted[${index}]`)) replacements += 1
    }
  } else if (record.type === 'user/message' && isRecord(record.data)) {
    if (repairMessage(record.data, `user/message ${String(record.seq)}`)) replacements += 1
  }
  if (replacements > 0 && Number.isSafeInteger(record.seq)) affectedSeqs.add(record.seq)
  return replacements
}

function rewriteJsonl(plaintext, label, affectedSeqs) {
  if (plaintext.length === 0 || plaintext.at(-1) !== 0x0A) {
    throw new Error(`${label} does not end at a complete JSONL record`)
  }
  const lines = plaintext.toString('utf8').split('\n')
  let replacements = 0
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]
    if (line === undefined || line.length === 0) throw new Error(`${label} contains an empty JSONL record`)
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`${label} contains invalid JSON at line ${index + 1}`, { cause: error })
    }
    const changed = repairRecord(record, affectedSeqs)
    if (changed > 0) {
      lines[index] = JSON.stringify(record)
      replacements += changed
    }
  }
  return { bytes: Buffer.from(lines.join('\n')), replacements }
}

/** Locate complete frames in DSH's concatenated-Zstandard container. */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`incomplete Zstandard frame at byte ${start}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) throw new Error(`incomplete Zstandard frame at byte ${start}`)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error(`incomplete Zstandard frame at byte ${start}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`incomplete Zstandard frame at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error(`incomplete Zstandard frame at byte ${start}`)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`incomplete Zstandard frame at byte ${start}`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function repairZstd(input) {
  const frames = scanZstdFrames(input)
  if (frames.length === 0) throw new Error('empty Zstandard session artifact')
  const output = []
  const affectedSeqs = new Set()
  let replacements = 0
  for (const [index, frame] of frames.entries()) {
    const encoded = input.subarray(frame.start, frame.end)
    const plaintext = zstdDecompressSync(encoded)
    const rewritten = rewriteJsonl(plaintext, `Zstandard frame ${index}`, affectedSeqs)
    output.push(rewritten.replacements === 0 ? encoded : zstdCompressSync(rewritten.bytes, CHECKSUM_OPTIONS))
    replacements += rewritten.replacements
  }
  return { bytes: Buffer.concat(output), replacements, affectedSeqs: [...affectedSeqs] }
}

function repairPlaintext(input) {
  const affectedSeqs = new Set()
  const rewritten = rewriteJsonl(input, 'session artifact', affectedSeqs)
  return { ...rewritten, affectedSeqs: [...affectedSeqs] }
}

function repairBytes(input, artifactPath) {
  const zstd = input.length >= 4 && input.readUInt32LE(0) === ZSTD_MAGIC
  if (artifactPath.endsWith('.zstd') && !zstd) throw new Error('the .zstd artifact does not start with a Zstandard frame')
  return zstd ? repairZstd(input) : repairPlaintext(input)
}

function backupName(artifactPath, now) {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return `${artifactPath}.edit-last-message-backup-${stamp}`
}

async function writeAtomic(path, bytes) {
  const temporary = resolve(dirname(path), `.${basename(path)}.edit-last-message-${process.pid}-${Date.now()}.tmp`)
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Inspect or repair one DSH session artifact.
 * @param {string} path JSONL or concatenated-Zstandard session path.
 * @param {{ write?: boolean, now?: Date }} options mutation and deterministic backup options.
 */
export async function repairSessionArtifact(path, options = {}) {
  const artifactPath = resolve(path)
  const original = await readFile(artifactPath)
  const repaired = repairBytes(original, artifactPath)
  if (!options.write || repaired.replacements === 0) {
    return { artifactPath, backupPath: undefined, ...repaired, bytes: undefined }
  }

  // Refuse to replace a file that changed while it was being inspected.
  const current = await readFile(artifactPath)
  if (!current.equals(original)) throw new Error('session artifact changed during repair; stop DSH and retry')
  const backupPath = backupName(artifactPath, options.now ?? new Date())
  await copyFile(artifactPath, backupPath, fsConstants.COPYFILE_EXCL)
  await writeAtomic(artifactPath, repaired.bytes)
  return { artifactPath, backupPath, replacements: repaired.replacements, affectedSeqs: repaired.affectedSeqs }
}

function usage() {
  return 'Usage: node scripts/repair-edit-last-message-session.mjs [--write] <session.jsonl[.zstd]>'
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { write: { type: 'boolean', default: false } },
    allowPositionals: true,
  })
  if (positionals.length !== 1) throw new Error(usage())
  const result = await repairSessionArtifact(positionals[0], { write: values.write })
  console.log(JSON.stringify({
    mode: values.write ? 'write' : 'check',
    artifactPath: result.artifactPath,
    replacements: result.replacements,
    affectedSeqs: result.affectedSeqs,
    backupPath: result.backupPath ?? null,
  }, null, 2))
  if (!values.write && result.replacements > 0) console.log('No file was changed. Stop DSH and rerun with --write.')
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
