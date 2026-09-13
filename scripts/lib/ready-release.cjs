'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { sha256 } = require('../../app/lib/release-package')
const root = path.resolve(__dirname, '../..')
const hashPattern = /^[a-f0-9]{64}$/
const environment = () => `${process.platform}/${process.arch}/${os.release()}/${process.versions.node}`
const canonical = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)

async function validatorFingerprint() {
  const files = ['scripts/install-validated.ps1', 'scripts/verify-update.mjs', 'scripts/ready-release.mjs', 'scripts/lib/ready-release.cjs', 'app/lib/release-package.js']
  const hashes = await Promise.all(files.map(async name => [name, sha256(await fs.readFile(path.join(root, name)))]))
  return sha256(JSON.stringify(hashes))
}

function validateReady(record, { installDir, validator, now = Date.now(), host = environment() }) {
  if (record?.schema !== 1 || record.status !== 'ready' || !hashPattern.test(record.manifestSha256 || '') || !hashPattern.test(record.currentManifestSha256 || '')) throw Error('Invalid ready receipt')
  if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || record.createdAt > now || record.expiresAt <= now || record.expiresAt - record.createdAt > 7 * 86400000) throw Error('Preparation expired or has an invalid clock')
  if (record.validatorFingerprint !== validator || record.environment !== host) throw Error('Validation tools or host changed; prepare again')
  if (typeof record.installDir !== 'string' || canonical(record.installDir) !== canonical(installDir)) throw Error('Receipt belongs to a different installation')
  if (typeof record.candidate !== 'string' || canonical(path.dirname(record.candidate)) !== canonical(path.dirname(installDir)) || !/^DeepSeek\.candidate-[a-z0-9-]+$/i.test(path.basename(record.candidate))) throw Error('Prepared package must be an installation sibling')
  if (!Array.isArray(record.checks) || record.checks.join(',') !== 'renderer,screenshot') throw Error('Required validation checks are missing')
  if (!['desktop', 'engine'].includes(record.kind)) throw Error('Unsupported update class')
  return record
}

async function readReady(file, expectedHash, installDir, options = {}) {
  if (!hashPattern.test(expectedHash || '')) throw Error('A trusted preparation receipt SHA-256 is required')
  if ((await fs.lstat(file)).isSymbolicLink()) throw Error('Receipt must not be a link')
  const bytes = await fs.readFile(file)
  if (sha256(bytes) !== expectedHash) throw Error('Preparation receipt digest mismatch')
  return validateReady(JSON.parse(bytes), { installDir, validator: await validatorFingerprint(), ...options })
}

module.exports = { environment, validatorFingerprint, validateReady, readReady }
