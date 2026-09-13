'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { resolveWorkspacePath } = require('../app/lib/workspace-path')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = { documents: path.join(root, 'documents'), exe: path.join(root, 'install-a', 'DeepSeek.exe'), userData: path.join(root, 'userdata') }
  fs.mkdirSync(paths.documents, { recursive: true }); fs.mkdirSync(path.dirname(paths.exe), { recursive: true }); fs.mkdirSync(paths.userData, { recursive: true })
  return { root, home: path.join(root, 'home'), app: { getPath: (name) => paths[name] }, paths }
}

test('default engine workspace is a created Documents business directory, not an install-version path', (t) => {
  const f = fixture(t); const workspace = resolveWorkspacePath({ app: f.app, env: {}, argv: [], tempDir: os.tmpdir(), dshHome: f.home })
  assert.equal(workspace, path.join(f.paths.documents, 'DeepSeek'))
  assert.ok(fs.statSync(workspace).isDirectory())
  const otherInstall = { getPath: (name) => name === 'exe' ? path.join(f.root, 'install-b', 'DeepSeek.exe') : f.paths[name] }
  assert.equal(resolveWorkspacePath({ app: otherInstall, env: {}, argv: [], tempDir: os.tmpdir(), dshHome: f.home }), workspace)
})

test('verification mode is isolated to TEMP and protected or dangerous overrides are rejected', (t) => {
  const f = fixture(t); const temporary = path.join(f.root, 'temp'); fs.mkdirSync(temporary)
  const verified = resolveWorkspacePath({ app: f.app, env: {}, argv: ['--verify-engine-recovery'], tempDir: temporary, dshHome: f.home })
  assert.equal(verified, path.join(temporary, 'deepseek-desktop-workspace'))
  assert.equal(resolveWorkspacePath({ app: f.app, env: {}, argv: ['--verify'], tempDir: temporary, dshHome: f.home }), verified)
  assert.equal(resolveWorkspacePath({ app: f.app, env: {}, argv: ['--shot=verification.png'], tempDir: temporary, dshHome: f.home }), verified)
  for (const target of [path.dirname(f.paths.exe), path.join(path.dirname(f.paths.exe), 'child'), f.home, f.paths.userData, path.parse(f.root).root]) {
    assert.throws(() => resolveWorkspacePath({ app: f.app, env: { DSH_WORKSPACE: target }, argv: [], tempDir: temporary, dshHome: f.home }), /Workspace|filesystem root/)
  }
  assert.throws(() => resolveWorkspacePath({ app: f.app, env: { DSH_WORKSPACE: path.join(f.root, 'outside-temp') }, argv: ['--verify-engine-recovery'], tempDir: temporary, dshHome: f.home }), /temporary/)
  assert.throws(() => resolveWorkspacePath({ app: f.app, env: { DSH_WORKSPACE: 'relative-workspace' }, argv: [], tempDir: temporary, dshHome: f.home }), /absolute/)
})

test('an explicit absolute workspace override is created outside protected roots in normal operation', (t) => {
  const f = fixture(t); const requested = path.join(f.root, 'operator-workspace')
  assert.equal(resolveWorkspacePath({ app: f.app, env: { DSH_WORKSPACE: requested }, argv: [], tempDir: os.tmpdir(), dshHome: f.home }), requested)
  assert.ok(fs.statSync(requested).isDirectory())
})

test('isolated and explicit workspace modes do not require an Electron Documents path', (t) => {
  const f = fixture(t); const temporary = path.join(f.root, 'temp'); fs.mkdirSync(temporary)
  const noDocuments = { getPath: (name) => {
    if (name === 'documents') throw new Error('Documents path unavailable')
    return f.paths[name]
  } }
  assert.equal(resolveWorkspacePath({ app: noDocuments, env: { DSH_TEST_MODE: '1' }, argv: ['--verify'], tempDir: temporary, dshHome: f.home }), path.join(temporary, 'deepseek-desktop-workspace'))
  const explicit = path.join(f.root, 'explicit-workspace')
  assert.equal(resolveWorkspacePath({ app: noDocuments, env: { DSH_WORKSPACE: explicit }, argv: [], tempDir: temporary, dshHome: f.home }), explicit)
  assert.throws(() => resolveWorkspacePath({ app: noDocuments, env: {}, argv: [], tempDir: temporary, dshHome: f.home }), /Documents path unavailable/)
})

test('a junction to a protected location rejects a new workspace child without creating it', (t) => {
  const f = fixture(t); const temporary = path.join(f.root, 'temp'); fs.mkdirSync(temporary); fs.mkdirSync(f.home); const outside = path.join(f.root, 'outside-temp'); fs.mkdirSync(outside)
  for (const [name, destination, expected, argv, parent] of [
    ['install-link', path.dirname(f.paths.exe), /installation/, [], f.root],
    ['credentials-link', f.home, /credentials/, [], f.root],
    ['outside-temp-link', outside, /temporary/, ['--verify-engine-recovery'], temporary],
  ]) {
    const link = path.join(parent, name); const child = 'must-not-be-created'
    try { fs.symlinkSync(destination, link, 'junction') } catch (error) { t.skip(`junction fixture unavailable: ${error.message}`); return }
    assert.throws(() => resolveWorkspacePath({ app: f.app, env: { DSH_WORKSPACE: path.join(link, child) }, argv, tempDir: temporary, dshHome: f.home }), expected)
    assert.equal(fs.existsSync(path.join(destination, child)), false)
  }
})

test('main launches the engine with the resolved workspace and propagates only that explicit cwd', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8')
  assert.match(main, /const workspace = resolveWorkspacePath\(/)
  assert.match(main, /env\.DSH_WORKSPACE = workspace/)
  assert.match(main, /cwd: workspace/)
  assert.doesNotMatch(main, /cwd: path\.dirname\(app\.getPath\('exe'\)\)/)
})

test('every isolated Desktop launcher opts into the temporary workspace mode', () => {
  const root = path.join(__dirname, '..')
  for (const script of ['scripts/verify-task-window-electron.cjs', 'scripts/test-desktop.ps1', 'scripts/install-validated.ps1']) {
    const source = fs.readFileSync(path.join(root, script), 'utf8')
    assert.match(source, /DSH_TEST_MODE\s*=\s*['"]1['"]/, `${script} must set DSH_TEST_MODE`)
  }
})
