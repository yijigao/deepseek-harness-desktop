'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { crc32, deflateRawSync } = require('node:zlib')
const { extractArtifact, validateEntries } = require('../scripts/lib/extract-artifact.cjs')
const { sha256 } = require('../app/lib/release-package')
const baseline = require('../maintenance/baseline.json')

function zip(files, compressed = false) {
  const locals = [], central = []
  let offset = 0
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(value)
    const data = compressed ? deflateRawSync(bytes) : bytes
    const local = Buffer.alloc(30), record = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
    local.writeUInt16LE(compressed ? 8 : 0, 8); local.writeUInt32LE(crc32(bytes), 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6)
    record.writeUInt16LE(compressed ? 8 : 0, 10); record.writeUInt32LE(crc32(bytes), 16)
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28)
    record.writeUInt32LE(offset, 42)
    locals.push(local, filename, data); central.push(record, filename)
    offset += local.length + filename.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
async function fixture(t, compressed = false, mutate = files => files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-release-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const files = Object.fromEntries(['DeepSeek.exe', 'resources/app.asar', 'resources/node.exe', 'resources/runtime/lib/bin.js'].map(n => [n, 'synthetic only']))
  files['resources/version.json'] = JSON.stringify({ dshCommit: baseline.engineCommit, dshVersion: baseline.engineVersion })
  const manifest = JSON.stringify({ ...baseline, files: Object.fromEntries(Object.entries(files).map(([n, v]) => [n, sha256(v)])) })
  files['desktop-release.json'] = manifest
  const bytes = zip(mutate(files), compressed)
  const archive = path.join(root, 'release.zip')
  await fs.writeFile(archive, bytes)
  return { archive, sha256: sha256(bytes), size: bytes.length, manifestSha256: sha256(manifest), destination: path.join(root, 'candidate') }
}
for (const compressed of [false, true]) test(`verified ZIP extraction, deflate=${compressed}, never overwrites`, async t => {
  const args = await fixture(t, compressed)
  const result = await extractArtifact(args)
  assert.equal(result.status, 'verified')
  assert.equal(await fs.readFile(path.join(result.candidate, 'DeepSeek.exe'), 'utf8'), 'synthetic only')
  await assert.rejects(extractArtifact(args), /EEXIST/)
})
test('archive and manifest digest failures cannot publish package', async t => {
  const args = await fixture(t)
  await assert.rejects(extractArtifact({ ...args, sha256: '0'.repeat(64) }), /digest/)
  await assert.rejects(fs.stat(args.destination), /ENOENT/)
  await assert.rejects(extractArtifact({ ...args, manifestSha256: '0'.repeat(64) }), /digest/)
  await assert.rejects(fs.stat(path.join(args.destination, 'package')), /ENOENT/)
})
test('extra or tampered archive contents fail package verification', async t => {
  for (const mutate of [f => ({ ...f, 'extra.txt': 'extra' }), f => ({ ...f, 'DeepSeek.exe': 'wrong' })]) {
    const args = await fixture(t, true, mutate)
    await assert.rejects(extractArtifact(args), /inventory|mismatch/)
    await assert.rejects(fs.stat(path.join(args.destination, 'package')), /ENOENT/)
  }
})
const entry = (name, other = {}) => ({ path: name, type: 'File', externalFileAttributes: 0, diskNumber: 0, flags: 0, compressionMethod: 0, uncompressedSize: 1, ...other })
test('unsafe paths, Windows aliases and ZIP directory conflicts fail', () => {
  for (const name of ['../outside', '/absolute', 'C:/drive', 'file:stream', 'x\\y', 'aux.txt', 'dir/NUL', 'dir./file', 'a//b', 'a/./b', 'a\u0000b']) assert.throws(() => validateEntries([entry(name)]), /Unsafe/)
  for (const names of [['a', 'A'], ['a', 'a/b'], ['Dir/a', 'dir/b']]) assert.throws(() => validateEntries(names.map(n => entry(n))), /Duplicate|conflict/)
})
test('links, encrypted files, unsupported codecs and bombs fail', () => {
  for (const fields of [{ externalFileAttributes: 0xa000 << 16 }, { flags: 1 }, { compressionMethod: 99 }, { uncompressedSize: 1024 ** 3 + 1 }, { diskNumber: 1 }]) assert.throws(() => validateEntries([entry('file', fields)]))
  assert.throws(() => validateEntries(['a', 'b', 'c'].map(n => entry(n, { uncompressedSize: 1024 ** 3 }))), /expanded/)
})
test('traversal is rejected before any extraction directory exists', async t => {
  const args = await fixture(t, false, f => ({ ...f, '../outside': 'bad' }))
  await assert.rejects(extractArtifact(args), /Unsafe/)
  await assert.rejects(fs.stat(args.destination), /ENOENT/)
})
test('actual decompression is bounded even when central directory lies', async t => {
  const args = await fixture(t, true)
  const bytes = await fs.readFile(args.archive)
  const centralOffset = bytes.readUInt32LE(bytes.length - 6)
  bytes.writeUInt32LE(1, centralOffset + 24)
  await fs.writeFile(args.archive, bytes)
  await assert.rejects(extractArtifact({ ...args, sha256: sha256(bytes) }), /exceeded|size/)
  await assert.rejects(fs.stat(path.join(args.destination, 'package')), /ENOENT/)
})
test('oversized directory count is rejected before ZIP parser allocation', async t => {
  const args = await fixture(t)
  const bytes = await fs.readFile(args.archive)
  bytes.writeUInt16LE(65535, bytes.length - 14)
  bytes.writeUInt16LE(65535, bytes.length - 12)
  await fs.writeFile(args.archive, bytes)
  await assert.rejects(extractArtifact({ ...args, sha256: sha256(bytes) }), /Unsupported ZIP directory/)
  await assert.rejects(fs.stat(args.destination), /ENOENT/)
})
