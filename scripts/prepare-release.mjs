// Prepare a LOCAL authenticated artifact without stopping Desktop or touching DSH_HOME.
// The digest must come from the trusted release producer, not be computed from an unknown download.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { constants } from 'node:fs'
const require = createRequire(import.meta.url)
const { verifyPackage, classifyUpdate, inventory, MANIFEST, sha256 } = require('../app/lib/release-package.js')
const [candidateArg, digest, currentArg, currentDigest, cacheArg] = process.argv.slice(2)
if (!cacheArg) throw Error('Usage: prepare-release.mjs <candidate> <trusted-sha256> <current-package> <current-trusted-sha256> <cache-root>')
const candidate = path.resolve(candidateArg)
const current = await verifyPackage(path.resolve(currentArg), currentDigest)
const next = await verifyPackage(candidate, digest)
if (current.releaseId === next.releaseId) throw Error('Release IDs are immutable; choose a new ID for an update')
const classification = classifyUpdate(current, next)
if (!['desktop', 'engine'].includes(classification.kind)) throw Error(classification.reason)
const cache = path.resolve(cacheArg)
if ([candidate, path.resolve(currentArg)].some(p => cache === p || cache.startsWith(p + path.sep) || p.startsWith(cache + path.sep))) throw Error('Cache must be separate from packages')
await fs.mkdir(cache, { recursive: true })
if ((await fs.lstat(cache)).isSymbolicLink()) throw Error('Cache root must not be a link')
const target = path.join(cache, next.releaseId)
const partial = path.join(cache, `${next.releaseId}.partial`)
const exists = p => fs.lstat(p).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
if (!await exists(target)) {
  await fs.mkdir(partial, { recursive: true })
  const copied = await inventory(partial)
  for (const [name, hash] of Object.entries(copied)) {
    if (next.files[name] !== hash) throw Error(`Interrupted preparation contains unexpected content: ${name}`)
  }
  // Resume verified chunks, never overwrite them or execute package contents.
  const missing = Object.keys(next.files).filter(name => !copied[name])
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, missing.length) }, async () => {
    while (cursor < missing.length) {
      const name = missing[cursor++]
      const destination = path.join(partial, name)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(path.join(candidate, name), destination, constants.COPYFILE_EXCL)
    }
  }))
  if (await exists(path.join(partial, MANIFEST))) {
    if (sha256(await fs.readFile(path.join(partial, MANIFEST))) !== digest) throw Error('Interrupted manifest differs')
  } else await fs.copyFile(path.join(candidate, MANIFEST), path.join(partial, MANIFEST), constants.COPYFILE_EXCL)
  await verifyPackage(partial, digest)
  await fs.rename(partial, target)
}
await verifyPackage(target, digest)
const result = { schema: 1, status: 'prepared', releaseId: next.releaseId, candidate: target, manifestSha256: digest, currentManifestSha256: currentDigest, kind: classification.kind }
const receipt = path.join(cache, `${next.releaseId}.prepared.json`)
if (await exists(receipt)) {
  if (JSON.stringify(JSON.parse(await fs.readFile(receipt, 'utf8'))) !== JSON.stringify(result)) throw Error('Existing preparation receipt differs')
} else await fs.writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(result))
