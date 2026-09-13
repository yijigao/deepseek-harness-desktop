'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { inventory, sha256, validateManifest, verifyPackage } = require('../../app/lib/release-package.js')

const MANIFEST_REL = 'desktop-release.json'
const VERSION_REL = 'resources/version.json'
const PLAN_TYPE = 'install-workspace-recovery-plan'
const ALLOWED_CHANGED_REL = 'resources/runtime/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'
const DEFAULT_POLICY = Object.freeze({
  staticFileCount: 28767,
  extraCounts: Object.freeze({ 'root-business': 69, 'wecom-data': 5, 'runtime-backup': 2 }),
})
const HASH = /^[a-f0-9]{64}$/
const RELEASE_ID = /^[a-z0-9][a-z0-9.-]{0,95}$/

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function planSha256(plan) {
  return sha256(Buffer.from(stableJson(plan), 'utf8'))
}

function assertHash(value, label) {
  if (!HASH.test(value || '')) throw new Error(`${label} must be a lowercase SHA-256`)
  return value
}

function canonicalAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  return path.resolve(value)
}

function keyPath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isFilesystemRoot(value) {
  const resolved = path.resolve(value)
  return keyPath(resolved) === keyPath(path.parse(resolved).root)
}

function overlaps(left, right) {
  return isWithin(left, right) || isWithin(right, left)
}

function assertRelativeFile(value, label) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes(':') || value.startsWith('/')) throw new Error(`${label} is not a safe relative file path`)
  if (value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error(`${label} is not a safe relative file path`)
  return value
}

function policyEqual(left, right) {
  return left?.staticFileCount === right.staticFileCount
    && Object.keys(right.extraCounts).every(key => left?.extraCounts?.[key] === right.extraCounts[key])
    && Object.keys(left?.extraCounts || {}).length === Object.keys(right.extraCounts).length
}

