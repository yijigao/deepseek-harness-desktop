'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const archive = require('../app/lib/task-archive/service')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-archive-'))
  const home = path.join(root, '.dsh'); const manifest = path.join(root, 'manifest.json')
  fs.writeFileSync(path.join(root, 'proof.txt'), 'proof v1')
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, items: [
    { itemId: 'ok', status: 'succeeded', artifactPath: 'proof.txt', evidence: 'checked', diff: '<img src=x onerror=alert(1)>' },
    { itemId: 'bad', status: 'failed', error: 'failed on purpose' },
    { itemId: 'mystery', status: 'what-is-this' },
  ] }))
  return { root, home, manifest }
}
function bind(data) { return archive.bind(data.home, data.manifest, { title: 'batch' }) }

test('archive keeps only metadata and derives lock from current source row and artifact', () => {
  const data = fixture(); let view = bind(data)
  const stored = JSON.parse(fs.readFileSync(path.join(data.home, 'task-archives', `${view.archive.taskId}.json`), 'utf8'))
  assert.equal(Object.hasOwn(stored, 'items'), false)
  assert.equal(Object.hasOwn(stored, 'count'), false)
  const ok = view.items.find((item) => item.itemId === 'ok')
  const inspected = archive.itemDetails(data.home, view.archive.taskId, 'ok')
  view = archive.accept(data.home, view.archive.taskId, 'ok', ok.sourceSha256, view.manifest.sha256, inspected.artifact.sha256)
  assert.equal(view.items.find((item) => item.itemId === 'ok').acceptance.valid, true)
  fs.writeFileSync(path.join(data.root, 'proof.txt'), 'proof v2')
  assert.equal(archive.view(data.home, view.archive.taskId).items.find((item) => item.itemId === 'ok').acceptance.valid, false)
  fs.writeFileSync(path.join(data.root, 'proof.txt'), 'proof v1')
  const source = JSON.parse(fs.readFileSync(data.manifest, 'utf8')); source.items[0].evidence = 'changed'; fs.writeFileSync(data.manifest, JSON.stringify(source))
  assert.equal(archive.view(data.home, view.archive.taskId).items.find((item) => item.itemId === 'ok').acceptance.valid, false)
})

test('CSV quoting, duplicate IDs, missing IDs, and unknown statuses stay isolated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-csv-')); const csv = path.join(root, 'items.csv')
  fs.writeFileSync(csv, '\ufeffid,status,error\na,failed,"two\nlines"\na,failed,x\n,wat,x\nb,wat,x\n')
  const parsed = archive.parseManifest(csv)
  assert.equal(parsed.items.length, 4)
  assert.equal(parsed.items[0].state, 'invalid')
  assert.equal(parsed.items[1].state, 'invalid')
  assert.equal(parsed.items[2].problem, 'Missing explicit item ID')
  assert.equal(parsed.items[3].status, 'unknown')
  fs.writeFileSync(csv, 'id,id,status\na,a,failed\n')
  assert.throws(() => archive.parseManifest(csv), /duplicate headers/)
})

test('legacy success needs explicit mapping and cannot silently become a standard success', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-map-')); const manifest = path.join(root, 'legacy.json')
  fs.writeFileSync(manifest, JSON.stringify([{ id: 'one', state: 'success' }]))
  assert.equal(archive.parseManifest(manifest).items[0].status, 'unknown')
  const parsed = archive.parseManifest(manifest, { fields: { itemId: 'id', status: 'state' }, statusMap: { success: 'legacy_succeeded' } })
  assert.equal(parsed.items[0].status, 'legacy_succeeded')
  const view = archive.bind(path.join(root, '.dsh'), manifest, { adapter: parsed.adapter })
  assert.equal(view.items[0].status, 'legacy_succeeded')
})

test('accept requires current artifact and retry emits only unique failed IDs', () => {
  const data = fixture(); const view = bind(data); const ok = view.items.find((item) => item.itemId === 'ok')
  fs.unlinkSync(path.join(data.root, 'proof.txt'))
  assert.throws(() => archive.accept(data.home, view.archive.taskId, 'ok', ok.sourceSha256, view.manifest.sha256), /Artifact/)
  const plan = archive.retryPlan(data.home, view.archive.taskId)
  assert.deepEqual(plan.itemIds, ['bad'])
  assert.equal(plan.manifestSha256, view.manifest.sha256)
})

test('inspect-to-accept rejects an artifact changed after inspection and stores prototype-like IDs', () => {
  const data = fixture(); let view = bind(data); const item = view.items.find((value) => value.itemId === 'ok')
  const inspected = archive.itemDetails(data.home, view.archive.taskId, 'ok'); fs.writeFileSync(path.join(data.root, 'proof.txt'), 'changed after inspect')
  assert.throws(() => archive.accept(data.home, view.archive.taskId, 'ok', item.sourceSha256, view.manifest.sha256, inspected.artifact.sha256), (error) => error.code === 'TASK_ARCHIVE_CONFLICT')
  fs.writeFileSync(path.join(data.root, 'proof.txt'), 'proof v1')
  const source = JSON.parse(fs.readFileSync(data.manifest, 'utf8')); source.items[0].itemId = '__proto__'; fs.writeFileSync(data.manifest, JSON.stringify({ schemaVersion: 1, items: [source.items[0]] }))
  view = archive.bind(data.home, data.manifest); const proto = view.items[0]; const detail = archive.itemDetails(data.home, view.archive.taskId, '__proto__')
  view = archive.accept(data.home, view.archive.taskId, '__proto__', proto.sourceSha256, view.manifest.sha256, detail.artifact.sha256)
  assert.equal(view.items[0].acceptance.valid, true)
})

