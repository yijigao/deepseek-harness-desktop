'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const recovery = require('../scripts/lib/install-workspace-recovery.cjs')

const POLICY = Object.freeze({
  staticFileCount: 6,
  extraCounts: Object.freeze({ 'root-business': 69, 'wecom-data': 5, 'runtime-backup': 2 }),
})
const HEADER = 'resources/runtime/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

async function write(root, relPath, bytes) {
  const file = path.join(root, ...relPath.split('/'))
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, bytes)
  return file
}

async function fixture(t) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'install-recovery-'))
  t.after(() => fsp.rm(temp, { recursive: true, force: true }))
  const installRoot = path.join(temp, 'install')
  const workspaceRoot = path.join(temp, 'workspace')
  const backupRoot = path.join(temp, 'backup')
  await Promise.all([fsp.mkdir(installRoot), fsp.mkdir(workspaceRoot), fsp.mkdir(backupRoot)])

  const originalVersion = {
    dshVersion: '1.0.0-test',
    dshCommit: '0123456789abcdef0123456789abcdef01234567',
    desktopReleaseId: 'desktop-test-r7',
    keep: { nested: true },
  }
  const versionBytes = Buffer.from(JSON.stringify(originalVersion, null, 2) + '\n')
  const staticBytes = {
    'DeepSeek.exe': Buffer.from('exe'),
    'resources/app.asar': Buffer.from('asar'),
    'resources/node.exe': Buffer.from('node'),
    'resources/runtime/lib/bin.js': Buffer.from('bin'),
    'resources/version.json': versionBytes,
    [HEADER]: Buffer.from('trusted header\n'),
  }
  for (const [relPath, bytes] of Object.entries(staticBytes)) await write(installRoot, relPath, bytes)
  const liveHeader = Buffer.from('approved local header\n')
  await write(installRoot, HEADER, liveHeader)

  const manifest = {
    schema: 1,
    releaseId: 'desktop-test-r7',
    engineCommit: originalVersion.dshCommit,
    engineVersion: originalVersion.dshVersion,
    patchsetSha256: digest(Buffer.from('r7 patchset')),
    protocol: 1,
    sessionWriteVersion: 1,
    sessionReadVersions: [1],
    files: Object.fromEntries(Object.entries(staticBytes).map(([name, bytes]) => [name, digest(bytes)])),
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const manifestPath = await write(installRoot, recovery.MANIFEST_REL, manifestBytes)

  const extras = []
  const addExtra = async (relPath, category, targetPath, bytes) => {
    await write(installRoot, relPath, bytes)
    extras.push({ relPath, category, targetPath, size: bytes.length, sha256: digest(bytes) })
  }
  const binaryCredential = Buffer.from([0, 255, 1, 2, 128, 10, 13, 42])
  await addExtra('.dsh/wecom-cli/.encryption_key', 'wecom-data', path.join(workspaceRoot, '.dsh', 'wecom-cli', '.encryption_key'), Buffer.from('key-pair'))
  await addExtra('.dsh/wecom-cli/credentials.enc', 'wecom-data', path.join(workspaceRoot, '.dsh', 'wecom-cli', 'credentials.enc'), binaryCredential)
  for (const name of ['catalog.json', 'service_identity.json', 'service_smartsheet.json']) {
    await addExtra(`.dsh/wecom-cli/cache/${name}`, 'wecom-data', path.join(workspaceRoot, '.dsh', 'wecom-cli', 'cache', name), Buffer.from(name))
  }
  for (let index = 0; index < 69; index += 1) {
    const relPath = `business/file-${String(index).padStart(2, '0')}.dat`
    await addExtra(relPath, 'root-business', path.join(workspaceRoot, relPath), Buffer.from(`business-${index}`))
  }
  for (let index = 0; index < 2; index += 1) {
    const relPath = `runtime-backup/file-${index}.dat`
    await addExtra(relPath, 'runtime-backup', path.join(backupRoot, 'maintenance', `file-${index}.dat`), Buffer.from(`runtime-${index}`))
  }

  const spec = {
    installRoot,
    workspaceRoot,
    backupRoot,
    trustedManifestPath: manifestPath,
    trustedManifestSha256: digest(manifestBytes),
    expectedStaticFileCount: 6,
    allowedChangedFile: { relPath: HEADER, expectedSha256: digest(staticBytes[HEADER]), currentSha256: digest(liveHeader) },
    extras,
    adopted: { releaseId: 'desktop-test-r7-adopted-header', patchsetSha256: digest(Buffer.from('adopted patchset')) },
  }
  const bundle = await recovery.buildPlan(spec, { policy: POLICY })
  return { temp, installRoot, workspaceRoot, backupRoot, originalVersion, manifest, manifestBytes, liveHeader, binaryCredential, spec, ...bundle }
}

