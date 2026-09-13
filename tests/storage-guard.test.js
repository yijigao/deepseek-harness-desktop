import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const guard = require('../app/lib/storage-guard.js')
const runnerPath = path.join(root, 'scripts', 'run-storage-guard.ps1')
const installerPath = path.join(root, 'scripts', 'install-storage-guard.ps1')
const runner = fs.readFileSync(runnerPath, 'utf8')
const installer = fs.readFileSync(installerPath, 'utf8')

test('storage threshold is exactly 20 GiB by default', () => {
  assert.equal(guard.DEFAULT_THRESHOLD_BYTES, 20 * 1024 ** 3)
})

test('low-space reminders are rate-limited within one episode', () => {
  const now = Date.parse('2026-09-09T00:00:00.000Z')
  const first = guard.planLowSpaceCheck({ freeBytes: guard.DEFAULT_THRESHOLD_BYTES - 1, state: null, now })
  assert.equal(first.shouldNotify, true)
  assert.equal(first.reason, 'new-low-space')
  const notified = guard.recordNotification(first.nextState, now)
  const early = guard.planLowSpaceCheck({ freeBytes: 1, state: notified, now: now + guard.DEFAULT_REMINDER_INTERVAL_MS - 1 })
  assert.equal(early.shouldNotify, false)
  assert.equal(early.reason, 'reminder-rate-limited')
  const due = guard.planLowSpaceCheck({ freeBytes: 1, state: notified, now: now + guard.DEFAULT_REMINDER_INTERVAL_MS })
  assert.equal(due.shouldNotify, true)
  assert.equal(due.reason, 'reminder-due')
})

test('space recovery rearms an immediate future notification', () => {
  const now = Date.parse('2026-09-09T00:00:00.000Z')
  const old = { schema: 1, lowSpace: true, lastNotifiedUtc: new Date(now).toISOString() }
  const recovered = guard.planLowSpaceCheck({ freeBytes: guard.DEFAULT_THRESHOLD_BYTES, state: old, now: now + 1000 })
  assert.equal(recovered.reason, 'recovered')
  assert.deepEqual(recovered.nextState, { schema: 1, lowSpace: false, lastNotifiedUtc: null })
  const lowAgain = guard.planLowSpaceCheck({ freeBytes: 0, state: recovered.nextState, now: now + 2000 })
  assert.equal(lowAgain.shouldNotify, true)
})

test('malformed persisted state fails closed to a rearmed state', () => {
  assert.deepEqual(guard.normalizeState({ schema: 9, lowSpace: true, lastNotifiedUtc: 'secret' }), {
    schema: 1,
    lowSpace: false,
    lastNotifiedUtc: null,
  })
})

test('runner is allowlist-only, non-networked, bounded, and supports safe checks', () => {
  assert.match(runner, /\$summary\.mode = if \(\$DryRun\) \{ 'preview' \} else \{ 'auto' \}/)
  assert.match(runner, /--mode auto is destructive; DryRun must remain mapped to preview/)
  assert.match(runner, /'--mode', \$summary\.mode/)
  assert.match(runner, /\[switch\]\$CheckOnly/)
  assert.match(runner, /\[switch\]\$NoNotify/)
  assert.match(runner, /524288/)
  assert.match(runner, /NotifyIcon/)
  assert.match(runner, /IncludeTestTemps is disabled by storage guard policy/)
  assert.match(runner, /maintenance=failed/)
  assert.match(runner, /Diagnostics must never suppress the low-space check or notification/)
  assert.doesNotMatch(runner, /cleanup has run/i)
  assert.doesNotMatch(runner, /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|WebClient|HttpClient/)
  assert.doesNotMatch(runner, /session|conversation|wechat|weixin|Temp\\|Windows\\/i)
})

