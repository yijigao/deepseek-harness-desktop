// Candidate-only helper: materialize built workspace packages before flattening.
import { cp, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import {
  selectRuntimeWorkspaceRoster,
  trustedPackageManifestRelative,
} from './lib/select-runtime-workspace-roster.mjs'

const [checkoutArg, targetArg, ...optionArgs] = process.argv.slice(2)
const options = { explicitPackages: [] }
for (let index = 0; index < optionArgs.length; index += 2) {
  const flag = optionArgs[index]
  const value = optionArgs[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag ?? 'option'}`)
  if (flag === '--trusted-release') options.trustedRelease = value
  else if (flag === '--trusted-manifest-sha256') options.trustedManifestSha256 = value.toLowerCase()
  else if (flag === '--explicit-package') options.explicitPackages.push(value)
  else throw new Error(`Unknown option: ${flag}`)
}
if (!checkoutArg || !targetArg || !options.trustedRelease || !options.trustedManifestSha256) {
  throw new Error('Usage: materialize-runtime-r10-performance-guard.mjs <built-checkout> <new-runtime-source> --trusted-release <win-unpacked> --trusted-manifest-sha256 <sha256> [--explicit-package <name>]')
}

const checkout = path.resolve(checkoutArg)
const target = path.resolve(targetArg)
const trustedRelease = path.resolve(options.trustedRelease)
const trustedManifestPath = path.join(trustedRelease, 'desktop-release.json')
const expectedRoster = ['vendor/*', 'packages/*/*', 'apps/cli']
const tsdownConfig = await readFile(path.join(checkout, 'tsdown.config.ts'), 'utf8')
if (!tsdownConfig.includes(`workspace: ['${expectedRoster.join("', '")}']`)) {
  throw new Error('Checkout tsdown roster does not contain the expected release package roots in order')
}
try {
  await lstat(target)
  throw new Error('Target must not exist')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const packageDirs = []
for (const entry of await readdir(path.join(checkout, 'vendor'), { withFileTypes: true })) {
  if (entry.isDirectory()) packageDirs.push(path.join(checkout, 'vendor', entry.name))
}
for (const group of await readdir(path.join(checkout, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const entry of await readdir(path.join(checkout, 'packages', group.name), { withFileTypes: true })) {
    if (entry.isDirectory()) packageDirs.push(path.join(checkout, 'packages', group.name, entry.name))
  }
}
const cli = path.join(checkout, 'apps', 'cli')
packageDirs.push(cli)
// These required workspace dependencies sit outside tsdown's package roster:
// the browser distribution is built by Vite and the native entry selects its
// platform package at runtime. Unsupported Linux payloads remain optional.
packageDirs.push(
  path.join(checkout, 'apps', 'web'),
  path.join(checkout, 'native', 'landlock-run', 'packages', 'entry'),
)

async function exists(candidate) {
  return stat(candidate).then(() => true, () => false)
}

async function assertBuiltPackage(packageDir, manifest) {
  if (!manifest.name || !Array.isArray(manifest.files)) {
    throw new Error(`Release package must declare a name and files: ${packageDir}`)
  }
  if (!await exists(path.join(packageDir, 'lib'))) throw new Error(`Built lib is missing: ${manifest.name}`)
  const visit = value => {
    if (typeof value === 'string') return [value]
    if (!value || typeof value !== 'object') return []
    return Object.values(value).flatMap(visit)
  }
  for (const exported of visit([manifest.main, manifest.module, manifest.bin, manifest.exports])) {
    if (!exported.startsWith('./') || exported.includes('*') || exported.endsWith('.d.ts')) continue
    if (!await exists(path.join(packageDir, exported))) {
      throw new Error(`Exported release output is missing: ${manifest.name}/${exported}`)
    }
  }
}

async function copyEntry(source, destination) {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error(`Release input contains a link: ${source}`)
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    filter: async candidate => {
      const base = path.basename(candidate)
      if (base === 'node_modules' || base === 'tests' || base === 'test' || base === '__tests__') return false
      return !(await lstat(candidate)).isSymbolicLink()
    },
  })
}

async function copyBuiltPackage(packageDir, manifest, destination) {
  await mkdir(destination, { recursive: true })
  const selected = new Set(['package.json'])
  for (const declared of manifest.files) {
    if (!declared.startsWith('!')) selected.add(declared.split('/')[0])
  }
  if (packageDir === cli) selected.add('config')
  for (const entry of await readdir(packageDir, { withFileTypes: true })) {
    if (/^(?:README(?:\..*)?|LICENSE(?:\..*)?|NOTICE(?:\..*)?)$/i.test(entry.name)) selected.add(entry.name)
  }
  for (const entry of [...selected].sort()) {
    const source = path.join(packageDir, entry)
    if (!await exists(source)) throw new Error(`Selected release content is missing: ${manifest.name}/${entry}`)
    await copyEntry(source, path.join(destination, entry))
  }
}

const records = []
const seen = new Set()
for (const packageDir of packageDirs) {
  const manifestPath = path.join(packageDir, 'package.json')
  if (!await exists(manifestPath)) continue
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await assertBuiltPackage(packageDir, manifest)
  if (seen.has(manifest.name)) throw new Error(`Duplicate workspace package name: ${manifest.name}`)
  seen.add(manifest.name)
  records.push({ packageDir, manifest })
}

const trustedManifestBytes = await readFile(trustedManifestPath)
const trustedManifestSha256 = createHash('sha256').update(trustedManifestBytes).digest('hex')
if (trustedManifestSha256 !== options.trustedManifestSha256) {
  throw new Error(`Trusted release manifest hash mismatch: expected ${options.trustedManifestSha256}, got ${trustedManifestSha256}`)
}
const trustedManifest = JSON.parse(trustedManifestBytes.toString('utf8'))
if (!trustedManifest.files || Array.isArray(trustedManifest.files) || typeof trustedManifest.files !== 'object') {
  throw new Error('Trusted release manifest does not contain a file hash map')
}

const cliManifest = records.find(record => record.packageDir === cli)?.manifest
if (!cliManifest) throw new Error('CLI package is absent from the materialization roster')
const trustedRootNames = new Set()
for (const { manifest } of records) {
  if (manifest.name === cliManifest.name) continue
  const relative = trustedPackageManifestRelative(manifest.name)
  const expectedHash = trustedManifest.files[relative]
  if (!expectedHash) continue
  const trustedPackageManifestPath = path.join(trustedRelease, ...relative.split('/'))
  const trustedPackageManifestBytes = await readFile(trustedPackageManifestPath)
  const actualHash = createHash('sha256').update(trustedPackageManifestBytes).digest('hex')
  if (actualHash !== expectedHash) {
    throw new Error(`Trusted runtime package manifest hash mismatch: ${relative}`)
  }
  const trustedPackageManifest = JSON.parse(trustedPackageManifestBytes.toString('utf8'))
  if (trustedPackageManifest.name !== manifest.name) {
    throw new Error(`Trusted runtime package name mismatch: ${relative}`)
  }
  trustedRootNames.add(manifest.name)
}

const selection = selectRuntimeWorkspaceRoster({
  records,
  trustedRootNames,
  cliName: cliManifest.name,
  explicitRootNames: options.explicitPackages,
})
const selectedNames = new Set(selection.selectedNames)
const selectedRecords = records.filter(({ manifest }) => selectedNames.has(manifest.name))

for (const { packageDir, manifest } of selectedRecords) {
  const destination = packageDir === cli
    ? target
    : path.join(target, 'node_modules', ...manifest.name.split('/'))
  await copyBuiltPackage(packageDir, manifest, destination)
}

const nestedCli = path.join(target, 'node_modules', ...cliManifest.name.split('/'))
await copyBuiltPackage(cli, cliManifest, nestedCli)

const agentPresetsSource = path.join(checkout, 'packages', 'preset', 'agent-presets', 'presets')
const agentPresetsTarget = path.join(target, 'config', 'agent-presets')
if (!await exists(agentPresetsSource)) throw new Error('Agent preset config tree source is missing')
await copyEntry(agentPresetsSource, agentPresetsTarget)
await copyEntry(agentPresetsSource, path.join(nestedCli, 'config', 'agent-presets'))

if (!await exists(path.join(target, 'lib', 'bin.js'))) throw new Error('Materialized CLI entry is missing')
const critical = [
  'lib/bin.js',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json',
  'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
  'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/task-policy.js',
  'node_modules/@deepseek-ai/dsh-llm/lib/index.js',
  'node_modules/@deepseek-ai/dsh-llm/lib/task-policy.js',
  'node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js',
  'node_modules/@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js',
  'node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js',
  'node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js',
  'node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js',
  'node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js',
  'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
  'node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js',
]
const hashes = {}
for (const relative of critical) {
  const bytes = await readFile(path.join(target, ...relative.split('/')))
  hashes[relative] = createHash('sha256').update(bytes).digest('hex')
}
const evidence = {
  schema: 2,
  checkout,
  target,
  trustedRelease: {
    path: trustedRelease,
    releaseId: trustedManifest.releaseId,
    manifestSha256: trustedManifestSha256,
  },
  availablePackageCount: records.length,
  trustedRootCount: trustedRootNames.size,
  explicitProductionRoots: [...options.explicitPackages].sort(),
  roster: {
    selectedCount: selection.selectedNames.length,
    selectedNames: selection.selectedNames,
    reasons: selection.reasons,
    excludedCount: selection.excludedNames.length,
    excludedNames: selection.excludedNames,
  },
  packages: Object.fromEntries(selectedRecords.map(({ packageDir, manifest }) => [manifest.name, path.relative(checkout, packageDir).replaceAll('\\', '/')])),
  configTrees: {
    'config/agent-presets': path.relative(checkout, agentPresetsSource).replaceAll('\\', '/'),
  },
  nestedCli: 'node_modules/@deepseek-ai/dsh',
  criticalSha256: hashes,
}
await writeFile(path.join(target, '.r10-materialization.json'), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(JSON.stringify({
  checkout,
  target,
  availablePackages: seen.size,
  trustedRoots: trustedRootNames.size,
  selectedPackages: selection.selectedNames.length,
  excludedPackages: selection.excludedNames.length,
  evidence: path.join(target, '.r10-materialization.json'),
}))