const synthetic = { allowSyntheticPolicy: true }
const noProcesses = async () => []
const rename = (source, target) => fsp.rename(source, target)

test('moves the exact 69/5/2 set, preserves opaque credentials, adopts and fully verifies', async t => {
  const state = await fixture(t)
  const snap = await recovery.snapshot(state.plan, state.planSha256, synthetic)
  assert.equal(snap.entryCount, 79)
  const aclCalls = []
  const result = await recovery.execute(state.plan, state.planSha256, {
    ...synthetic,
    processProvider: noProcesses,
    renameFile: rename,
    aclProtector: async root => { aclCalls.push(path.resolve(root)) },
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.movedCount, 76)
  assert.deepEqual(Object.fromEntries(Object.entries(POLICY.extraCounts).map(([category]) => [category, state.plan.extras.filter(entry => entry.category === category).length])), POLICY.extraCounts)
  assert.deepEqual(await fsp.readFile(path.join(state.workspaceRoot, '.dsh', 'wecom-cli', 'credentials.enc')), state.binaryCredential)
  assert.equal(aclCalls.length, 6)
  assert.equal(aclCalls.filter(root => root === path.resolve(path.join(state.workspaceRoot, '.dsh', 'wecom-cli'))).length, 1)

  const adoptedVersion = JSON.parse(await fsp.readFile(path.join(state.installRoot, recovery.VERSION_REL), 'utf8'))
  assert.equal(adoptedVersion.desktopReleaseId, state.plan.adopted.releaseId)
  const withoutRelease = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'desktopReleaseId'))
  assert.deepEqual(withoutRelease(adoptedVersion), withoutRelease(state.originalVersion))
  assert.deepEqual(await fsp.readFile(path.join(state.backupRoot, 'snapshot', 'install', recovery.MANIFEST_REL)), state.manifestBytes)
  assert.deepEqual(await fsp.readFile(path.join(state.backupRoot, 'snapshot', 'install', HEADER)), state.liveHeader)
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(state.backupRoot, 'snapshot', 'install', recovery.VERSION_REL), 'utf8')), state.originalVersion)
})

test('rejects plan digest mismatch, exact-set drift, source drift and target conflicts', async t => {
  const state = await fixture(t)
  await assert.rejects(recovery.snapshot(state.plan, '0'.repeat(64), synthetic), /plan digest mismatch/)
  await assert.rejects(recovery.buildPlan({ ...state.spec, extras: state.spec.extras.slice(1) }, { policy: POLICY }), /exactly 76/)

  const extra = state.plan.extras[0]
  await fsp.appendFile(path.join(state.installRoot, ...extra.relPath.split('/')), 'drift')
  await assert.rejects(recovery.snapshot(state.plan, state.planSha256, synthetic), /source hash drifted/)

  const other = await fixture(t)
  await write(path.dirname(other.spec.extras[0].targetPath), path.basename(other.spec.extras[0].targetPath), Buffer.from('occupied'))
  await assert.rejects(recovery.buildPlan(other.spec, { policy: POLICY }), /target already exists/)
})

