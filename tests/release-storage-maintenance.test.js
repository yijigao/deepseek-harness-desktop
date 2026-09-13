'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { discover, run, assertPlainPath } = require('../scripts/lib/release-storage-maintenance.cjs')

async function install(root, name, release = null) {
  const folder = path.join(root, name)
  await fs.mkdir(path.join(folder, 'resources', 'runtime', 'lib'), { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(folder, 'DeepSeek.exe'), ''),
    fs.writeFile(path.join(folder, 'resources', 'app.asar'), ''),
    fs.writeFile(path.join(folder, 'resources', 'node.exe'), ''),
    fs.writeFile(path.join(folder, 'resources', 'runtime', 'lib', 'bin.js'), ''),
  ])
  if (release) {
    const version = { ...release, dshCommit: 'a'.repeat(40), dshVersion: '0.1.3-alpha.2' }
    await fs.writeFile(path.join(folder, 'resources', 'version.json'), JSON.stringify(version))
    const files = {}
    for (const relative of ['DeepSeek.exe', 'resources/app.asar', 'resources/node.exe', 'resources/runtime/lib/bin.js', 'resources/version.json']) {
      files[relative] = crypto.createHash('sha256').update(await fs.readFile(path.join(folder, relative))).digest('hex')
    }
    await fs.writeFile(path.join(folder, 'desktop-release.json'), JSON.stringify({ schema: 1, releaseId: release.desktopReleaseId, engineCommit: 'a'.repeat(40), engineVersion: '0.1.3-alpha.2', patchsetSha256: 'b'.repeat(64), protocol: 1, sessionReadVersions: [2], sessionWriteVersion: 2, files }))
  }
  return folder
}

async function rewriteVersion(folder, change) {
  const versionPath = path.join(folder, 'resources', 'version.json')
  const manifestPath = path.join(folder, 'desktop-release.json')
  const version = JSON.parse(await fs.readFile(versionPath, 'utf8'))
  change(version)
  const versionBytes = JSON.stringify(version)
  await fs.writeFile(versionPath, versionBytes)
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.files['resources/version.json'] = crypto.createHash('sha256').update(versionBytes).digest('hex')
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-storage-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const programs = path.join(root, 'Programs')
  const desktop = path.join(root, 'desktop')
  await fs.mkdir(programs); await fs.mkdir(desktop)
  await install(programs, 'DeepSeek', { appVersion: '2.2.0', desktopReleaseId: 'desktop-2.2.0-alpha2-r6' })
  const backupRelease = { appVersion: '2.2.0', desktopReleaseId: 'desktop-2.2.0-alpha2-r6' }
  const old = await install(programs, 'DeepSeek.pre-update-20260909-025008', backupRelease)
  const newest = await install(programs, 'DeepSeek.pre-update-20260909-045919', backupRelease)
  // Timestamp, not mtime, defines the retained rollback.
  await fs.utimes(old, 2, 2); await fs.utimes(newest, 1, 1)
  const artifacts = path.join(desktop, 'release-artifacts')
  await Promise.all(['desktop-2.2.0-alpha2-r4', 'desktop-2.2.0-alpha2-r6', 'runtime-r5', 'runtime-r6', 'pinned-source', 'unknown-evidence'].map(name => fs.mkdir(path.join(artifacts, name), { recursive: true })))
  for (const name of ['desktop-2.2.0-alpha2-r4', 'desktop-2.2.0-alpha2-r6']) {
    await fs.mkdir(path.join(artifacts, name, 'win-unpacked'), { recursive: true })
    await fs.writeFile(path.join(artifacts, name, 'win-unpacked', 'desktop-release.json'), JSON.stringify({ releaseId: name }))
  }
  const dist = path.join(desktop, 'dist')
  await fs.mkdir(dist)
  await fs.writeFile(path.join(dist, 'DeepSeek-Setup-1.1.0.exe'), 'old')
  await fs.writeFile(path.join(dist, 'notes.txt'), 'keep')
  return { programs, desktop, old, newest, artifacts, dist }
}