test('standard update is hash-guarded and old JSON is read-only', () => {
  const data = fixture(); const original = JSON.parse(fs.readFileSync(data.manifest, 'utf8')); original.items.pop(); fs.writeFileSync(data.manifest, JSON.stringify(original)); const view = bind(data); const replacement = path.join(data.root, 'replacement.json')
  fs.writeFileSync(replacement, JSON.stringify({ schemaVersion: 1, items: [original.items[0], { itemId: 'bad', status: 'failed' }] }))
  const next = archive.update(data.home, view.archive.taskId, view.manifest.sha256, replacement)
  assert.equal(next.items.length, 2)
  assert.throws(() => archive.update(data.home, view.archive.taskId, view.manifest.sha256, replacement), (error) => error.code === 'TASK_ARCHIVE_CONFLICT')
  const legacy = path.join(data.root, 'legacy.json'); fs.writeFileSync(legacy, JSON.stringify([{ id: 'a', state: 'failed' }]))
  const old = archive.bind(data.home, legacy)
  assert.throws(() => archive.update(data.home, old.archive.taskId, archive.view(data.home, old.archive.taskId).manifest.sha256, replacement), /Current manifest must use standard/)
})

test('update refuses malformed candidates and deleting a current succeeded row', () => {
  const data = fixture(); const original = JSON.parse(fs.readFileSync(data.manifest, 'utf8')); original.items.pop(); fs.writeFileSync(data.manifest, JSON.stringify(original)); const view = bind(data)
  const invalid = path.join(data.root, 'invalid.json'); fs.writeFileSync(invalid, JSON.stringify({ schemaVersion: 1, items: [{ itemId: 'bad', status: 'not-real' }] }))
  assert.throws(() => archive.update(data.home, view.archive.taskId, view.manifest.sha256, invalid), /invalid item IDs\/statuses/)
  const deletion = path.join(data.root, 'deletion.json'); fs.writeFileSync(deletion, JSON.stringify({ schemaVersion: 1, items: [original.items[1]] }))
  assert.throws(() => archive.update(data.home, view.archive.taskId, view.manifest.sha256, deletion), /Protected succeeded/)
})

test('concurrent updates using one manifest hash allow exactly one writer', async () => {
  const data = fixture(); const original = JSON.parse(fs.readFileSync(data.manifest, 'utf8')); original.items.pop(); fs.writeFileSync(data.manifest, JSON.stringify(original)); const view = bind(data); const cli = path.resolve(__dirname, '../scripts/task-archive/cli.cjs')
  const one = path.join(data.root, 'one.json'); const two = path.join(data.root, 'two.json')
  fs.writeFileSync(one, JSON.stringify({ schemaVersion: 1, items: [original.items[0], { itemId: 'one', status: 'failed' }] }))
  fs.writeFileSync(two, JSON.stringify({ schemaVersion: 1, items: [original.items[0], { itemId: 'two', status: 'failed' }] }))
  const run = (replacement) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'update', view.archive.taskId, '--expected-manifest-sha256', view.manifest.sha256, '--manifest', replacement], { env: { ...process.env, DSH_HOME: data.home }, stdio: 'ignore' })
    child.on('close', (code) => resolve(code))
  })
  const results = await Promise.all([run(one), run(two)])
  assert.equal(results.filter((code) => code === 0).length, 1)
})

test('artifact traversal and unsafe HTML are denied while a bad item does not break details', () => {
  const data = fixture(); const view = bind(data)
  assert.throws(() => archive.resolveArtifact(data.manifest, '../proof.txt'), /escapes/)
  fs.writeFileSync(path.join(data.root, 'unsafe.html'), '<script>alert(1)</script>')
  assert.throws(() => archive.resolveArtifact(data.manifest, 'unsafe.html'), /type is not allowed/)
  const detail = archive.itemDetails(data.home, view.archive.taskId, 'mystery')
  assert.equal(detail.item.status, 'unknown')
  assert.equal(detail.item.diff, undefined)
})

test('source and packaged-layout CLI compose against the same service', () => {
  const data = fixture(); const cli = path.resolve(__dirname, '../scripts/task-archive/cli.cjs')
  const env = { ...process.env, DSH_HOME: data.home }
  let result = spawnSync(process.execPath, [cli, 'bind', '--manifest', data.manifest, '--title', 'cli'], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr); const taskId = JSON.parse(result.stdout).archive.taskId
  result = spawnSync(process.execPath, [cli, 'show', taskId], { encoding: 'utf8', env }); assert.equal(result.status, 0, result.stderr)
  result = spawnSync(process.execPath, [cli, 'inspect', taskId, 'ok'], { encoding: 'utf8', env }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).artifact.name, 'proof.txt')
  const packaged = path.join(data.root, 'resources', 'tools', 'task-archive'); fs.mkdirSync(path.join(packaged, 'lib', 'task-archive'), { recursive: true })
  fs.copyFileSync(cli, path.join(packaged, 'cli.cjs'))
  fs.copyFileSync(path.resolve(__dirname, '../app/lib/task-archive/service.js'), path.join(packaged, 'lib', 'task-archive', 'service.js'))
  result = spawnSync(process.execPath, [path.join(packaged, 'cli.cjs'), 'show', taskId], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
})
