'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const { validateReady, readReady, validatorFingerprint, environment } = require('../scripts/lib/ready-release.cjs')
const { sha256 } = require('../app/lib/release-package')
const base = path.join(os.tmpdir(), 'synthetic-programs')
const installDir = path.join(base, 'DeepSeek')
function receipt() {
  return { schema: 1, status: 'ready', installDir, candidate: path.join(base, 'DeepSeek.candidate-test'), manifestSha256: '1'.repeat(64), currentManifestSha256: '2'.repeat(64), validatorFingerprint: 'tool-version', environment: 'test-host', kind: 'desktop', createdAt: 1000, expiresAt: 2000, checks: ['renderer', 'screenshot'] }
}
const options = { installDir, validator: 'tool-version', host: 'test-host', now: 1500 }
test('receipt binds the validated host, installation, package digests and checks', () => {
  assert.equal(validateReady(receipt(), options).status, 'ready')
  for (const change of [{ validatorFingerprint: 'different' }, { environment: 'different' }, { installDir: base }, { candidate: path.join(base, 'other') }, { checks: ['renderer'] }, { kind: 'migration' }, { manifestSha256: 'bad' }]) {
    assert.throws(() => validateReady({ ...receipt(), ...change }, options))
  }
})
test('expired, future-dated and excessive-lifetime receipts require fresh preparation', () => {
  for (const change of [{ expiresAt: 1500 }, { createdAt: 1600 }, { expiresAt: 1000 + 8 * 86400000 }]) {
    assert.throws(() => validateReady({ ...receipt(), ...change }, options), /expired|clock/)
  }
})
test('receipt content tampering is rejected before any package execution', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-release-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'receipt.json')
  const bytes = JSON.stringify({ ...receipt(), validatorFingerprint: await validatorFingerprint(), environment: environment(), createdAt: Date.now() - 1000, expiresAt: Date.now() + 10000 })
  await fs.writeFile(file, bytes)
  assert.equal((await readReady(file, sha256(bytes), installDir)).kind, 'desktop')
  await fs.writeFile(file, bytes.replace('"kind":"desktop"', '"kind":"engine"'))
  await assert.rejects(readReady(file, sha256(bytes), installDir), /digest mismatch/)
})
test('prepared activation skips copying and rechecks bytes before replacing directories', async () => {
  const installer = await fs.readFile(path.join(__dirname, '../scripts/install-validated.ps1'), 'utf8')
  assert.match(installer, /if \(\$PreparedReceipt\) \{\s+\$releaseDir = \$candidate/)
  const verify = installer.indexOf('$classificationOutput = & node $verifyRelease')
  const ready = installer.indexOf('if ($PrepareOnly) {', verify)
  const replace = installer.indexOf('Move-Item -LiteralPath $installDir -Destination $backupDir')
  assert.ok(verify >= 0 && ready > verify && replace > ready)
  assert.match(installer.slice(ready, replace), /\n\s+return\s*\n/)
  assert.match(installer, /This exact release is already installed/)
})