function validatePolicy(policy, { allowSyntheticPolicy = false } = {}) {
  if (!policy || !Number.isSafeInteger(policy.staticFileCount) || policy.staticFileCount < 1) throw new Error('Invalid recovery policy')
  const categories = ['root-business', 'wecom-data', 'runtime-backup']
  if (categories.some(key => !Number.isSafeInteger(policy.extraCounts?.[key]) || policy.extraCounts[key] < 0)) throw new Error('Invalid recovery extra policy')
  if (!allowSyntheticPolicy && !policyEqual(policy, DEFAULT_POLICY)) throw new Error('Recovery plan is not bound to the approved 28767+76 policy')
  return policy
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function exists(file) {
  try { await fsp.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function assertNoReparseComponents(input, { allowMissing = false } = {}) {
  const absolute = path.resolve(input)
  const parsed = path.parse(absolute)
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const part of parts) {
    current = path.join(current, part)
    let stat
    try { stat = await fsp.lstat(current) } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Reparse/symlink path component is not allowed: ${current}`)
  }
}

function exactKeys(actual, expected, label) {
  const left = Object.keys(actual).sort()
  const right = Object.keys(expected).sort()
  if (left.length !== right.length || left.some((name, index) => name !== right[index])) throw new Error(`${label} file set drifted`)
  for (const name of right) if (actual[name] !== expected[name]) throw new Error(`${label} hash drifted: ${name}`)
}

function validateExtras(extras, paths, policy) {
  if (!Array.isArray(extras) || extras.length !== Object.values(policy.extraCounts).reduce((a, b) => a + b, 0)) throw new Error('Recovery plan must enumerate exactly 76 approved extras')
  const seenSource = new Set()
  const seenTarget = new Set()
  const counts = { 'root-business': 0, 'wecom-data': 0, 'runtime-backup': 0 }
  return extras.map((entry, index) => {
    const relPath = assertRelativeFile(entry?.relPath ?? entry?.relativePath, `extras[${index}].relPath`)
    const category = entry?.category
    if (!Object.hasOwn(counts, category)) throw new Error(`extras[${index}].category is invalid`)
    counts[category] += 1
    const digest = assertHash(entry.sha256, `extras[${index}].sha256`)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`extras[${index}].size is invalid`)
    const targetPath = canonicalAbsolute(entry.targetPath ?? entry.destination, `extras[${index}].targetPath`)
    const allowedRoot = category === 'runtime-backup' ? path.join(paths.backupRoot, 'maintenance') : paths.workspaceRoot
    if (!isWithin(allowedRoot, targetPath) || keyPath(allowedRoot) === keyPath(targetPath)) throw new Error(`extras[${index}] target is outside its approved root`)
    if (isWithin(paths.installRoot, targetPath)) throw new Error(`extras[${index}] target must be outside the installation`)
    const reserved = [
      path.join(paths.backupRoot, 'snapshot'),
      path.join(paths.backupRoot, 'snapshot.json'),
      path.join(paths.backupRoot, 'operation-journal.jsonl'),
    ]
    if (reserved.some(value => isWithin(value, targetPath) || keyPath(value) === keyPath(targetPath))) throw new Error(`extras[${index}] target collides with recovery metadata`)
    const sourceKey = relPath.toLowerCase()
    const targetKey = keyPath(targetPath)
    if (seenSource.has(sourceKey) || seenTarget.has(targetKey)) throw new Error('Recovery extras contain duplicate source or target paths')
    seenSource.add(sourceKey); seenTarget.add(targetKey)
    return { relPath, sha256: digest, size: entry.size, category, targetPath }
  }).sort((a, b) => a.relPath.localeCompare(b.relPath))
}

function assertCategoryCounts(extras, policy) {
  for (const [category, count] of Object.entries(policy.extraCounts)) {
    if (extras.filter(entry => entry.category === category).length !== count) throw new Error(`Expected ${count} ${category} extras`)
  }
}

async function buildPlan(spec, options = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Recovery spec must be an object')
  const policy = validatePolicy(options.policy || DEFAULT_POLICY, { allowSyntheticPolicy: options.policy !== undefined })
  const paths = {
    installRoot: canonicalAbsolute(spec.installRoot, 'installRoot'),
    workspaceRoot: canonicalAbsolute(spec.workspaceRoot, 'workspaceRoot'),
    backupRoot: canonicalAbsolute(spec.backupRoot, 'backupRoot'),
    trustedManifestPath: canonicalAbsolute(spec.trustedManifestPath, 'trustedManifestPath'),
  }
  for (const [label, value] of Object.entries(paths)) if (isFilesystemRoot(value)) throw new Error(`${label} cannot be a filesystem root`)
  if (keyPath(paths.trustedManifestPath) !== keyPath(path.join(paths.installRoot, MANIFEST_REL))) throw new Error('trustedManifestPath must be the installation manifest')
  if (overlaps(paths.installRoot, paths.workspaceRoot) || overlaps(paths.installRoot, paths.backupRoot) || overlaps(paths.workspaceRoot, paths.backupRoot)) throw new Error('Install, workspace and backup roots must not overlap')
  for (const value of Object.values(paths)) await assertNoReparseComponents(value, { allowMissing: value !== paths.installRoot && value !== paths.trustedManifestPath })

  const trustedBytes = await fsp.readFile(paths.trustedManifestPath)
  const trustedManifestSha256 = assertHash(spec.trustedManifestSha256, 'trustedManifestSha256')
  if (sha256(trustedBytes) !== trustedManifestSha256) throw new Error('Trusted r7 manifest digest mismatch')
  const trustedManifest = validateManifest(JSON.parse(trustedBytes))
  if (spec.expectedStaticFileCount !== policy.staticFileCount || Object.keys(trustedManifest.files).length !== policy.staticFileCount) throw new Error('Trusted static inventory count mismatch')

  const change = spec.allowedChangedFile
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('Exactly one pre-approved static change is required')
  const allowedChangedFile = {
    relPath: assertRelativeFile(change.relPath, 'allowedChangedFile.relPath'),
    originalSha256: assertHash(change.expectedSha256, 'allowedChangedFile.expectedSha256'),
    liveSha256: assertHash(change.currentSha256, 'allowedChangedFile.currentSha256'),
  }
  if (trustedManifest.files[allowedChangedFile.relPath] !== allowedChangedFile.originalSha256) throw new Error('Allowed header change does not match trusted r7 manifest')
  if (allowedChangedFile.relPath !== ALLOWED_CHANGED_REL) throw new Error('Only the approved host-webserver file may differ')

  const versionSha256 = assertHash(trustedManifest.files[VERSION_REL], 'trusted manifest version hash')
  const adopted = spec.adopted
  if (!RELEASE_ID.test(adopted?.releaseId || '') || adopted.releaseId === trustedManifest.releaseId) throw new Error('Invalid adopted release ID')
  const adoptedPatchsetSha256 = assertHash(adopted?.patchsetSha256, 'adopted.patchsetSha256')

  const extras = validateExtras(spec.extras, paths, policy)
  assertCategoryCounts(extras, policy)
  const expected = { ...trustedManifest.files, [allowedChangedFile.relPath]: allowedChangedFile.liveSha256 }
  for (const extra of extras) {
    if (Object.hasOwn(expected, extra.relPath)) throw new Error(`Extra collides with trusted inventory: ${extra.relPath}`)
    expected[extra.relPath] = extra.sha256
    const source = path.join(paths.installRoot, ...extra.relPath.split('/'))
    const stat = await fsp.lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== extra.size) throw new Error(`Extra source type/size mismatch: ${extra.relPath}`)
    if (await exists(extra.targetPath)) throw new Error(`Recovery target already exists: ${extra.targetPath}`)
  }
  exactKeys(await inventory(paths.installRoot), expected, 'Installation plan input')

  const writerMatchRoots = [...new Set([
    paths.installRoot,
    path.join(paths.installRoot, 'resources', 'runtime'),
    ...extras.map(entry => path.join(paths.installRoot, ...entry.relPath.split('/'))),
    ...extras.map(entry => entry.targetPath),
    ...(Array.isArray(spec.writerMatchRoots) ? spec.writerMatchRoots.map((value, index) => canonicalAbsolute(value, `writerMatchRoots[${index}]`)) : []),
  ].map(value => path.resolve(value)))].sort()

  const plan = {
    schema: 1,
    type: PLAN_TYPE,
    policy,
    paths,
    trusted: { manifestSha256: trustedManifestSha256, manifest: trustedManifest, versionSha256, releaseId: trustedManifest.releaseId },
    allowedChangedFile,
    extras,
    adopted: { releaseId: adopted.releaseId, patchsetSha256: adoptedPatchsetSha256 },
    writerMatchRoots,
  }
  return { plan, planSha256: planSha256(plan) }
}

function assertTrustedPlan(plan, expectedPlanSha256, options = {}) {
  assertHash(expectedPlanSha256, 'expectedPlanSha256')
  if (plan?.schema !== 1 || plan.type !== PLAN_TYPE) throw new Error('Invalid recovery plan')
  validatePolicy(plan.policy, options)
  if (planSha256(plan) !== expectedPlanSha256) throw new Error('Trusted recovery plan digest mismatch')
  validateManifest(plan.trusted?.manifest)
  if (Object.keys(plan.trusted.manifest.files).length !== plan.policy.staticFileCount) throw new Error('Plan static inventory count mismatch')
  if (plan.allowedChangedFile?.relPath !== ALLOWED_CHANGED_REL) throw new Error('Plan changed-file authority mismatch')
  if (plan.trusted.manifest.files[plan.allowedChangedFile.relPath] !== plan.allowedChangedFile.originalSha256) throw new Error('Plan header authority mismatch')
  if (plan.trusted.manifest.files[VERSION_REL] !== plan.trusted.versionSha256) throw new Error('Plan version authority mismatch')
  if (plan.trusted.releaseId !== plan.trusted.manifest.releaseId) throw new Error('Plan original release identity mismatch')
  assertCategoryCounts(plan.extras, plan.policy)
  return plan
}

function snapshotEntries(plan) {
  const byPath = new Map()
  const add = (relPath, digest, kind) => {
    const prior = byPath.get(relPath)
    if (prior && prior.sha256 !== digest) throw new Error(`Conflicting snapshot authority: ${relPath}`)
    byPath.set(relPath, { relPath, sha256: digest, kind })
  }
  add(MANIFEST_REL, plan.trusted.manifestSha256, 'trusted-manifest')
  add(VERSION_REL, plan.trusted.versionSha256, 'trusted-version')
  add(plan.allowedChangedFile.relPath, plan.allowedChangedFile.liveSha256, 'approved-header')
  for (const extra of plan.extras) add(extra.relPath, extra.sha256, `extra-${extra.category}`)
  return [...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))
}

function snapshotReceipt(plan, expectedPlanSha256) {
  return {
    schema: 1,
    type: 'install-workspace-recovery-snapshot',
    planSha256: expectedPlanSha256,
    installRoot: plan.paths.installRoot,
    snapshotRoot: path.join(plan.paths.backupRoot, 'snapshot'),
    entries: snapshotEntries(plan).map(entry => ({ ...entry, snapshotPath: `install/${entry.relPath}` })),
  }
}

async function atomicCreateImmutable(file, bytes) {
  await assertNoReparseComponents(file, { allowMissing: true })
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await assertNoReparseComponents(path.dirname(file))
  if (await exists(file)) {
    const stat = await fsp.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Existing backup metadata is not a regular file: ${file}`)
    if (sha256(await fsp.readFile(file)) !== sha256(bytes)) throw new Error(`Existing backup metadata differs: ${file}`)
    return 'reused'
  }
  const temp = path.join(path.dirname(file), `.tmp-${process.pid}-${crypto.randomUUID()}`)
  try {
    const handle = await fsp.open(temp, 'wx')
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try { await fsp.link(temp, file) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (sha256(await fsp.readFile(file)) !== sha256(bytes)) throw new Error(`Existing backup metadata differs: ${file}`)
      return 'reused'
    }
    return 'written'
  } finally { await fsp.rm(temp, { force: true }) }
}

async function immutableSnapshotCopy(source, target, expectedSha256) {
  await assertNoReparseComponents(source)
  const sourceStat = await fsp.lstat(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Snapshot source is not a regular file: ${source}`)
  if (await hashFile(source) !== expectedSha256) throw new Error(`Snapshot source hash drifted: ${source}`)
  await assertNoReparseComponents(target, { allowMissing: true })
  if (await exists(target)) {
    const targetStat = await fsp.lstat(target)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error(`Existing snapshot is not a regular file: ${target}`)
    if (await hashFile(target) !== expectedSha256) throw new Error(`Existing snapshot differs: ${target}`)
    return 'reused'
  }
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await assertNoReparseComponents(path.dirname(target))
  const temp = path.join(path.dirname(target), `.copy-${process.pid}-${crypto.randomUUID()}`)
  try {
    await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL)
    if (await hashFile(temp) !== expectedSha256) throw new Error(`Snapshot copy verification failed: ${target}`)
    try { await fsp.link(temp, target) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (await hashFile(target) !== expectedSha256) throw new Error(`Existing snapshot differs: ${target}`)
      return 'reused'
    }
    return 'written'
  } finally { await fsp.rm(temp, { force: true }) }
}

async function appendJournal(plan, expectedPlanSha256, event) {
  const journal = path.join(plan.paths.backupRoot, 'operation-journal.jsonl')
  await assertNoReparseComponents(journal, { allowMissing: true })
  await fsp.mkdir(path.dirname(journal), { recursive: true })
  await assertNoReparseComponents(path.dirname(journal))
  if (await exists(journal)) {
    const stat = await fsp.lstat(journal)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Recovery journal is not a regular file')
  }
  const line = JSON.stringify({ schema: 1, at: new Date().toISOString(), planSha256: expectedPlanSha256, ...event }) + os.EOL
  const handle = await fsp.open(journal, 'a')
  try { await handle.write(line); await handle.sync() } finally { await handle.close() }
  return journal
}

async function snapshot(plan, expectedPlanSha256, options = {}) {
  assertTrustedPlan(plan, expectedPlanSha256, options)
  await assertNoReparseComponents(plan.paths.installRoot)
  await assertNoReparseComponents(plan.paths.backupRoot, { allowMissing: true })
  const receipt = snapshotReceipt(plan, expectedPlanSha256)
  const receiptPath = path.join(plan.paths.backupRoot, 'snapshot.json')
  const journalPathCandidate = path.join(plan.paths.backupRoot, 'operation-journal.jsonl')
  await assertNoReparseComponents(receiptPath, { allowMissing: true })
  await assertNoReparseComponents(journalPathCandidate, { allowMissing: true })
  for (const entry of receipt.entries) {
    const source = path.join(plan.paths.installRoot, ...entry.relPath.split('/'))
    const target = path.join(receipt.snapshotRoot, ...entry.snapshotPath.split('/'))
    await assertNoReparseComponents(source)
    await assertNoReparseComponents(target, { allowMissing: true })
  }
  let written = 0; let reused = 0
  for (const entry of receipt.entries) {
    const source = path.join(plan.paths.installRoot, ...entry.relPath.split('/'))
    const target = path.join(receipt.snapshotRoot, ...entry.snapshotPath.split('/'))
    const outcome = await immutableSnapshotCopy(source, target, entry.sha256)
    if (outcome === 'written') written += 1; else reused += 1
  }
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  await atomicCreateImmutable(receiptPath, receiptBytes)
  const journalPath = await appendJournal(plan, expectedPlanSha256, { event: 'snapshot-verified', entryCount: receipt.entries.length, snapshotSha256: sha256(receiptBytes) })
  return { status: 'snapshotted', entryCount: receipt.entries.length, written, reused, snapshotRoot: receipt.snapshotRoot, receiptPath, receiptSha256: sha256(receiptBytes), journalPath }
}

async function verifySnapshot(plan, expectedPlanSha256) {
  const expected = snapshotReceipt(plan, expectedPlanSha256)
  const receiptPath = path.join(plan.paths.backupRoot, 'snapshot.json')
  await assertNoReparseComponents(receiptPath)
  const bytes = await fsp.readFile(receiptPath)
  const actual = JSON.parse(bytes)
  if (stableJson(actual) !== stableJson(expected)) throw new Error('Recovery snapshot receipt differs from trusted plan')
  for (const entry of expected.entries) {
    const target = path.join(expected.snapshotRoot, ...entry.snapshotPath.split('/'))
    await assertNoReparseComponents(target)
    if (await hashFile(target) !== entry.sha256) throw new Error(`Recovery snapshot is damaged: ${entry.relPath}`)
  }
  return { receipt: actual, receiptPath, receiptSha256: sha256(bytes) }
}

function defaultProcessProvider() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('Cannot establish a trustworthy Windows process inventory')
  const parsed = JSON.parse(result.stdout)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function normalizedText(value) {
  return String(value || '').replaceAll('/', '\\').toLowerCase()
}

function busyProcesses(plan, processes, selfPid = process.pid) {
  const roots = plan.writerMatchRoots.map(normalizedText)
  const blockers = []
  for (const row of processes) {
    const pid = Number(row.ProcessId ?? row.pid)
    if (!Number.isSafeInteger(pid) || pid === selfPid) continue
    const name = String(row.Name ?? row.name ?? '')
    const exe = String(row.ExecutablePath ?? row.executablePath ?? '')
    const command = String(row.CommandLine ?? row.commandLine ?? '')
    const reasons = []
    if (exe && isWithin(plan.paths.installRoot, exe)) reasons.push('executable-under-install-root')
    const nodeOrPython = /^(?:node|python(?:w)?(?:\d+(?:\.\d+)*)?)\.exe$/i.test(name)
    if (nodeOrPython) {
      if (!exe || !command) reasons.push('node-python-origin-or-commandline-unknown')
      else if (roots.some(root => normalizedText(command).includes(root))) reasons.push('node-python-references-protected-path')
    }
    if (/^deepseek\.exe$/i.test(name) && !exe) reasons.push('deepseek-process-origin-unknown')
    if (reasons.length) blockers.push({ pid, name: name || 'unknown', reasons: [...new Set(reasons)] })
  }
  return blockers.sort((a, b) => a.pid - b.pid)
}

function wecomRoots(plan) {
  const targetRoot = path.join(plan.paths.workspaceRoot, '.dsh', 'wecom-cli')
  const entries = plan.extras.filter(entry => entry.category === 'wecom-data')
  const required = new Set(['.dsh/wecom-cli/.encryption_key', '.dsh/wecom-cli/credentials.enc'])
  for (const entry of entries) {
    if (!entry.relPath.startsWith('.dsh/wecom-cli/')) throw new Error('WeCom data source is outside the approved credential root')
    const suffix = entry.relPath.slice('.dsh/wecom-cli/'.length)
    if (keyPath(entry.targetPath) !== keyPath(path.join(targetRoot, ...suffix.split('/')))) throw new Error('WeCom data target does not preserve its approved relative path')
    required.delete(entry.relPath)
  }
  if (required.size) throw new Error('The WeCom credential pair must be migrated together')
  return { targetRoot, entries }
}

function defaultAclProtector(target) {
  if (process.platform !== 'win32') throw new Error('WeCom ACL protection requires Windows')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = [Environment]::GetEnvironmentVariable('DSH_RECOVERY_ACL_TARGET', 'Process')",
    "if ([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)) { throw 'ACL target is unavailable' }",
    "$principals = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))",
    "$item = Get-Item -LiteralPath $target -Force",
    "$acl = Get-Acl -LiteralPath $item.FullName",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }",
    "$inheritance = if ($item.PSIsContainer) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }",
    "foreach ($principal in $principals) {",
    "  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
    "  [void]$acl.AddAccessRule($rule)",
    "}",
    "Set-Acl -LiteralPath $item.FullName -AclObject $acl",
    "$check = Get-Acl -LiteralPath $item.FullName",
    "if (-not $check.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled' }",
    "$expected = @{}; foreach ($principal in $principals) { $expected[$principal.Value] = $true }",
    "$actual = @($check.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)",
    "if ($actual.Count -ne 3 -or @($actual | Where-Object { -not $expected.ContainsKey($_) }).Count -ne 0) { throw 'ACL principals differ' }",
    "if (@($check.Access | Where-Object { $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl }).Count -ne 0) { throw 'ACL rights differ' }",
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_RECOVERY_ACL_TARGET: target }, maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('Failed to apply protected WeCom ACL')
}

async function protectWecomTarget(target, aclProtector) {
  await assertNoReparseComponents(target)
  await aclProtector(target)
  await assertNoReparseComponents(target)
}

async function readJournal(plan, expectedPlanSha256) {
  const journalPath = path.join(plan.paths.backupRoot, 'operation-journal.jsonl')
  if (!(await exists(journalPath))) return []
  await assertNoReparseComponents(journalPath)
  const lines = (await fsp.readFile(journalPath, 'utf8')).split(/\r?\n/).filter(Boolean)
  return lines.map(line => JSON.parse(line)).filter(entry => entry.planSha256 === expectedPlanSha256)
}

function hasCompletedMove(journal, extra) {
  return journal.some(entry => entry.event === 'move-complete' && entry.relPath === extra.relPath && keyPath(entry.targetPath) === keyPath(extra.targetPath) && entry.sha256 === extra.sha256)
}

async function classifyMoves(plan, expectedPlanSha256) {
  const journal = await readJournal(plan, expectedPlanSha256)
  const pending = []; const moved = []
  for (const extra of plan.extras) {
    const source = path.join(plan.paths.installRoot, ...extra.relPath.split('/'))
    const sourceExists = await exists(source)
    const targetExists = await exists(extra.targetPath)
    if (sourceExists && targetExists) throw new Error(`Both source and target exist: ${extra.relPath}`)
    if (!sourceExists && !targetExists) throw new Error(`Neither source nor target exists: ${extra.relPath}`)
    if (sourceExists) {
      await assertNoReparseComponents(source)
      const stat = await fsp.lstat(source)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== extra.size || await hashFile(source) !== extra.sha256) throw new Error(`Extra source drifted: ${extra.relPath}`)
      pending.push({ ...extra, source })
    } else {
      if (!hasCompletedMove(journal, extra)) throw new Error(`Target exists without a trusted completed journal entry: ${extra.relPath}`)
      await assertNoReparseComponents(extra.targetPath)
      const stat = await fsp.lstat(extra.targetPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== extra.size) throw new Error(`Moved target type/size drifted: ${extra.relPath}`)
      if (await hashFile(extra.targetPath) !== extra.sha256) throw new Error(`Moved target drifted: ${extra.relPath}`)
      moved.push(extra)
    }
  }
  return { pending, moved, journal }
}

function deriveAdopted(plan, originalVersion) {
  const version = { ...originalVersion, desktopReleaseId: plan.adopted.releaseId }
  for (const key of Object.keys(originalVersion)) {
    if (key !== 'desktopReleaseId' && stableJson(version[key]) !== stableJson(originalVersion[key])) throw new Error(`Unexpected version field change: ${key}`)
  }
  const versionBytes = Buffer.from(JSON.stringify(version, null, 2) + '\n', 'utf8')
  const manifest = {
    ...plan.trusted.manifest,
    releaseId: plan.adopted.releaseId,
    patchsetSha256: plan.adopted.patchsetSha256,
    files: {
      ...plan.trusted.manifest.files,
      [plan.allowedChangedFile.relPath]: plan.allowedChangedFile.liveSha256,
      [VERSION_REL]: sha256(versionBytes),
    },
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { version, versionBytes, versionSha256: sha256(versionBytes), manifest, manifestBytes, manifestSha256: sha256(manifestBytes) }
}

async function atomicReplace(file, bytes) {
  const temp = path.join(path.dirname(file), `.adopt-${process.pid}-${crypto.randomUUID()}.tmp`)
  const handle = await fsp.open(temp, 'wx')
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  try { await fsp.rename(temp, file) } finally { await fsp.rm(temp, { force: true }) }
}

async function defaultMoveFile(source, target) {
  if (process.platform !== 'win32') return fsp.rename(source, target)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$source = [Environment]::GetEnvironmentVariable('DSH_RECOVERY_MOVE_SOURCE', 'Process')",
    "$target = [Environment]::GetEnvironmentVariable('DSH_RECOVERY_MOVE_TARGET', 'Process')",
    "if ([string]::IsNullOrWhiteSpace($source) -or [string]::IsNullOrWhiteSpace($target)) { throw 'Move endpoints are unavailable' }",
    "[System.IO.File]::Move($source, $target)",
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, DSH_RECOVERY_MOVE_SOURCE: source, DSH_RECOVERY_MOVE_TARGET: target },
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) {
    const error = new Error('Native no-overwrite move failed')
    error.code = 'MOVE_FAILED'
    throw error
  }
}

async function expectedInstallInventory(plan, moves, adopted) {
  const expected = {
    ...plan.trusted.manifest.files,
    [plan.allowedChangedFile.relPath]: plan.allowedChangedFile.liveSha256,
  }
  const versionPath = path.join(plan.paths.installRoot, ...VERSION_REL.split('/'))
  const versionHash = await hashFile(versionPath)
  if (![plan.trusted.versionSha256, adopted.versionSha256].includes(versionHash)) throw new Error('Version file is neither original nor adopted')
  expected[VERSION_REL] = versionHash
  for (const extra of moves.pending) expected[extra.relPath] = extra.sha256
  exactKeys(await inventory(plan.paths.installRoot), expected, 'Installation execution input')
}

async function execute(plan, expectedPlanSha256, options = {}) {
  assertTrustedPlan(plan, expectedPlanSha256, options)
  const provider = options.processProvider || defaultProcessProvider
  const blockers = busyProcesses(plan, await provider(), options.selfPid ?? process.pid)
  if (blockers.length) {
    const error = new Error('Active or unverifiable writers block installation recovery')
    error.code = 'INSTALL_RECOVERY_BUSY'
    error.blockers = blockers
    throw error
  }
  await assertNoReparseComponents(plan.paths.installRoot)
  await assertNoReparseComponents(plan.paths.workspaceRoot, { allowMissing: true })
  await assertNoReparseComponents(plan.paths.backupRoot)
  for (const extra of plan.extras) {
    await assertNoReparseComponents(path.join(plan.paths.installRoot, ...extra.relPath.split('/')), { allowMissing: true })
    await assertNoReparseComponents(extra.targetPath, { allowMissing: true })
  }
  await verifySnapshot(plan, expectedPlanSha256)
  const originalVersionPath = path.join(plan.paths.backupRoot, 'snapshot', 'install', ...VERSION_REL.split('/'))
  const originalVersionBytes = await fsp.readFile(originalVersionPath)
  if (sha256(originalVersionBytes) !== plan.trusted.versionSha256) throw new Error('Original version snapshot authority mismatch')
  const originalVersion = JSON.parse(originalVersionBytes)
  const adopted = deriveAdopted(plan, originalVersion)
  const versionPath = path.join(plan.paths.installRoot, ...VERSION_REL.split('/'))
  const manifestPath = path.join(plan.paths.installRoot, MANIFEST_REL)
  const preflightManifestHash = await hashFile(manifestPath)
  const preflightVersionHash = await hashFile(versionPath)
  if (![plan.trusted.manifestSha256, adopted.manifestSha256].includes(preflightManifestHash)) throw new Error('Live manifest drifted before recovery mutation')
  if (![plan.trusted.versionSha256, adopted.versionSha256].includes(preflightVersionHash)) throw new Error('Live version drifted before recovery mutation')
  if (preflightManifestHash === adopted.manifestSha256 && preflightVersionHash !== adopted.versionSha256) throw new Error('Adopted manifest exists without its adopted version')
  const moves = await classifyMoves(plan, expectedPlanSha256)
  await expectedInstallInventory(plan, moves, adopted)

  const aclProtector = options.aclProtector || defaultAclProtector
  const wecom = wecomRoots(plan)
  await assertNoReparseComponents(wecom.targetRoot, { allowMissing: true })
  await fsp.mkdir(wecom.targetRoot, { recursive: true })
  await assertNoReparseComponents(wecom.targetRoot)
  try {
    await protectWecomTarget(wecom.targetRoot, aclProtector)
    await appendJournal(plan, expectedPlanSha256, { event: 'acl-complete', scope: 'wecom-target-root' })
  } catch (error) {
    await appendJournal(plan, expectedPlanSha256, { event: 'acl-failed', scope: 'wecom-target-root', errorCode: String(error.code || 'ACL_FAILED') })
    throw error
  }
  for (const extra of moves.moved.filter(entry => entry.category === 'wecom-data')) {
    try {
      await protectWecomTarget(extra.targetPath, aclProtector)
      await appendJournal(plan, expectedPlanSha256, { event: 'acl-complete', relPath: extra.relPath, sha256: extra.sha256 })
    } catch (error) {
      await appendJournal(plan, expectedPlanSha256, { event: 'acl-failed', relPath: extra.relPath, sha256: extra.sha256, errorCode: String(error.code || 'ACL_FAILED') })
      throw error
    }
  }

  const renameFile = options.renameFile || defaultMoveFile
  for (const extra of moves.pending) {
    await assertNoReparseComponents(path.dirname(extra.targetPath), { allowMissing: true })
    await fsp.mkdir(path.dirname(extra.targetPath), { recursive: true })
    await assertNoReparseComponents(path.dirname(extra.targetPath))
    await assertNoReparseComponents(extra.source)
    const sourceStat = await fsp.lstat(extra.source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== extra.size || await hashFile(extra.source) !== extra.sha256) throw new Error(`Extra source changed immediately before move: ${extra.relPath}`)
    await assertNoReparseComponents(extra.targetPath, { allowMissing: true })
    if (await exists(extra.targetPath)) throw new Error(`Recovery target appeared during execution: ${extra.targetPath}`)
    await appendJournal(plan, expectedPlanSha256, { event: 'move-start', relPath: extra.relPath, targetPath: extra.targetPath, sha256: extra.sha256 })
    let moveCompleted = false
    try {
      await renameFile(extra.source, extra.targetPath)
      if (await exists(extra.source) || await hashFile(extra.targetPath) !== extra.sha256) throw new Error('post-rename verification failed')
      await appendJournal(plan, expectedPlanSha256, { event: 'move-complete', relPath: extra.relPath, targetPath: extra.targetPath, sha256: extra.sha256 })
      moveCompleted = true
      if (extra.category === 'wecom-data') {
        await protectWecomTarget(extra.targetPath, aclProtector)
        await appendJournal(plan, expectedPlanSha256, { event: 'acl-complete', relPath: extra.relPath, sha256: extra.sha256 })
      }
    } catch (error) {
      await appendJournal(plan, expectedPlanSha256, { event: moveCompleted ? 'acl-failed' : 'move-failed', relPath: extra.relPath, targetPath: extra.targetPath, sha256: extra.sha256, errorCode: String(error.code || (moveCompleted ? 'ACL_FAILED' : 'MOVE_FAILED')) })
      throw new Error(`Recovery move failed; preserve source, target, snapshot and journal for review: ${extra.relPath}`, { cause: error })
    }
  }

  const afterMoves = await inventory(plan.paths.installRoot)
  const expectedAfterMoves = { ...plan.trusted.manifest.files, [plan.allowedChangedFile.relPath]: plan.allowedChangedFile.liveSha256 }
  const currentVersionHash = afterMoves[VERSION_REL]
  if (![plan.trusted.versionSha256, adopted.versionSha256].includes(currentVersionHash)) throw new Error('Post-move version state is invalid')
  expectedAfterMoves[VERSION_REL] = currentVersionHash
  exactKeys(afterMoves, expectedAfterMoves, 'Post-move installation')

  const finalBlockers = busyProcesses(plan, await provider(), options.selfPid ?? process.pid)
  if (finalBlockers.length) {
    const error = new Error('A writer appeared before release adoption; moved files and journal were preserved')
    error.code = 'INSTALL_RECOVERY_BUSY'
    error.blockers = finalBlockers
    throw error
  }
  let liveVersionHash = await hashFile(versionPath)
  let liveManifestHash = await hashFile(manifestPath)
  if (liveManifestHash === adopted.manifestSha256 && liveVersionHash !== adopted.versionSha256) throw new Error('Adopted manifest exists without its adopted version')
  const replaceFile = options.replaceFile || atomicReplace
  if (liveVersionHash === plan.trusted.versionSha256) {
    await appendJournal(plan, expectedPlanSha256, { event: 'replace-start', relPath: VERSION_REL, fromSha256: liveVersionHash, toSha256: adopted.versionSha256 })
    await replaceFile(versionPath, adopted.versionBytes)
    liveVersionHash = await hashFile(versionPath)
    if (liveVersionHash !== adopted.versionSha256) throw new Error('Adopted version replacement verification failed')
    await appendJournal(plan, expectedPlanSha256, { event: 'replace-complete', relPath: VERSION_REL, sha256: liveVersionHash })
  } else if (liveVersionHash !== adopted.versionSha256) throw new Error('Version replacement state is not resumable')

  liveManifestHash = await hashFile(manifestPath)
  if (liveManifestHash === plan.trusted.manifestSha256) {
    await appendJournal(plan, expectedPlanSha256, { event: 'replace-start', relPath: MANIFEST_REL, fromSha256: liveManifestHash, toSha256: adopted.manifestSha256 })
    await replaceFile(manifestPath, adopted.manifestBytes)
    liveManifestHash = await hashFile(manifestPath)
    if (liveManifestHash !== adopted.manifestSha256) throw new Error('Adopted manifest replacement verification failed')
    await appendJournal(plan, expectedPlanSha256, { event: 'replace-complete', relPath: MANIFEST_REL, sha256: liveManifestHash })
  } else if (liveManifestHash !== adopted.manifestSha256) throw new Error('Manifest replacement state is not resumable')

  const verified = await verifyPackage(plan.paths.installRoot, adopted.manifestSha256)
  const finalVersion = JSON.parse(await fsp.readFile(versionPath, 'utf8'))
  if (finalVersion.desktopReleaseId !== verified.releaseId) throw new Error('Storage guard release identity mismatch after adoption')
  const journalPath = await appendJournal(plan, expectedPlanSha256, { event: 'recovery-complete', releaseId: verified.releaseId, manifestSha256: adopted.manifestSha256, movedCount: plan.extras.length })
  return { status: 'succeeded', releaseId: verified.releaseId, manifestSha256: adopted.manifestSha256, movedCount: plan.extras.length, installRoot: plan.paths.installRoot, workspaceRoot: plan.paths.workspaceRoot, backupRoot: plan.paths.backupRoot, journalPath }
}

module.exports = {
  DEFAULT_POLICY,
  MANIFEST_REL,
  VERSION_REL,
  assertNoReparseComponents,
  buildPlan,
  busyProcesses,
  defaultAclProtector,
  defaultMoveFile,
  execute,
  planSha256,
  snapshot,
  verifySnapshot,
}