test('damaged snapshot and busy writers block before any move', async t => {
  const damaged = await fixture(t)
  await recovery.snapshot(damaged.plan, damaged.planSha256, synthetic)
  await fsp.writeFile(path.join(damaged.backupRoot, 'snapshot', 'install', HEADER), 'damaged')
  await assert.rejects(recovery.execute(damaged.plan, damaged.planSha256, { ...synthetic, processProvider: noProcesses, renameFile: rename, aclProtector: async () => {} }), /snapshot is damaged/)
  assert.equal(await fsp.readFile(path.join(damaged.installRoot, ...damaged.plan.extras[0].relPath.split('/')), 'utf8').then(() => true), true)

  const busy = await fixture(t)
  await recovery.snapshot(busy.plan, busy.planSha256, synthetic)
  const processProvider = async () => [{ ProcessId: 9876, Name: 'node.exe', ExecutablePath: 'C:\\node.exe', CommandLine: `node ${busy.installRoot}\\writer.js` }]
  await assert.rejects(recovery.execute(busy.plan, busy.planSha256, { ...synthetic, processProvider, renameFile: rename, aclProtector: async () => {} }), error => error.code === 'INSTALL_RECOVERY_BUSY' && error.blockers[0].pid === 9876)
  assert.equal(await fsp.readFile(path.join(busy.installRoot, ...busy.plan.extras[0].relPath.split('/')), 'utf8').then(() => true), true)
})

test('manifest drift is rejected before ACL or business mutation', async t => {
  const state = await fixture(t)
  await recovery.snapshot(state.plan, state.planSha256, synthetic)
  await fsp.appendFile(path.join(state.installRoot, recovery.MANIFEST_REL), ' ')
  let aclCalls = 0
  let moves = 0
  await assert.rejects(recovery.execute(state.plan, state.planSha256, {
    ...synthetic,
    processProvider: noProcesses,
    renameFile: async (...args) => { moves += 1; return rename(...args) },
    aclProtector: async () => { aclCalls += 1 },
  }), /manifest drifted/)
  assert.equal(aclCalls, 0)
  assert.equal(moves, 0)
})

