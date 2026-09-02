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

test('activation failure restores the previous installation and relaunches it', () => {
  assert.match(installer, /Activation failed; rolling back/)
  assert.match(installer, /Move-Item -LiteralPath \$installDir -Destination \$failedDir/)
  assert.match(installer, /Move-Item -LiteralPath \$backupDir -Destination \$installDir/)
  assert.match(installer, /Updated application did not create a responsive window/)
})

test('cache migration is version-gated and preserves desktop-owned pins', () => {
  assert.match(installer, /\$needsAlpha4Migration/)
  assert.match(installer, /session_projcache/)
  assert.doesNotMatch(installer, /session-pins\.json.*Move-Item/)
  assert.match(installer, /pinsPreserved/)
})

test('renderer gate rejects black content and outer viewport scrolling', () => {
  assert.match(main, /appContentPresent/)
  assert.match(main, /viewportOverflow/)
  assert.match(main, /&& report\.appContentPresent/)
  assert.match(main, /&& !report\.viewportOverflow/)
})

test('sync updater delegates activation to the validated installer', () => {
  assert.match(updater, /install-validated\.ps1/)
  assert.match(updater, /validated install failed; previous installation retained or restored/)
})