test('installer is scoped to one limited interactive task with logon and daily triggers', () => {
  assert.match(installer, /TaskName -cne 'DeepSeek-StorageGuard'/)
  assert.match(installer, /New-ScheduledTaskPrincipal[^\r\n]+-LogonType Interactive -RunLevel Limited/)
  assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.match(installer, /New-ScheduledTaskTrigger -Daily/)
  assert.match(installer, /-WindowStyle', 'Hidden'/)
  assert.match(installer, /IncludeTestTemps is disabled by storage guard policy/)
  assert.match(installer, /Test-KnownTask/)
  assert.ok(installer.includes("Get-ScheduledTask -TaskPath '\\' -TaskName $TaskName"))
  assert.ok(installer.includes("Unregister-ScheduledTask -TaskPath '\\' -TaskName $TaskName"))
  assert.match(installer, /registeredActions\[0\]\.Arguments, \$actionArguments/)
  assert.match(installer, /MSFT_TaskLogonTrigger/)
  assert.match(installer, /MSFT_TaskDailyTrigger/)
  assert.ok(installer.indexOf('$existing = Get-ScheduledTask') < installer.indexOf('Copy-Item -LiteralPath $sourceRunner'))
  assert.doesNotMatch(installer, /RunOnce|CurrentVersion\\Run|schtasks|Register-WmiEvent/)
})

test('PowerShell scripts parse and installer DryRun does not register a task', { skip: process.platform !== 'win32' }, () => {
  for (const file of [runnerPath, installerPath]) {
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$errors=$null; [void][Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$null, [ref]$errors); if($errors.Count){$errors | ForEach-Object { $_.ToString() }; exit 1}`], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout)
  }
  const dry = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', installerPath, '-DryRun', '-RepoRoot', root, '-NodePath', process.execPath], { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr || dry.stdout)
  const plan = JSON.parse(dry.stdout.trim())
  assert.equal(plan.dryRun, true)
  assert.equal(plan.taskName, 'DeepSeek-StorageGuard')
  assert.match(plan.arguments, /run-storage-guard\.ps1/)
  assert.match(plan.arguments, /release-storage-maintenance\.mjs/)
})

test('IncludeTestTemps is explicitly rejected by installer and runner', { skip: process.platform !== 'win32' }, () => {
  const install = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', installerPath, '-DryRun', '-IncludeTestTemps'], { encoding: 'utf8' })
  assert.notEqual(install.status, 0)
  assert.match(install.stderr, /IncludeTestTemps is disabled/)
  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', runnerPath,
    '-NodePath', process.execPath,
    '-MaintenanceScript', path.join(root, 'scripts', 'release-storage-maintenance.mjs'),
    '-ProgramRoot', root,
    '-DesktopRoot', root,
    '-DryRun', '-NoNotify', '-IncludeTestTemps',
  ], { encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /IncludeTestTemps is disabled/)
})

test('runner still checks free space when an isolated helper fails', { skip: process.platform !== 'win32' }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-storage-guard-'))
  try {
    const desktopRoot = path.join(fixture, 'desktop')
    const programRoot = path.join(fixture, 'programs')
    const localAppData = path.join(fixture, 'local-app-data')
    fs.mkdirSync(desktopRoot)
    fs.mkdirSync(programRoot)
    const cases = [
      { name: 'nonzero.mjs', source: "process.stderr.write('fixture failure\\n'); process.exit(17)\n", errorType: 'NonZeroExit', exitCode: 17 },
      { name: 'invalid-json.mjs', source: "process.stdout.write('not-json')\n", errorType: 'InvalidJson', exitCode: null },
      { name: 'blocked.mjs', source: `process.stdout.write(JSON.stringify({ mode: 'preview', blocked: 'fixture policy block', disk: { beforeBytes: 1, afterBytes: 1, freedBytes: 0 }, candidates: [], protected: [], skipped: [], applied: [] }))\n`, errorType: 'Blocked', exitCode: null, blockedReason: 'fixture policy block' },
    ]
    for (const fixtureCase of cases) {
      const helper = path.join(fixture, fixtureCase.name)
      fs.writeFileSync(helper, fixtureCase.source)
      const run = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', runnerPath,
        '-NodePath', process.execPath,
        '-MaintenanceScript', helper,
        '-ProgramRoot', programRoot,
        '-DesktopRoot', desktopRoot,
        '-ThresholdGiB', '1024',
        '-DryRun', '-NoNotify',
      ], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: localAppData } })
      assert.equal(run.status, 0, run.stderr || run.stdout)
      const result = JSON.parse(run.stdout.trim())
      assert.equal(result.ok, true)
      assert.equal(result.maintenance.attempted, true)
      assert.equal(result.maintenance.succeeded, false)
      assert.equal(result.maintenance.errorType, fixtureCase.errorType)
      assert.equal(result.maintenance.exitCode, fixtureCase.exitCode)
      assert.equal(result.maintenance.blockedReason, fixtureCase.blockedReason ?? null)
      assert.equal(typeof result.freeBytes, 'number')
      assert.equal(result.lowSpace, result.freeBytes < result.thresholdBytes)
      assert.equal(result.notified, false)
    }
    assert.equal(fs.existsSync(path.join(localAppData, 'DeepSeekMaintenance')), false, 'DryRun must not create guard state or logs')
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