test('partial move failure preserves state and journal, then resumes without re-moving completed leaves', async t => {
  const state = await fixture(t)
  await recovery.snapshot(state.plan, state.planSha256, synthetic)
  let attempts = 0
  await assert.rejects(recovery.execute(state.plan, state.planSha256, {
    ...synthetic,
    processProvider: noProcesses,
    aclProtector: async () => {},
    renameFile: async (source, target) => {
      attempts += 1
      if (attempts === 4) throw Object.assign(new Error('injected'), { code: 'INJECTED' })
      await fsp.rename(source, target)
    },
  }), /preserve source, target, snapshot and journal/)
  assert.equal(attempts, 4)
  const completedBeforeResume = state.plan.extras.filter(entry => !fs.existsSync(path.join(state.installRoot, ...entry.relPath.split('/'))))
  const journalBefore = await fsp.readFile(path.join(state.backupRoot, 'operation-journal.jsonl'), 'utf8')
  assert.match(journalBefore, /"event":"move-complete"/)
  assert.match(journalBefore, /"event":"move-failed"/)

  let resumedMoves = 0
  const result = await recovery.execute(state.plan, state.planSha256, {
    ...synthetic,
    processProvider: noProcesses,
    aclProtector: async () => {},
    renameFile: async (source, target) => { resumedMoves += 1; await fsp.rename(source, target) },
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(resumedMoves, 73)
  assert.ok(completedBeforeResume.length >= 3)
})

test('ACL failure blocks before a file move, and a writer appearing later blocks adoption', async t => {
  const acl = await fixture(t)
  await recovery.snapshot(acl.plan, acl.planSha256, synthetic)
  let moves = 0
  await assert.rejects(recovery.execute(acl.plan, acl.planSha256, {
    ...synthetic,
    processProvider: noProcesses,
    renameFile: async (...args) => { moves += 1; return rename(...args) },
    aclProtector: async () => { throw new Error('ACL denied') },
  }), /ACL denied/)
  assert.equal(moves, 0)

  const writer = await fixture(t)
  await recovery.snapshot(writer.plan, writer.planSha256, synthetic)
  let calls = 0
  const processProvider = async () => {
    calls += 1
    return calls === 1 ? [] : [{ ProcessId: 1234, Name: 'DeepSeek.exe', ExecutablePath: path.join(writer.installRoot, 'DeepSeek.exe'), CommandLine: '' }]
  }
  await assert.rejects(recovery.execute(writer.plan, writer.planSha256, { ...synthetic, processProvider, renameFile: rename, aclProtector: async () => {} }), error => error.code === 'INSTALL_RECOVERY_BUSY')
  assert.deepEqual(await fsp.readFile(path.join(writer.installRoot, recovery.MANIFEST_REL)), writer.manifestBytes)
  assert.equal(JSON.parse(await fsp.readFile(path.join(writer.installRoot, recovery.VERSION_REL), 'utf8')).desktopReleaseId, writer.originalVersion.desktopReleaseId)
})

test('a raced-in target directory is never treated as a move destination', async t => {
  const state = await fixture(t)
  await recovery.snapshot(state.plan, state.planSha256, synthetic)
  const first = state.plan.extras[0]
  const source = path.join(state.installRoot, ...first.relPath.split('/'))
  await assert.rejects(recovery.execute(state.plan, state.planSha256, {
    ...synthetic,
    processProvider: noProcesses,
    aclProtector: async () => {},
    renameFile: async (_source, target) => {
      await fsp.mkdir(target)
      throw Object.assign(new Error('target raced in'), { code: 'EEXIST' })
    },
  }), /preserve source, target, snapshot and journal/)
  assert.equal((await fsp.lstat(source)).isFile(), true)
  assert.deepEqual(await fsp.readdir(first.targetPath), [])
})

test('resume reapplies ACL to a moved WeCom leaf after an injected ACL failure', async t => {
  const state = await fixture(t)
  await recovery.snapshot(state.plan, state.planSha256, synthetic)
  let aclCalls = 0
  await assert.rejects(recovery.execute(state.plan, state.planSha256, {
    ...synthetic,
    processProvider: noProcesses,
    renameFile: rename,
    aclProtector: async () => {
      aclCalls += 1
      if (aclCalls === 2) throw Object.assign(new Error('ACL injection'), { code: 'ACL_INJECTED' })
    },
  }), /preserve source, target, snapshot and journal/)
  const movedWecom = state.plan.extras.find(entry => entry.category === 'wecom-data' && !fs.existsSync(path.join(state.installRoot, ...entry.relPath.split('/'))))
  assert.ok(movedWecom)
  const resumedAclTargets = []
  const result = await recovery.execute(state.plan, state.planSha256, {
    ...synthetic,
    processProvider: noProcesses,
    renameFile: rename,
    aclProtector: async target => { resumedAclTargets.push(path.resolve(target)) },
  })
  assert.equal(result.status, 'succeeded')
  assert.ok(resumedAclTargets.includes(path.resolve(movedWecom.targetPath)))
})

test('rejects overlapping roots, targets under install, and snapshot reparse components', async t => {
  const overlap = await fixture(t)
  await assert.rejects(recovery.buildPlan({ ...overlap.spec, workspaceRoot: path.join(overlap.installRoot, 'workspace') }, { policy: POLICY }), /must not overlap/)

  const target = await fixture(t)
  const changedExtras = target.spec.extras.map((entry, index) => index === 0 ? { ...entry, targetPath: path.join(target.installRoot, 'new-name') } : entry)
  await assert.rejects(recovery.buildPlan({ ...target.spec, extras: changedExtras }, { policy: POLICY }), /outside its approved root|outside the installation/)

  const linked = await fixture(t)
  const outside = path.join(linked.temp, 'outside')
  await fsp.mkdir(outside)
  await fsp.mkdir(path.join(linked.backupRoot, 'snapshot'))
  const link = path.join(linked.backupRoot, 'snapshot', 'install')
  try {
    await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('junction creation is unavailable')
    throw error
  }
  await assert.rejects(recovery.snapshot(linked.plan, linked.planSha256, synthetic), /Reparse\/symlink/)
  assert.deepEqual(await fsp.readdir(outside), [])
})
