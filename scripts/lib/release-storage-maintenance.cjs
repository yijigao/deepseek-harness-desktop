'use strict'

/** Safe, allowlisted release-output cleanup. It never discovers user state. */
const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { verifyPackage } = require('../../app/lib/release-package.js')
const execFileAsync = promisify(execFile)

const PRE_UPDATE = /^DeepSeek\.pre-update-([0-9]{8})-([0-9]{6})$/
const LEGACY = /^(?:DeepSeek\.pre-alpha4-[A-Za-z0-9-]+|DeepSeek\.failed-copy-[A-Za-z0-9-]+|DeepSeek-v1\.1\.0-backup-[A-Za-z0-9-]+)$/
const ARTIFACT = /^desktop-[0-9]+\.[0-9]+\.[0-9]+-alpha[0-9]+-r[0-9]+$/
const RUNTIME = /^runtime-r[0-9]+$/
const PROTECTED_ARTIFACTS = new Set(['pinned-source', 'runtime-r5', 'runtime-r6'])
const REQUIRED = ['DeepSeek.exe', path.join('resources', 'app.asar'), path.join('resources', 'runtime', 'lib', 'bin.js')]

function absolute(value, name) {
  if (!path.isAbsolute(value)) throw Error(`${name} must be an absolute path`)
  return path.resolve(value)
}
function isChild(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
async function lstatOrNull(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function reparse(stat) { return stat.isSymbolicLink() }
function statIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, size: stat.size, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other' }
}
async function pathIdentity(file) { const stat = await lstatOrNull(file); return stat && !reparse(stat) ? statIdentity(stat) : null }
function sameIdentity(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
async function fileHash(file) { return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') }
async function assertPlainDirectory(root) {
  for (let cursor = path.resolve(root); ; cursor = path.dirname(cursor)) {
    const stat = await lstatOrNull(cursor)
    if (!stat || !stat.isDirectory() || reparse(stat)) throw Error(`reparse point or missing directory ancestor: ${cursor}`)
    if (cursor === path.parse(cursor).root) return
  }
}
async function assertPlainPath(file, root) {
  if (!isChild(file, root)) throw Error(`target is outside approved root: ${file}`)
  await assertPlainDirectory(root)
  let cursor = root
  for (;;) {
    const next = path.relative(cursor, file).split(path.sep)[0]
    cursor = path.join(cursor, next)
    const stat = await lstatOrNull(cursor)
    if (!stat) throw Error(`target disappeared: ${file}`)
    if (reparse(stat)) throw Error(`refusing reparse point in target path: ${cursor}`)
    if (cursor === file) return stat
  }
}
async function installMetadata(folder) {
  try {
    const manifest = await verifyPackage(folder, await fileHash(path.join(folder, 'desktop-release.json')))
    const version = await readJson(path.join(folder, 'resources', 'version.json'))
    if (!ARTIFACT.test(manifest.releaseId) || version?.desktopReleaseId !== manifest.releaseId || compareVersion(version?.appVersion, version?.appVersion) !== 0) return null
    return { releaseId: manifest.releaseId, appVersion: version.appVersion }
  } catch { return null }
}
async function fullInstall(folder) { return Boolean(await installMetadata(folder)) }
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null } }
async function currentRelease(installRoot) {
  return (await installMetadata(installRoot))?.releaseId ?? null
}
async function hasReadyReceipt(folder, installRoot) {
  const receipt = await readJson(`${folder}.ready.json`)
  return receipt?.schema === 1 && receipt.status === 'ready'
    && typeof receipt.candidate === 'string' && path.resolve(receipt.candidate) === folder
    && typeof receipt.installDir === 'string' && path.resolve(receipt.installDir) === installRoot
}
async function activeUnder(folder, options = {}) {
  if (typeof options.processInspector === 'function') return Boolean(await options.processInspector(folder))
  if (options.processPaths !== undefined) return options.processPaths.some(item => path.resolve(item).startsWith(folder + path.sep))
  if (process.platform !== 'win32') return false
  // CommandLine is examined only inside PowerShell; this process prints a boolean.
  const script = "$root=$env:DSH_MAINTENANCE_ROOT; try { $p=Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0) }; if($p){'1'}else{'0'} } catch { exit 2 }"
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, DSH_MAINTENANCE_ROOT: folder }, windowsHide: true })
  if (!['0', '1'].includes(stdout.trim())) throw Error('process inspection returned no usable result')
  return stdout.trim() === '1'
}
function candidate(file, kind, root, reason) { return { path: file, kind, root, reason, decision: 'skip' } }
async function installIdentity(folder, extra = {}) {
  const manifestPath = path.join(folder, 'desktop-release.json')
  const versionPath = path.join(folder, 'resources', 'version.json')
  return {
    ...extra,
    target: await pathIdentity(folder),
    manifest: await pathIdentity(manifestPath),
    version: await pathIdentity(versionPath),
    manifestHash: await fileHash(manifestPath),
    versionHash: await fileHash(versionPath),
    required: await Promise.all(REQUIRED.map(relative => pathIdentity(path.join(folder, relative)))),
  }
}
function compareVersion(left, right) {
  const a = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(left || '')
  const b = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(right || '')
  if (!a || !b) return null
  for (let index = 1; index <= 3; index++) if (+a[index] !== +b[index]) return +a[index] - +b[index]
  return 0
}
function compareRelease(left, right) {
  const a = /^desktop-([0-9]+)\.([0-9]+)\.([0-9]+)-alpha([0-9]+)-r([0-9]+)$/.exec(left || '')
  const b = /^desktop-([0-9]+)\.([0-9]+)\.([0-9]+)-alpha([0-9]+)-r([0-9]+)$/.exec(right || '')
  if (!a || !b) return null
  for (let index = 1; index <= 5; index++) if (+a[index] !== +b[index]) return +a[index] - +b[index]
  return 0
}
function backupStamp(name) {
  const match = PRE_UPDATE.exec(name)
  if (!match) return null
  const [year, month, day] = [match[1].slice(0, 4), match[1].slice(4, 6), match[1].slice(6, 8)].map(Number)
  const [hour, minute, second] = [match[2].slice(0, 2), match[2].slice(2, 4), match[2].slice(4, 6)].map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? `${match[1]}${match[2]}` : null
}
async function listDirectories(root) {
  await assertPlainDirectory(root)
  return (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink())
}
async function discover(options) {
  const programRoot = absolute(options.programRoot, 'programRoot')
  const desktopRoot = absolute(options.desktopRoot, 'desktopRoot')
  await Promise.all([assertPlainDirectory(programRoot), assertPlainDirectory(desktopRoot)])
  const installRoot = path.join(programRoot, 'DeepSeek')
  const artifactRoot = path.join(desktopRoot, 'release-artifacts')
  const distRoot = path.join(desktopRoot, 'dist')
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir())
  const keepBackups = options.keepBackups ?? 1
  if (!Number.isInteger(keepBackups) || keepBackups < 1 || keepBackups > 5) throw Error('keepBackups must be between 1 and 5')
  if (options.includeTestTemps) throw Error('test temporary cleanup is disabled')
  const protectedPaths = new Set([installRoot, path.join(artifactRoot, 'pinned-source'), path.join(artifactRoot, 'runtime-r5'), path.join(artifactRoot, 'runtime-r6')])
  const items = []
  for (const entry of await listDirectories(programRoot)) {
    const target = path.join(programRoot, entry.name)
    if (entry.isSymbolicLink()) { items.push(candidate(target, 'install', programRoot, 'skip: reparse point')); continue }
    if (LEGACY.test(entry.name)) {
      if (await fullInstall(target)) {
        const item = candidate(target, 'install', programRoot, 'verified legacy rollback (manual only)')
        item.identity = await installIdentity(target, { name: entry.name })
        if (await activeUnder(target, options)) item.reason = 'protect: active verified legacy rollback'
        else item.decision = 'remove'
        items.push(item)
      } else items.push(candidate(target, 'install', programRoot, 'skip: unverified legacy installation'))
    } else if (PRE_UPDATE.test(entry.name) && !backupStamp(entry.name)) {
      items.push(candidate(target, 'install', programRoot, 'skip: invalid rollback timestamp'))
    } else if (/^DeepSeek\.(candidate|failed-update)-/.test(entry.name)) {
      const ready = await hasReadyReceipt(target, installRoot)
      const active = await activeUnder(target, options)
      items.push(candidate(target, 'candidate', programRoot, ready ? (active ? 'protect: active ready candidate' : 'protect: valid ready receipt') : 'skip: no valid ready receipt'))
    }
  }
  const backups = []
  for (const entry of await listDirectories(programRoot)) {
    if (entry.isSymbolicLink() || !PRE_UPDATE.test(entry.name)) continue
    const target = path.join(programRoot, entry.name)
    const stamp = backupStamp(entry.name)
    if (stamp && await fullInstall(target)) backups.push({ target, stat: await fs.stat(target), name: entry.name, stamp })
  }
  backups.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)))
  for (let index = 0; index < backups.length; index++) {
    const item = candidate(backups[index].target, 'install', programRoot, index < keepBackups ? 'protect: retained verified rollback' : 'verified expired rollback')
    item.identity = await installIdentity(backups[index].target, { name: backups[index].name, stamp: backups[index].stamp })
    if (index >= keepBackups) {
      if (await activeUnder(item.path, options)) item.reason = 'protect: active verified rollback'
      else item.decision = 'remove'
    }
    items.push(item)
  }
  const retainedBackups = items.filter(item => item.kind === 'install' && item.reason === 'protect: retained verified rollback').map(item => ({ path: item.path, identity: item.identity }))
  const installedRelease = await currentRelease(installRoot)
  if (installedRelease === null) {
    for (const item of items) if (item.decision === 'remove') { item.decision = 'skip'; item.reason = 'skip: current installation manifest is missing, incomplete, or inconsistent' }
    return { programRoot, desktopRoot, installRoot, artifactRoot, distRoot, tempRoot, currentIdentity: null, retainedBackups, protectedPaths: [...protectedPaths], items, blocked: 'current installation manifest is missing, incomplete, or inconsistent' }
  }
  const currentIdentity = await installIdentity(installRoot)
  if (items.some(item => item.kind === 'install' && LEGACY.test(path.basename(item.path)) && item.decision === 'remove') && backups.length < keepBackups) {
    for (const item of items) if (item.kind === 'install' && LEGACY.test(path.basename(item.path)) && item.decision === 'remove') {
      item.decision = 'skip'
      item.reason = 'skip: no retained verified pre-update rollback'
    }
  }
  for (const entry of await listDirectories(artifactRoot)) {
    const target = path.join(artifactRoot, entry.name)
    if (entry.isSymbolicLink()) { items.push(candidate(target, 'artifact', artifactRoot, 'skip: reparse point')); continue }
    if (RUNTIME.test(entry.name) || PROTECTED_ARTIFACTS.has(entry.name) || entry.name === installedRelease) { items.push(candidate(target, 'artifact', artifactRoot, 'protect: current build input')); continue }
    const packaged = await readJson(path.join(target, 'win-unpacked', 'desktop-release.json'))
    if (ARTIFACT.test(entry.name) && packaged?.releaseId === entry.name && compareRelease(entry.name, installedRelease) < 0) {
      const manifestPath = path.join(target, 'win-unpacked', 'desktop-release.json')
      const item = candidate(target, 'artifact', artifactRoot, 'verified obsolete artifact'); item.identity = { releaseId: packaged.releaseId, target: await pathIdentity(target), manifest: await pathIdentity(manifestPath), manifestHash: await fileHash(manifestPath) }
      if (await activeUnder(target, options)) item.reason = 'protect: active verified artifact'
      else item.decision = 'remove'
      items.push(item)
    } else items.push(candidate(target, 'artifact', artifactRoot, 'skip: unknown or future artifact identity'))
  }
  // Dist is deliberately conservative: only versioned installers older than the installed app are removable.
  const installedVersion = (await readJson(path.join(installRoot, 'resources', 'version.json')))?.appVersion
  const dist = await lstatOrNull(distRoot)
  if (dist?.isDirectory() && !reparse(dist)) for (const entry of await fs.readdir(distRoot, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const match = /^(?:DeepSeek-Setup-([0-9]+\.[0-9]+\.[0-9]+)\.exe(?:\.blockmap)?|DeepSeek-Desktop-([0-9]+\.[0-9]+\.[0-9]+)-portable\.exe)$/.exec(entry.name)
    const version = match?.[1] || match?.[2]
    const target = path.join(distRoot, entry.name)
    if (version && compareVersion(version, installedVersion) < 0) { const item = candidate(target, 'dist', distRoot, 'verified older installer (manual only)'); item.decision = 'remove'; item.identity = { name: entry.name, version, target: await pathIdentity(target) }; items.push(item) }
    else if (match) items.push(candidate(target, 'dist', distRoot, 'protect: current or unverified installer'))
  }
  return { programRoot, desktopRoot, installRoot, artifactRoot, distRoot, tempRoot, currentIdentity, retainedBackups, protectedPaths: [...protectedPaths], items: items.sort((a, b) => a.path.localeCompare(b.path)) }
}
async function unlinkTree(target) {
  const stat = await fs.lstat(target)
  if (reparse(stat) || stat.isFile()) { await fs.unlink(target); return }
  for (const entry of await fs.readdir(target, { withFileTypes: true })) await unlinkTree(path.join(target, entry.name))
  await fs.rmdir(target)
}
async function diskFree(root) { const stat = await fs.statfs(root); return stat.bavail * stat.bsize }
function refreshAudit(audit) {
  audit.protected = audit.candidates.filter(item => item.reason.startsWith('protect:'))
  audit.skipped = audit.candidates.filter(item => item.reason.startsWith('skip:'))
}
async function createAuditWriter(plan, audit, requestedPath, requestedRoot, writeHook) {
  const auditRoot = path.resolve(requestedRoot || path.join(process.env.LOCALAPPDATA || plan.desktopRoot, 'DeepSeekMaintenance'))
  const auditPath = path.resolve(requestedPath || path.join(auditRoot, `maintenance-${Date.now()}-${process.pid}.jsonl`))
  if (!isChild(auditPath, auditRoot)) throw Error('audit path must be below the maintenance audit root')
  await fs.mkdir(path.dirname(auditPath), { recursive: true })
  await assertPlainDirectory(path.dirname(auditPath))
  audit.auditPath = auditPath
  const handle = await fs.open(auditPath, 'ax')
  let sequence = 0
  const persist = async () => {
    refreshAudit(audit)
    sequence++
    if (typeof writeHook === 'function') await writeHook(sequence, auditPath)
    await handle.appendFile(`${JSON.stringify(audit)}\n`)
    await handle.sync()
  }
  persist.close = () => handle.close()
  return persist
}
function approvedItem(item, approved) {
  return approved?.candidates?.some(candidate => candidate.decision === 'remove' && candidate.path === item.path && JSON.stringify(candidate.identity) === JSON.stringify(item.identity))
}
async function matchesInstallIdentity(folder, identity) {
  if (!identity || !sameIdentity(await pathIdentity(folder), identity.target)) return false
  if (!sameIdentity(await pathIdentity(path.join(folder, 'desktop-release.json')), identity.manifest)) return false
  if (!sameIdentity(await pathIdentity(path.join(folder, 'resources', 'version.json')), identity.version)) return false
  if (await fileHash(path.join(folder, 'desktop-release.json')) !== identity.manifestHash) return false
  if (await fileHash(path.join(folder, 'resources', 'version.json')) !== identity.versionHash) return false
  const required = await Promise.all(REQUIRED.map(relative => pathIdentity(path.join(folder, relative))))
  return sameIdentity(required, identity.required)
}
async function fastInstallFence(folder, identity) {
  if (!identity || !sameIdentity(await pathIdentity(folder), identity.target)) return false
  if (!sameIdentity(await pathIdentity(path.join(folder, 'desktop-release.json')), identity.manifest)) return false
  if (!sameIdentity(await pathIdentity(path.join(folder, 'resources', 'version.json')), identity.version)) return false
  return sameIdentity(await Promise.all(REQUIRED.map(relative => pathIdentity(path.join(folder, relative)))), identity.required)
}
async function finalFence(item, plan) {
  if (!await fastInstallFence(plan.installRoot, plan.currentIdentity)) return 'current installation changed before deletion'
  for (const retained of plan.retainedBackups || []) if (!await fastInstallFence(retained.path, retained.identity)) return 'retained rollback changed before deletion'
  if (item.kind === 'install' && !await fastInstallFence(item.path, item.identity)) return 'installation changed before deletion'
  if (item.kind === 'artifact' && (!sameIdentity(await pathIdentity(item.path), item.identity?.target) || !sameIdentity(await pathIdentity(path.join(item.path, 'win-unpacked', 'desktop-release.json')), item.identity?.manifest))) return 'target changed before deletion'
  if (item.kind === 'dist' && !sameIdentity(await pathIdentity(item.path), item.identity?.target)) return 'target changed before deletion'
  return null
}
async function revalidateRemoval(item, plan, options) {
  if (!await matchesInstallIdentity(plan.installRoot, plan.currentIdentity)) return 'current installation identity changed'
  if (await activeUnder(item.path, options)) return 'active process'
  if (item.kind === 'install') {
    const name = path.basename(item.path)
    if (item.identity?.name !== name || !await matchesInstallIdentity(item.path, item.identity)) return 'installation identity changed'
    if (PRE_UPDATE.test(name)) {
      const backups = []
      for (const entry of await listDirectories(plan.programRoot)) {
        if (entry.isSymbolicLink() || !PRE_UPDATE.test(entry.name) || !backupStamp(entry.name)) continue
        const target = path.join(plan.programRoot, entry.name)
        if (await fullInstall(target)) backups.push({ target, stamp: backupStamp(entry.name) })
      }
      backups.sort((a, b) => b.stamp.localeCompare(a.stamp))
      if (!backups.slice(options.keepBackups ?? 1).some(backup => backup.target === item.path && backup.stamp === item.identity.stamp)) return 'backup is now retained'
    } else if (LEGACY.test(name)) {
      const verified = []
      for (const entry of await listDirectories(plan.programRoot)) if (!entry.isSymbolicLink() && PRE_UPDATE.test(entry.name) && backupStamp(entry.name) && await fullInstall(path.join(plan.programRoot, entry.name))) verified.push(entry.name)
      if (verified.length < (options.keepBackups ?? 1)) return 'no retained verified pre-update rollback'
    } else return 'unapproved legacy installation identity'
  } else if (item.kind === 'artifact') {
    const release = (await readJson(path.join(item.path, 'win-unpacked', 'desktop-release.json')))?.releaseId
    const current = (await readJson(path.join(plan.installRoot, 'resources', 'version.json')))?.desktopReleaseId
    if (release !== item.identity?.releaseId || release !== path.basename(item.path) || !sameIdentity(await pathIdentity(item.path), item.identity.target) || await fileHash(path.join(item.path, 'win-unpacked', 'desktop-release.json')) !== item.identity.manifestHash || compareRelease(release, current) === null || compareRelease(release, current) >= 0) return 'artifact identity changed'
  } else if (item.kind === 'dist') {
    const name = path.basename(item.path)
    const match = /^(?:DeepSeek-Setup-([0-9]+\.[0-9]+\.[0-9]+)\.exe(?:\.blockmap)?|DeepSeek-Desktop-([0-9]+\.[0-9]+\.[0-9]+)-portable\.exe)$/.exec(name)
    const version = match?.[1] || match?.[2]
    const installed = (await readJson(path.join(plan.installRoot, 'resources', 'version.json')))?.appVersion
    if (!match || version !== item.identity?.version || !sameIdentity(await pathIdentity(item.path), item.identity.target) || compareVersion(version, installed) === null || compareVersion(version, installed) >= 0) return 'installer identity changed'
  } else return 'unapproved item kind'
  return null
}
async function run(options) {
  const mode = options.mode ?? 'preview'
  if (!['preview', 'execute', 'auto'].includes(mode)) throw Error('mode must be preview, execute, or auto')
  if (mode === 'execute' && !options.confirmExecute) throw Error('execute requires confirmExecute')
  const lockRoot = absolute(options.desktopRoot, 'desktopRoot')
  let handle
  let persist
  if (mode !== 'preview') {
    await assertPlainDirectory(lockRoot)
    handle = await fs.open(path.join(lockRoot, '.release-storage-maintenance.lock'), 'wx')
  }
  try {
    const plan = await discover(options)
    if (mode === 'auto') for (const item of plan.items) {
      if (item.decision === 'remove' && !(item.kind === 'install' && PRE_UPDATE.test(path.basename(item.path)))) {
        item.decision = 'skip'
        item.reason = 'skip: manual-only cleanup is disabled in auto mode'
      }
    }
    const beforeBytes = await diskFree(plan.desktopRoot)
    const removals = plan.blocked ? [] : plan.items.filter(item => item.decision === 'remove')
    const audit = { schema: 1, mode, roots: { programRoot: plan.programRoot, desktopRoot: plan.desktopRoot }, currentIdentity: plan.currentIdentity ?? null, retainedBackups: plan.retainedBackups ?? [], blocked: plan.blocked ?? null, protected: [], skipped: [], candidates: plan.items, disk: { beforeBytes, afterBytes: beforeBytes, freedBytes: 0 }, applied: [] }
    if (mode === 'preview' || plan.blocked) { refreshAudit(audit); return audit }
    if (mode === 'execute') {
      const approved = options.approvedPlan
      if (!approved || approved.schema !== 1 || approved.mode !== 'preview') throw Error('execute requires an approved preview plan')
      if (approved.roots?.programRoot !== plan.programRoot || approved.roots?.desktopRoot !== plan.desktopRoot || JSON.stringify(approved.currentIdentity) !== JSON.stringify(plan.currentIdentity)) throw Error('approved preview plan no longer matches current installation')
      if (!sameIdentity(approved.retainedBackups, plan.retainedBackups)) throw Error('approved preview retained rollback set no longer matches')
      for (const item of plan.items) if (item.decision === 'remove' && !approvedItem(item, approved)) { item.decision = 'skip'; item.reason = 'skip: not present in approved preview plan' }
    }
    persist = await createAuditWriter(plan, audit, options.auditPath, options.auditRoot, options.auditWriteHook)
    audit.status = 'intent'
    await persist()
    for (const item of removals) {
      if (item.decision !== 'remove') continue
      if (mode === 'auto' && !(item.kind === 'install' && PRE_UPDATE.test(path.basename(item.path)))) continue
      try {
        await assertPlainPath(item.path, item.root)
        const invalid = await revalidateRemoval(item, plan, options)
        if (invalid) throw Error(invalid)
        if (typeof options.beforeFinalFence === 'function') await options.beforeFinalFence(item)
        // This is the last operation before unlink: it uses only lstat path/identity checks.
        await assertPlainPath(item.path, item.root)
        const finalInvalid = await finalFence(item, plan)
        if (finalInvalid) throw Error(finalInvalid)
        await unlinkTree(item.path)
        audit.applied.push(item.path)
      } catch (error) { item.decision = 'skip'; item.reason = `skip: ${error.message}` }
      await persist()
    }
    audit.disk.afterBytes = await diskFree(plan.desktopRoot)
    audit.disk.freedBytes = Math.max(0, audit.disk.afterBytes - beforeBytes)
    audit.status = 'complete'
    await persist()
    return audit
  } finally {
    try { if (persist?.close) await persist.close() }
    finally { if (handle) { await handle.close(); await fs.rm(path.join(lockRoot, '.release-storage-maintenance.lock'), { force: true }) } }
  }
}
module.exports = { discover, run, assertPlainPath, unlinkTree, activeUnder, compareRelease, compareVersion }
