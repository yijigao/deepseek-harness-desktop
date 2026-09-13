'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const MANIFEST = 'desktop-release.json'
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function validateManifest(value) {
  if (value?.schema !== 1 || !/^[a-z0-9][a-z0-9.-]{0,95}$/.test(value.releaseId || '')) throw Error('Invalid release identity')
  if (!/^[a-f0-9]{40}$/.test(value.engineCommit || '') || !validHash(value.patchsetSha256)) throw Error('Missing pinned source identity')
  if (!Number.isSafeInteger(value.protocol) || value.protocol < 1 || !Number.isSafeInteger(value.sessionWriteVersion)) throw Error('Invalid compatibility contract')
  if (!Array.isArray(value.sessionReadVersions) || !value.sessionReadVersions.length || value.sessionReadVersions.some(v => !Number.isSafeInteger(v) || v < 0) || !value.sessionReadVersions.includes(value.sessionWriteVersion)) throw Error('Invalid session formats')
  if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw Error('Missing inventory')
  const names = new Set()
  for (const [name, hash] of Object.entries(value.files)) {
    if (!name || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)) || name === MANIFEST || !validHash(hash)) throw Error('Invalid inventory entry')
    if (names.has(name.toLowerCase())) throw Error('Case-colliding inventory entries')
    names.add(name.toLowerCase())
  }
  for (const required of ['DeepSeek.exe', 'resources/app.asar', 'resources/node.exe', 'resources/runtime/lib/bin.js', 'resources/version.json']) {
    if (!value.files[required]) throw Error(`Missing release file: ${required}`)
  }
  return value
}

async function inventory(root) {
  const names = []
  async function visit(dir, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name
      const absolute = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw Error(`Links are not allowed in release packages: ${name}`)
      if (entry.isDirectory()) await visit(absolute, name + '/')
      else if (entry.isFile() && name !== MANIFEST) names.push(name)
      else if (!entry.isFile()) throw Error(`Unsupported release entry: ${name}`)
    }
  }
  if (!(await fs.lstat(root)).isDirectory() || (await fs.lstat(root)).isSymbolicLink()) throw Error('Release root must be a real directory')
  await visit(root)
  names.sort()
  const results = new Array(names.length)
  let cursor = 0
  // Bound I/O and memory; stream large Electron binaries rather than buffering
  // them. Preserve inventory order regardless of completion order.
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
    while (cursor < names.length) {
      const index = cursor++
      const name = names[index]
      const absolute = path.join(root, name)
      if ((await fs.lstat(absolute)).isSymbolicLink()) throw Error(`Links are not allowed in release packages: ${name}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(absolute)) hash.update(chunk)
      results[index] = [name, hash.digest('hex')]
    }
  }))
  return Object.fromEntries(results)
}

async function verifyPackage(root, expectedManifestSha256) {
  if (!validHash(expectedManifestSha256)) throw Error('A trusted manifest SHA-256 is required')
  const manifestPath = path.join(root, MANIFEST)
  if ((await fs.lstat(manifestPath)).isSymbolicLink()) throw Error('Manifest cannot be a link')
  const bytes = await fs.readFile(manifestPath)
  if (sha256(bytes) !== expectedManifestSha256) throw Error('Release manifest digest mismatch')
  const manifest = validateManifest(JSON.parse(bytes))
  const actual = await inventory(root)
  if (Object.keys(actual).length !== Object.keys(manifest.files).length) throw Error('Release inventory differs')
  for (const [name, hash] of Object.entries(manifest.files)) if (actual[name] !== hash) throw Error(`Release file mismatch: ${name}`)
  const build = JSON.parse(await fs.readFile(path.join(root, 'resources/version.json'), 'utf8'))
  if (build.dshCommit !== manifest.engineCommit || build.dshVersion !== manifest.engineVersion) throw Error('Engine metadata mismatch')
  return manifest
}

function classifyUpdate(current, next) {
  validateManifest(current)
  validateManifest(next)
  if (current.protocol !== next.protocol) return { kind: 'blocked', reason: 'Desktop/engine protocol boundary requires explicit qualification' }
  if (current.sessionWriteVersion !== next.sessionWriteVersion || current.sessionReadVersions.some(v => !next.sessionReadVersions.includes(v))) return { kind: 'migration', reason: 'Explicit session migration qualification required' }
  const runtimeFiles = manifest => Object.entries(manifest.files).filter(([name]) => name.startsWith('resources/runtime/') || name === 'resources/node.exe').sort(([a], [b]) => a.localeCompare(b))
  const engineChanged = current.engineCommit !== next.engineCommit || current.patchsetSha256 !== next.patchsetSha256 || JSON.stringify(runtimeFiles(current)) !== JSON.stringify(runtimeFiles(next))
  return { kind: engineChanged ? 'engine' : 'desktop', reason: 'Session format contract unchanged; full package remains integrity-checked' }
}

module.exports = { MANIFEST, sha256, validateManifest, inventory, verifyPackage, classifyUpdate }
