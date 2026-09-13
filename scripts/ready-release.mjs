import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { environment, validatorFingerprint, readReady, validateReady } = require('./lib/ready-release.cjs')
const { sha256 } = require('../app/lib/release-package')
const [operation, file, ...args] = process.argv.slice(2)
if (operation === 'check') {
  const [digest, installDir] = args
  console.log(JSON.stringify(await readReady(file, digest, installDir)))
} else if (operation === 'record') {
  // Called by the trusted installer only AFTER its isolated checks pass.
  // This unsigned local receipt needs an independently retained trusted digest.
  const [candidate, digest, installDir, currentDigest, kind] = args
  const now = Date.now()
  const record = { schema: 1, status: 'ready', candidate: path.resolve(candidate), installDir: path.resolve(installDir), manifestSha256: digest, currentManifestSha256: currentDigest, kind,
    createdAt: now, expiresAt: now + 7 * 86400000, environment: environment(), validatorFingerprint: await validatorFingerprint(), checks: ['renderer', 'screenshot'] }
  validateReady(record, { installDir, validator: record.validatorFingerprint })
  const bytes = JSON.stringify(record, null, 2) + '\n'
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ ...record, receipt: path.resolve(file), receiptSha256: sha256(bytes) }))
} else throw Error('Usage: ready-release.mjs check <receipt> <trusted-sha256> <installation> | record <receipt> <candidate> <manifest-sha256> <installation> <current-manifest-sha256> <kind>')
