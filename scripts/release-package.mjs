// Build-time sealing and installation-time verification. No downloads or model calls.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { MANIFEST, sha256, inventory, verifyPackage, validateManifest } = require('../app/lib/release-package.js')
const [operation, rootArg, argument, releaseId] = process.argv.slice(2)
if (!rootArg || !argument || !['seal', 'verify'].includes(operation)) throw Error('Usage: release-package.mjs seal <package> <descriptor.json> | verify <package> <trusted-manifest-sha256>')
const root = path.resolve(rootArg)
if (operation === 'seal') {
  const descriptor = JSON.parse(await fs.readFile(argument, 'utf8'))
  const manifest = validateManifest({ ...descriptor, ...(releaseId ? { releaseId } : {}), files: await inventory(root) })
  const bytes = JSON.stringify(manifest, null, 2) + '\n'
  await fs.writeFile(path.join(root, MANIFEST), bytes, { flag: 'wx' })
  console.log(JSON.stringify({ releaseId: manifest.releaseId, manifestSha256: sha256(bytes), files: Object.keys(manifest.files).length }))
} else {
  const manifest = await verifyPackage(root, argument)
  console.log(JSON.stringify({ ok: true, releaseId: manifest.releaseId, files: Object.keys(manifest.files).length }))
}