test('preview is allowlisted, retains current inputs and one verified complete rollback', async t => {
  const f = await fixture(t)
  const plan = await discover({ programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  const removal = plan.items.filter(item => item.decision === 'remove').map(item => item.path)
  assert.deepEqual(removal.sort(), [f.old, path.join(f.artifacts, 'desktop-2.2.0-alpha2-r4'), path.join(f.dist, 'DeepSeek-Setup-1.1.0.exe')].sort())
  for (const name of ['desktop-2.2.0-alpha2-r6', 'runtime-r5', 'runtime-r6', 'pinned-source', 'unknown-evidence']) {
    assert.match(plan.items.find(item => item.path === path.join(f.artifacts, name)).reason, /protect:|skip:/)
  }
  assert.equal(plan.items.some(item => item.path === path.join(f.dist, 'notes.txt')), false)
})

test('execute requires confirmation and reclaims only the previewed allowlist', async t => {
  const f = await fixture(t)
  await assert.rejects(run({ mode: 'execute', programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] }), /confirmExecute/)
  const approvedPlan = await run({ mode: 'preview', programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  const addedAfterPreview = path.join(f.artifacts, 'desktop-2.2.0-alpha2-r3')
  await fs.mkdir(path.join(addedAfterPreview, 'win-unpacked'), { recursive: true })
  await fs.writeFile(path.join(addedAfterPreview, 'win-unpacked', 'desktop-release.json'), JSON.stringify({ releaseId: path.basename(addedAfterPreview) }))
  const result = await run({ mode: 'execute', confirmExecute: true, approvedPlan, auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  assert.deepEqual(result.applied.sort(), [f.old, path.join(f.artifacts, 'desktop-2.2.0-alpha2-r4'), path.join(f.dist, 'DeepSeek-Setup-1.1.0.exe')].sort())
  await assert.rejects(fs.lstat(f.old), /ENOENT/)
  await fs.lstat(f.newest)
  await fs.lstat(addedAfterPreview)
  await fs.lstat(path.join(f.artifacts, 'unknown-evidence'))
  await fs.lstat(path.join(f.dist, 'notes.txt'))
  const audit = (await fs.readFile(result.auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  assert.equal(audit.status, 'complete')
  assert.deepEqual(audit.applied.sort(), result.applied.sort())
})

test('a valid ready candidate and active matching path stay protected', async t => {
  const f = await fixture(t)
  const candidate = await install(f.programs, 'DeepSeek.candidate-20260909-050000')
  await fs.writeFile(`${candidate}.ready.json`, JSON.stringify({ schema: 1, status: 'ready', candidate, installDir: path.join(f.programs, 'DeepSeek') }))
  const plan = await discover({ programRoot: f.programs, desktopRoot: f.desktop, processPaths: [path.join(candidate, 'resources', 'node.exe')] })
  assert.equal(plan.items.find(item => item.path === candidate).decision, 'skip')
  assert.match(plan.items.find(item => item.path === candidate).reason, /active ready candidate/)
})

test('a reparse target never passes the execute-time path check', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-storage-link-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const approved = path.join(root, 'approved')
  const outside = path.join(root, 'outside')
  const link = path.join(approved, 'DeepSeek.pre-update-unsafe')
  await fs.mkdir(approved); await fs.mkdir(outside)
  try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch { t.skip('host does not permit test reparse points'); return }
  await assert.rejects(assertPlainPath(link, approved), /reparse/)
})

test('automatic mode rotates only named pre-update backups, by timestamp rather than mtime', async t => {
  const f = await fixture(t)
  const result = await run({ mode: 'auto', auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  assert.deepEqual(result.applied, [f.old])
  await fs.lstat(f.newest)
  await fs.lstat(path.join(f.artifacts, 'desktop-2.2.0-alpha2-r4'))
  await fs.lstat(path.join(f.dist, 'DeepSeek-Setup-1.1.0.exe'))
})

test('an invalid current manifest blocks every deletion', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.programs, 'DeepSeek', 'desktop-release.json'), '{}')
  const result = await run({ mode: 'execute', confirmExecute: true, approvedPlan: await run({ mode: 'preview', programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] }), auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  assert.deepEqual(result.applied, [])
  assert.match(result.blocked, /current installation manifest/)
  await fs.lstat(f.old)
})

test('future artifacts and all runtimes remain outside the allowlist', async t => {
  const f = await fixture(t)
  const future = path.join(f.artifacts, 'desktop-2.2.0-alpha2-r7')
  await fs.mkdir(path.join(future, 'win-unpacked'), { recursive: true })
  await fs.writeFile(path.join(future, 'win-unpacked', 'desktop-release.json'), JSON.stringify({ releaseId: path.basename(future) }))
  await fs.mkdir(path.join(f.artifacts, 'runtime-r7'))
  const plan = await discover({ programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  for (const target of [future, path.join(f.artifacts, 'runtime-r7')]) assert.equal(plan.items.find(item => item.path === target).decision, 'skip')
})

test('installer versions use numeric comparison and exact names only', async t => {
  const f = await fixture(t)
  await Promise.all([
    fs.writeFile(path.join(f.dist, 'DeepSeek-Setup-2.10.0.exe'), ''),
    fs.writeFile(path.join(f.dist, 'DeepSeek-Setup-2.1.0.exe.blockmap'), ''),
    fs.writeFile(path.join(f.dist, 'DeepSeek-Desktop-2.1.0-portable.exe'), ''),
    fs.writeFile(path.join(f.dist, 'DeepSeek-Desktop-2.1.0.exe'), ''),
  ])
  const plan = await discover({ programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  const removable = plan.items.filter(item => item.kind === 'dist' && item.decision === 'remove').map(item => path.basename(item.path))
  assert.deepEqual(removable.sort(), ['DeepSeek-Desktop-2.1.0-portable.exe', 'DeepSeek-Setup-1.1.0.exe', 'DeepSeek-Setup-2.1.0.exe.blockmap'].sort())
  assert.equal(plan.items.some(item => item.path.endsWith('DeepSeek-Setup-2.10.0.exe')), true)
  assert.equal(plan.items.some(item => item.path.endsWith('DeepSeek-Desktop-2.1.0.exe')), false)
})

test('process inspection failures fail closed and an existing lock prevents execution', async t => {
  const f = await fixture(t)
  await assert.rejects(run({ mode: 'execute', confirmExecute: true, programRoot: f.programs, desktopRoot: f.desktop, processInspector: async () => { throw Error('CIM denied') } }), /CIM denied/)
  await fs.lstat(f.old)
  const lock = path.join(f.desktop, '.release-storage-maintenance.lock')
  await fs.writeFile(lock, '')
  await assert.rejects(run({ mode: 'execute', confirmExecute: true, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] }), /EEXIST/)
})

test('identity changes between discovery and unlink are skipped', async t => {
  const f = await fixture(t)
  let oldChecks = 0
  const result = await run({
    mode: 'auto', auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop,
    processInspector: async folder => {
      if (folder === f.old && ++oldChecks === 2) await fs.writeFile(path.join(f.old, 'desktop-release.json'), '{}')
      return false
    },
  })
  assert.deepEqual(result.applied, [])
  assert.match(result.candidates.find(item => item.path === f.old).reason, /identity changed/)
  await fs.lstat(f.old)
})

test('cheap final fence includes current manifest and version stats changed during process inspection', async t => {
  for (const relative of ['desktop-release.json', path.join('resources', 'version.json')]) await t.test(relative, async st => {
    const f = await fixture(st)
    let oldChecks = 0
    const result = await run({
      mode: 'auto', auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop,
      processInspector: async folder => {
        if (folder === f.old && ++oldChecks === 2) await fs.writeFile(path.join(f.programs, 'DeepSeek', relative), `changed-${relative}`)
        return false
      },
    })
    assert.deepEqual(result.applied, [])
    assert.match(result.candidates.find(item => item.path === f.old).reason, /current installation changed before deletion/)
    await fs.lstat(f.old)
  })
})

test('approved preview pins the exact retained rollback set and identity', async t => {
  const f = await fixture(t)
  const approvedPlan = await run({ mode: 'preview', programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  assert.deepEqual(approvedPlan.retainedBackups.map(item => item.path), [f.newest])
  assert.ok(approvedPlan.retainedBackups[0].identity.manifest)
  const later = await install(f.programs, 'DeepSeek.pre-update-20260909-055919', { appVersion: '2.2.0', desktopReleaseId: 'desktop-2.2.0-alpha2-r6' })
  await assert.rejects(run({ mode: 'execute', confirmExecute: true, approvedPlan, auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] }), /retained rollback set/)
  await Promise.all([f.old, f.newest, later].map(file => fs.lstat(file)))
})

test('append-only audit preserves prior durable records and stops before the next deletion', async t => {
  const f = await fixture(t)
  const middle = await install(f.programs, 'DeepSeek.pre-update-20260909-035008', { appVersion: '2.2.0', desktopReleaseId: 'desktop-2.2.0-alpha2-r6' })
  const newer = await install(f.programs, 'DeepSeek.pre-update-20260909-040008', { appVersion: '2.2.0', desktopReleaseId: 'desktop-2.2.0-alpha2-r6' })
  const auditPath = path.join(f.desktop, 'append-only-audit.jsonl')
  await assert.rejects(run({
    mode: 'auto', auditPath, auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [],
    auditWriteHook: sequence => { if (sequence === 3) throw Error('injected durable audit failure') },
  }), /injected durable audit failure/)
  const records = (await fs.readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.length, 2)
  assert.equal(records[0].status, 'intent')
  assert.deepEqual(records[1].applied, [f.old])
  await assert.rejects(fs.lstat(f.old), /ENOENT/)
  await assert.rejects(fs.lstat(middle), /ENOENT/)
  await fs.lstat(newer)
})

test('audit failure while persisting a skipped first candidate stops all later deletion', async t => {
  const f = await fixture(t)
  const middle = await install(f.programs, 'DeepSeek.pre-update-20260909-035008', { appVersion: '2.2.0', desktopReleaseId: 'desktop-2.2.0-alpha2-r6' })
  let oldChecks = 0
  await assert.rejects(run({
    mode: 'auto', auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop,
    processInspector: async folder => {
      if (folder === f.old && ++oldChecks === 2) await fs.writeFile(path.join(f.old, 'desktop-release.json'), '{}')
      return false
    },
    auditWriteHook: sequence => { if (sequence === 2) throw Error('injected skipped-item audit failure') },
  }), /injected skipped-item audit failure/)
  await fs.lstat(f.old)
  await fs.lstat(middle)
})

test('current install blocks cleanup when release ids disagree or desktopReleaseId is missing', async t => {
  for (const scenario of ['mismatch', 'missing']) await t.test(scenario, async st => {
    const f = await fixture(st)
    await rewriteVersion(path.join(f.programs, 'DeepSeek'), version => {
      if (scenario === 'mismatch') version.desktopReleaseId = 'desktop-2.2.0-alpha2-r5'
      else delete version.desktopReleaseId
    })
    const result = await run({ mode: 'preview', programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
    assert.match(result.blocked, /current installation manifest/)
    assert.equal(result.candidates.some(item => item.decision === 'remove'), false)
  })
})

test('invalid pre-update timestamps do not poison valid rollback revalidation', async t => {
  const f = await fixture(t)
  await install(f.programs, 'DeepSeek.pre-update-20261399-256199', { appVersion: '2.2.0', desktopReleaseId: 'desktop-2.2.0-alpha2-r6' })
  const result = await run({ mode: 'auto', auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] })
  assert.deepEqual(result.applied, [f.old])
})

test('artifact final fence includes its packaged manifest stat', async t => {
  const f = await fixture(t)
  const artifact = path.join(f.artifacts, 'desktop-2.2.0-alpha2-r4')
  const manifest = path.join(artifact, 'win-unpacked', 'desktop-release.json')
  const result = await run({
    mode: 'execute', confirmExecute: true,
    approvedPlan: await run({ mode: 'preview', programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] }),
    auditRoot: f.desktop, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [],
    beforeFinalFence: async item => { if (item.path === artifact) await fs.writeFile(manifest, '{"releaseId":"changed-after-revalidation"}') },
  })
  assert.equal(result.applied.includes(artifact), false)
  assert.match(result.candidates.find(item => item.path === artifact).reason, /target changed before deletion/)
  await fs.lstat(artifact)
})

test('an audit write failure prevents automatic deletion', async t => {
  const f = await fixture(t)
  const blockedAuditRoot = path.join(f.desktop, 'audit-file')
  await fs.writeFile(blockedAuditRoot, '')
  await assert.rejects(run({ mode: 'auto', auditRoot: blockedAuditRoot, programRoot: f.programs, desktopRoot: f.desktop, processPaths: [] }))
  await fs.lstat(f.old)
})
