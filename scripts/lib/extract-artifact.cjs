'use strict'
const fs = require('node:fs/promises')
const { createReadStream, createWriteStream } = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const unzipper = createRequire(path.resolve(__dirname, '../../app/package.json'))('unzipper')
const { verifyPackage } = require('../../app/lib/release-package')

const LIMITS = { entries: 60000, file: 1024 ** 3, total: 2 * 1024 ** 3 }
function validateEntries(entries) {
  if (!entries.length || entries.length > LIMITS.entries) throw Error('ZIP entry limit exceeded')
  const names = new Map()
  let total = 0
  for (const entry of entries) {
    const directory = entry.type === 'Directory'
    const name = directory ? entry.path.slice(0, -1) : entry.path
    if (!name || name.length > 240 || /[\\:<>"|?*\x00-\x1f\x7f\ufffd]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw Error('Unsafe ZIP path')
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000
    if ((mode && mode !== (directory ? 0x4000 : 0x8000)) || (entry.externalFileAttributes & 0x400) || entry.diskNumber || (entry.flags & ~0x80e) || ![0, 8].includes(entry.compressionMethod)) throw Error('Unsupported ZIP entry')
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > LIMITS.file || (directory && entry.uncompressedSize)) throw Error('ZIP file size limit exceeded')
    total += entry.uncompressedSize
    if (total > LIMITS.total) throw Error('ZIP expanded size limit exceeded')
    const key = name.toLowerCase()
    if (names.has(key)) throw Error('Duplicate ZIP path')
    names.set(key, { directory, name })
  }
  const parents = new Map()
  for (const { name } of names.values()) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      const key = parent.toLowerCase()
      if ((names.has(key) && (!names.get(key).directory || names.get(key).name !== parent)) || (parents.has(key) && parents.get(key) !== parent)) throw Error('ZIP directory conflict')
      parents.set(key, parent)
    }
  }
}

// Bound central-directory allocation before passing the archive to unzipper.
// Release archives deliberately use single-disk, non-ZIP64 ZIP (under 2 GiB).
async function preflight(archive, size) {
  const file = await fs.open(archive, 'r')
  try {
    const tail = Buffer.alloc(Math.min(size, 65557))
    await file.read(tail, 0, tail.length, size - tail.length)
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== 0x06054b50 || i + 22 + tail.readUInt16LE(i + 20) !== tail.length) continue
      const count = tail.readUInt16LE(i + 10)
      const length = tail.readUInt32LE(i + 12)
      const offset = tail.readUInt32LE(i + 16)
      if (tail.readUInt16LE(i + 4) || tail.readUInt16LE(i + 6) || tail.readUInt16LE(i + 8) !== count || !count || count > LIMITS.entries || length > 32 * 1024 ** 2 || offset + length !== size - tail.length + i) throw Error('Unsupported ZIP directory')
      return count
    }
    throw Error('Missing ZIP directory')
  } finally { await file.close() }
}

async function extractArtifact({ archive, sha256, size, manifestSha256, destination }) {
  if (![sha256, manifestSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) || !Number.isSafeInteger(size) || size < 22 || size > LIMITS.total) throw Error('Trusted archive hash, size and manifest hash required')
  const stat = await fs.lstat(archive)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size) throw Error('Archive size/type mismatch')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(archive)) digest.update(chunk)
  if (digest.digest('hex') !== sha256) throw Error('Archive digest mismatch')
  const count = await preflight(archive, size)
  const zip = await unzipper.Open.file(archive)
  if (zip.files.length !== count) throw Error('ZIP directory count mismatch')
  validateEntries(zip.files)
  const target = path.resolve(destination)
  // Reserve a new container exclusively; publish only its verified child.
  // Failure keeps diagnostic files under .extracting, never a usable package.
  await fs.mkdir(target)
  const partial = path.join(target, '.extracting')
  await fs.mkdir(partial)
  for (const entry of zip.files) {
    const output = path.join(partial, entry.path)
    if (entry.type === 'Directory') { await fs.mkdir(output, { recursive: true }); continue }
    await fs.mkdir(path.dirname(output), { recursive: true })
    let bytes = 0
    const bound = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length
      callback(bytes > entry.uncompressedSize ? Error('ZIP stream exceeded declared size') : null, chunk)
    } })
    await pipeline(entry.stream(), bound, createWriteStream(output, { flags: 'wx' }))
    if (bytes !== entry.uncompressedSize) throw Error('ZIP stream size mismatch')
  }
  const manifest = await verifyPackage(partial, manifestSha256)
  const candidate = path.join(target, 'package')
  await fs.rename(partial, candidate)
  return { status: 'verified', candidate, releaseId: manifest.releaseId, manifestSha256 }
}
module.exports = { extractArtifact, validateEntries, preflight }
