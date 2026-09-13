import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { inventory, sha256, validateManifest } = require('../app/lib/release-package.js')

if (process.argv[2] === '--spec') {
  const [input, output] = process.argv.slice(3)
  if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output)) throw Error('Absolute audit and output paths required')
  const raw = await fs.readFile(input)
  if (sha256(raw) !== 'c5a72b7d0818d243c2b5de31f2d2014fba783947b5f63cd86953b5d7a583785d') throw Error('Audited inventory changed')
  const audit = JSON.parse(raw)
  const spec = {
    installRoot: audit.installRoot, workspaceRoot: audit.recoveryRoot,
    backupRoot: path.dirname(audit.maintenanceRoot),
    trustedManifestPath: path.join(audit.installRoot, 'desktop-release.json'),
    trustedManifestSha256: audit.trustedManifestSha256,
    expectedStaticFileCount: audit.originalFileCount,
    allowedChangedFile: { relPath: audit.staticChanges[0].path, expectedSha256: audit.staticChanges[0].originalSha256, currentSha256: audit.staticChanges[0].sha256 },
    extras: audit.extras.map(e => ({ relPath: e.relativePath, sha256: e.sha256, size: e.size, category: ({ business: 'root-business', wecom: 'wecom-data', maintenance: 'runtime-backup' })[e.category], targetPath: e.destination })),
    adopted: { releaseId: 'desktop-2.2.0-alpha2-r7-adopted-header-20260912', patchsetSha256: audit.patchsetSha256 },
  }
  await fs.writeFile(output, JSON.stringify(spec, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ specPath: output, specSha256: sha256(await fs.readFile(output)), extras: spec.extras.length }))
  process.exit(0)
}

const [installArg, recoveryArg, maintenanceArg, outputArg] = process.argv.slice(2)
if (![installArg, recoveryArg, maintenanceArg, outputArg].every(p => p && path.isAbsolute(p))) throw Error('Four absolute paths required')
const installRoot = path.resolve(installArg)
const recoveryRoot = path.resolve(recoveryArg)
const maintenanceRoot = path.resolve(maintenanceArg)
const trustedManifestSha256 = '4e6d46e540855ebf6a0335d4f132c7f2980da6d981f66277681e2246198a41ca'
const bytes = await fs.readFile(path.join(installRoot, 'desktop-release.json'))
if (sha256(bytes) !== trustedManifestSha256) throw Error('Original r7 manifest changed')
const original = validateManifest(JSON.parse(bytes))
const actual = await inventory(installRoot)
const headerPath = 'resources/runtime/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'
const headerHash = '7e0043e750cc61cf886414be96e5f51ce4aa883f6be3ca1f17fbb2607861a5ce'
const changed = Object.entries(original.files).filter(([p, hash]) => actual[p] !== hash).map(([p, hash]) => ({ path: p, originalSha256: hash, sha256: actual[p] ?? null }))
if (changed.length !== 1 || changed[0].path !== headerPath || changed[0].sha256 !== headerHash) throw Error('Unexpected static drift; no migration plan produced')
const extras = []
for (const [relativePath, hash] of Object.entries(actual)) {
  if (Object.hasOwn(original.files, relativePath)) continue
  let category
  if (!relativePath.includes('/') && /\.(?:py|json|txt|png)$/i.test(relativePath)) category = 'business'
  else if (relativePath.startsWith('.dsh/wecom-cli/')) category = 'wecom'
  else if (['resources/runtime/node_modules/@deepseek-ai/dsh-settings/lib/index.js.bak', 'resources/runtime/node_modules/@deepseek-ai/dsh-settings/lib/index.js.shim-legacy-20260911'].includes(relativePath)) category = 'maintenance'
  else throw Error('Unapproved extra-file category: ' + relativePath)
  const stat = await fs.lstat(path.join(installRoot, relativePath))
  const destination = path.join(category === 'maintenance' ? maintenanceRoot : recoveryRoot, relativePath)
  extras.push({ relativePath, sha256: hash, size: stat.size, category, destination })
}
const audit = {
  schema: 1, createdAt: new Date().toISOString(), installRoot, recoveryRoot, maintenanceRoot,
  trustedManifestSha256, originalReleaseId: original.releaseId, originalFileCount: Object.keys(original.files).length,
  staticChanges: changed, versionSha256: actual['resources/version.json'],
  patchsetSha256: '3c08a08037f4f1e31d2aa12458222b5c56401cfbb04b2cea8b6d7f7d7ba4250f',
  extras,
}
await fs.writeFile(outputArg, JSON.stringify(audit, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ auditPath: outputArg, auditSha256: sha256(await fs.readFile(outputArg)), originalFileCount: audit.originalFileCount, extraCount: extras.length, bytes: extras.reduce((s, e) => s + e.size, 0), categories: Object.fromEntries(['business', 'wecom', 'maintenance'].map(c => [c, extras.filter(e => e.category === c).length])), staticChanges: changed }))
