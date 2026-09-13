'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const contract = require('../app/lib/verification-contract')
const { requireTemporaryExitDiagnostics } = require('../app/lib/exit-diagnostics')

const root = path.join(__dirname, '..')

test('shared validation contract covers junction repair, startup, verification, recovery, and shutdown', () => {
  assert.equal(contract.ENGINE_START_ATTEMPT_TIMEOUT_MS, contract.JUNCTION_REPAIR_TIMEOUT_MS + contract.ENGINE_READY_TIMEOUT_MS)
  assert.equal(contract.isolatedValidationTimeoutMs('--verify'), contract.ENGINE_START_ATTEMPT_TIMEOUT_MS + contract.VERIFY_RENDER_DELAY_MS + contract.SHUTDOWN_GRACE_MS)
  assert.equal(contract.isolatedValidationTimeoutMs('--shot'), contract.ENGINE_START_ATTEMPT_TIMEOUT_MS + contract.SCREENSHOT_RENDER_DELAY_MS + contract.SHUTDOWN_GRACE_MS)
  assert.equal(contract.isolatedValidationTimeoutMs('--verify-engine-recovery'), (contract.ENGINE_START_ATTEMPT_TIMEOUT_MS * 2) + contract.RECOVERY_PRE_KILL_DELAY_MS + contract.RECOVERY_POST_RESTART_DELAY_MS + contract.SHUTDOWN_GRACE_MS)
  assert.equal(contract.isolatedValidationTimeoutMs('--verify'), 312_000)
  assert.equal(contract.isolatedValidationTimeoutMs('--verify-engine-recovery'), 571_000)
  assert.throws(() => contract.isolatedValidationTimeoutMs('--unknown'), /Unknown/)
})

test('PowerShell launchers read the shared timeout contract instead of embedding a shorter wait', () => {
  const tool = path.join(root, 'scripts/verification-contract.cjs')
  for (const mode of ['--verify', '--shot', '--verify-engine-recovery']) {
    assert.equal(JSON.parse(childProcess.execFileSync(process.execPath, [tool, mode], { encoding: 'utf8' })).timeoutMs, contract.isolatedValidationTimeoutMs(mode))
  }
  for (const script of ['scripts/install-validated.ps1', 'scripts/test-desktop.ps1']) {
    const source = fs.readFileSync(path.join(root, script), 'utf8')
    assert.match(source, /verification-contract\.cjs/)
    assert.match(source, /Get-ValidationTimeoutMs/)
    assert.doesNotMatch(source, /WaitForExit\(55000\)/)
  }
  const main = fs.readFileSync(path.join(root, 'app/main.js'), 'utf8')
  assert.match(main, /JUNCTION_REPAIR_TIMEOUT_MS/)
  assert.match(main, /ENGINE_READY_TIMEOUT_MS/)
  assert.match(main, /VERIFY_RENDER_DELAY_MS/)
})

function exitDiagnosticFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exit-diagnostics-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const temporary = path.join(root, 'temporary'); fs.mkdirSync(temporary)
  const paths = {
    HOME: path.join(temporary, 'home'), USERPROFILE: path.join(temporary, 'profile'), APPDATA: path.join(temporary, 'appdata'), LOCALAPPDATA: path.join(temporary, 'localappdata'), DSH_HOME: path.join(temporary, 'home'),
    userData: path.join(temporary, 'userdata'), temp: temporary,
  }
  for (const value of Object.values(paths)) if (value !== temporary) fs.mkdirSync(value, { recursive: true })
  return { root, temporary, paths, app: { getPath: (name) => paths[name] } }
}

test('exit diagnostics accepts only fresh, real TEMP descendants', (t) => {
  const f = exitDiagnosticFixture(t)
  const result = requireTemporaryExitDiagnostics({ app: f.app, env: { ...f.paths, DSH_TEST_MODE: '1' }, tempDir: f.temporary, dshHome: f.paths.DSH_HOME })
  assert.equal(result.crashDumps, path.join(f.temporary, 'deepseek-exit-dumps'))
  assert.equal(result.timelinePath, path.join(f.temporary, 'deepseek-exit-timeline.jsonl'))
  assert.equal(fs.existsSync(result.crashDumps), false)
  assert.throws(() => requireTemporaryExitDiagnostics({ app: f.app, env: { ...f.paths, DSH_TEST_MODE: '1', HOME: f.temporary }, tempDir: f.temporary, dshHome: f.paths.DSH_HOME }), /HOME/)
  fs.writeFileSync(result.timelinePath, '')
  assert.throws(() => requireTemporaryExitDiagnostics({ app: f.app, env: { ...f.paths, DSH_TEST_MODE: '1' }, tempDir: f.temporary, dshHome: f.paths.DSH_HOME }), /new deepseek-exit-timeline\.jsonl/)
})

test('exit diagnostics rejects a pre-planted dump junction without writing outside TEMP', (t) => {
  const f = exitDiagnosticFixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside)
  const dumpLink = path.join(f.temporary, 'deepseek-exit-dumps')
  try { fs.symlinkSync(outside, dumpLink, 'junction') } catch (error) { t.skip(`junction fixture unavailable: ${error.message}`); return }
  assert.throws(() => requireTemporaryExitDiagnostics({ app: f.app, env: { ...f.paths, DSH_TEST_MODE: '1' }, tempDir: f.temporary, dshHome: f.paths.DSH_HOME }), /new deepseek-exit-dumps/)
  assert.equal(fs.readdirSync(outside).length, 0)
})

test('diagnostic launcher uses a disposable copy, allowlisted environment, and verifiable local-only markers', () => {
  const launcher = fs.readFileSync(path.join(root, 'scripts/diagnose-verify-exit.ps1'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'app/main.js'), 'utf8')
  assert.match(launcher, /robocopy\.exe \$candidateRoot \$runtimeCopy/)
  assert.match(launcher, /EnvironmentVariables\.Clear\(\)/)
  assert.match(launcher, /DSH_WORKSPACE/)
  assert.match(launcher, /WorkingDirectory = \$evidence/)
  assert.match(launcher, /CopyToAsync/)
  assert.match(launcher, /WaitAll\([^\n]+5000\)/)
  assert.match(launcher, /required local exit-diagnostic timeline/)
  assert.match(main, /--diagnose-verify-exit/)
  assert.match(main, /uploadToServer: false/)
  assert.match(main, /diagnostics-configured/)
  assert.match(main, /verify-emitted/)
  assert.match(main, /before-quit/)
  assert.match(main, /server-child-exit/)
  assert.match(main, /main-window-closed/)
  assert.match(main, /will-quit/)
  assert.match(main, /appendFileSync\(exitDiagnostics\.timelinePath/)
  assert.match(main, /const gotLock = EXIT_DIAGNOSTICS \? true : app\.requestSingleInstanceLock\(\)/)
})
