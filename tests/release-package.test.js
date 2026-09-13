'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { inventory, sha256, verifyPackage, validateManifest, classifyUpdate } = require('../app/lib/release-package')
const baseline = require('../maintenance/baseline.json')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-release-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const name of ['DeepSeek.exe', 'resources/app.asar', 'resources/node.exe', 'resources/runtime/lib/bin.js', 'resources/version.json']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), name.endsWith('version.json') ? JSON.stringify({ dshCommit: baseline.engineCommit, dshVersion: baseline.engineVersion }) : 'synthetic')
  }
  const manifest = { ...baseline, files: await inventory(root) }
  const bytes = JSON.stringify(manifest)
  await fs.writeFile(path.join(root, 'desktop-release.json'), bytes)
  return { root, manifest, digest: sha256(bytes) }
}
test('sealed package verifies without executing any contained code', async t => {
  const f = await fixture(t)
  assert.equal((await verifyPackage(f.root, f.digest)).releaseId, baseline.releaseId)
})
test('wrong authority digest, changed content and extra files fail closed', async t => {
  const f = await fixture(t)
  await assert.rejects(verifyPackage(f.root, '0'.repeat(64)), /digest/)
  await fs.writeFile(path.join(f.root, 'DeepSeek.exe'), 'tampered')
  await assert.rejects(verifyPackage(f.root, f.digest), /mismatch/)
  await fs.writeFile(path.join(f.root, 'extra.js'), 'extra')
  await assert.rejects(verifyPackage(f.root, f.digest), /inventory/)
})
test('path traversal, alternate streams and case collisions are refused', async t => {
  const { manifest } = await fixture(t)
  for (const name of ['../outside', '/absolute', 'C:/outside', 'file:stream', 'dir/../file', 'dir\\file', 'DeepSeek.EXE']) {
    assert.throws(() => validateManifest({ ...manifest, files: { ...manifest.files, [name]: '0'.repeat(64) } }))
  }
})
test('desktop, engine and incompatible data updates are distinct', async t => {
  const { manifest: old } = await fixture(t)
  const shell = { ...old, files: { ...old.files, 'resources/app.asar': '1'.repeat(64) } }
  assert.equal(classifyUpdate(old, shell).kind, 'desktop')
  const engine = { ...old, files: { ...old.files, 'resources/runtime/lib/bin.js': '2'.repeat(64) } }
  assert.equal(classifyUpdate(old, engine).kind, 'engine')
  assert.equal(classifyUpdate(old, { ...old, sessionReadVersions: [0, 2, 3], sessionWriteVersion: 3 }).kind, 'migration')
  assert.equal(classifyUpdate(old, { ...old, sessionReadVersions: [2] }).kind, 'migration')
  assert.equal(classifyUpdate(old, { ...old, protocol: 2 }).kind, 'blocked')
})
test('manifest metadata and reported runtime version must agree', async t => {
  const f = await fixture(t)
  const wrong = { ...f.manifest, engineVersion: 'wrong' }
  const bytes = JSON.stringify(wrong)
  await fs.writeFile(path.join(f.root, 'desktop-release.json'), bytes)
  await assert.rejects(verifyPackage(f.root, sha256(bytes)), /metadata/)
})
test('links cannot escape the inventory root', async t => {
  const f = await fixture(t)
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-link-test-'))
  t.after(() => fs.rm(other, { recursive: true, force: true }))
  await fs.symlink(other, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyPackage(f.root, f.digest), /Links/)
})

test('preparation resumes verified chunks, is repeatable, and never changes current package', async t => {
  const current = await fixture(t)
  const next = await fixture(t)
  next.manifest.releaseId += '-next'
  const bytes = JSON.stringify(next.manifest)
  await fs.writeFile(path.join(next.root, 'desktop-release.json'), bytes)
  next.digest = sha256(bytes)
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-prepare-test-'))
  t.after(() => fs.rm(cache, { recursive: true, force: true }))
  const partial = path.join(cache, next.manifest.releaseId + '.partial')
  await fs.mkdir(partial)
  await fs.copyFile(path.join(next.root, 'DeepSeek.exe'), path.join(partial, 'DeepSeek.exe'))
  const command = [path.join(__dirname, '../scripts/prepare-release.mjs'), next.root, next.digest, current.root, current.digest, cache]
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, command, { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).status, 'prepared')
  }
  await verifyPackage(current.root, current.digest)
  await verifyPackage(path.join(cache, next.manifest.releaseId), next.digest)
})

test('a schema-changing release cannot create a prepared update', async t => {
  const current = await fixture(t)
  const next = await fixture(t)
  next.manifest.releaseId += '-migration'
  next.manifest.sessionWriteVersion = 3
  next.manifest.sessionReadVersions.push(3)
  const bytes = JSON.stringify(next.manifest)
  await fs.writeFile(path.join(next.root, 'desktop-release.json'), bytes)
  const cache = path.join(current.root, 'must-not-be-created')
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/prepare-release.mjs'), next.root, sha256(bytes), current.root, current.digest, cache], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /migration qualification/)
  await assert.rejects(fs.access(cache))
})
