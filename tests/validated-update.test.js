import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const installer = fs.readFileSync(path.join(root, 'scripts', 'install-validated.ps1'), 'utf8')
const updater = fs.readFileSync(path.join(root, 'scripts', 'sync-update.ps1'), 'utf8')
const main = fs.readFileSync(path.join(root, 'app', 'main.js'), 'utf8')

test('updates validate before stopping or replacing the running installation', () => {
  const validation = installer.indexOf("Log 'Running isolated renderer and startup validation'")
  const stop = installer.indexOf('Get-Process -Name DeepSeek')
  const switchInstall = installer.indexOf("Move-Item -LiteralPath $releaseDir -Destination $installDir")
  assert.ok(validation >= 0 && validation < stop)
  assert.ok(stop < switchInstall)
  assert.match(installer, /Model network probe failed/)
})

test('pre-launch activation failure retains the binary rollback path', () => {
  assert.match(installer, /Activation failed; rolling back/)
  assert.match(installer, /Move-Item -LiteralPath \$installDir -Destination \$failedDir/)
  assert.match(installer, /Move-Item -LiteralPath \$backupDir -Destination \$installDir/)
  assert.match(installer, /Updated application did not create a responsive window/)
})

test('possible live writes fence off every automatic downgrade before rollback actions', () => {
  const arm = installer.indexOf('$activationMayHaveWritten = $true')
  const launch = installer.indexOf("Start-Process -FilePath (Join-Path $installDir 'DeepSeek.exe')")
  const guard = installer.indexOf('if ($activationMayHaveWritten)')
  const rollback = installer.indexOf('Log "Activation failed; rolling back:')
  assert.ok(arm >= 0 && arm < launch && launch < guard && guard < rollback)
  const guarded = installer.slice(guard, rollback)
  assert.match(guarded, /\n\s+throw\s*\n/)
  assert.doesNotMatch(guarded, /Move-Item|Start-Process|taskkill/)
})

test('orphan engine writer check precedes installation replacement', () => {
  const guard = installer.indexOf('if ($remainingWriters.Count)')
  const replace = installer.indexOf('Move-Item -LiteralPath $installDir -Destination $backupDir')
  assert.ok(guard >= 0 && guard < replace)
  assert.match(installer, /An installed engine process is still running/)
})

test('activation never closes an active Desktop or forces a process exit', () => {
  assert.match(installer, /\$_.Path -eq \$installedExe/)
  assert.doesNotMatch(installer, /CloseMainWindow|taskkill|Stop-Process/)
  assert.match(installer, /Desktop was reopened during preparation; update deferred/)
})

test('activation allows the engine startup deadline and detects remaining writers', () => {
  assert.match(installer, /AddSeconds\(120\)/)
  assert.match(installer, /ExecutablePath.StartsWith\(\$installDir/)
  assert.match(installer, /remainingWriters.Count/)
})

test('normal installation does not perform legacy cache or session migrations', () => {
  assert.doesNotMatch(installer, /session_projcache/)
  assert.match(installer, /cacheMigrated = \$false/)
  assert.doesNotMatch(installer, /session-pins\.json.*Move-Item/)
  assert.match(installer, /pinsPreserved/)
})

test('renderer gate rejects black content and outer viewport scrolling', () => {
  assert.match(main, /appContentPresent/)
  assert.match(main, /viewportOverflow/)
  assert.match(main, /&& report\.appContentPresent/)
  assert.match(main, /&& !report\.viewportOverflow/)
})

test('successful navigation and second-instance activation reveal hidden windows', () => {
  assert.match(main, /await mainWindow\.loadURL\(authenticatedUrl\)[\s\S]*?!mainWindow\.isVisible\(\)\) mainWindow\.show\(\)/)
  const handler = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf('// ---- window control IPC'))
  assert.ok(handler.indexOf('targetWindow.show()') >= 0)
  assert.ok(handler.indexOf('targetWindow.show()') < handler.indexOf('targetWindow.focus()'))
})

test('legacy source update entry fails closed without building or stopping tasks', () => {
  assert.match(updater, /Source-based updates are retired/)
  assert.match(updater, /exit 2/)
  assert.doesNotMatch(updater, /Start-Process|Stop-Process|merge --|pnpm install|Remove-Item/)
  assert.doesNotMatch(main, /function launchUpdater|raw\.githubusercontent\.com/)
})

test('normal installer requires trusted manifests and refuses active Desktop', () => {
  assert.match(installer, /Trusted candidate and current release manifest hashes are required/)
  assert.match(installer, /Update deferred: close Desktop/)
  assert.match(installer, /Desktop was reopened during preparation; update deferred/)
  assert.ok(installer.indexOf('verifyRelease $candidate') < installer.indexOf('robocopy.exe'))
})
