// Candidate-only closure and artifact evidence for the r10 runtime.
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [stageArg, runtimeArg, outputArg] = process.argv.slice(2)
if (!stageArg || !runtimeArg || !outputArg) {
  throw new Error('Usage: verify-runtime-closure-r10-performance-guard.mjs <stage> <flat-runtime> <evidence-json>')
}
const stage = path.resolve(stageArg)
const runtime = path.resolve(runtimeArg)
const output = path.resolve(outputArg)
const receipt = JSON.parse(await readFile(path.join(stage, '.r10-materialization.json'), 'utf8'))

const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const criticalSha256 = {}
for (const [relative, expected] of Object.entries(receipt.criticalSha256)) {
  const actual = await hashFile(path.join(runtime, ...relative.split('/')))
  if (actual !== expected) throw new Error(`Flattened critical file differs from materialized build: ${relative}`)
  criticalSha256[relative] = actual
}

let directories = 0
let files = 0
let bytes = 0
const links = []
async function scan(candidate) {
  for (const entry of await readdir(candidate, { withFileTypes: true })) {
    const absolute = path.join(candidate, entry.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) links.push(absolute)
    else if (info.isDirectory()) {
      directories += 1
      await scan(absolute)
    } else {
      files += 1
      bytes += info.size
    }
  }
}
await scan(runtime)
if (links.length) throw new Error(`Flattened runtime contains ${links.length} link(s)`)
for (const forbidden of ['node_modules/.pnpm', '.dsh-junctions.json', '.dsh-junction-root']) {
  if (await stat(path.join(runtime, ...forbidden.split('/'))).then(() => true, () => false)) {
    throw new Error(`Flattened runtime contains forbidden pnpm/link metadata: ${forbidden}`)
  }
}

async function dependencyDir(from, dependency) {
  let current = from
  while (true) {
    const candidate = path.join(current, 'node_modules', ...dependency.split('/'))
    if (await stat(candidate).then(value => value.isDirectory(), () => false)) {
      const resolved = await realpath(candidate)
      const relative = path.relative(runtime, resolved)
      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Dependency escapes the flattened runtime: ${dependency}`)
      }
      return resolved
    }
    if (current.toLowerCase() === runtime.toLowerCase()) return undefined
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

const roots = [runtime, ...Object.keys(receipt.packages)
  .filter(name => name !== '@deepseek-ai/dsh')
  .map(name => path.join(runtime, 'node_modules', ...name.split('/')))]
const queue = [...roots]
const visited = new Set()
const missingOptional = []
const missingRequired = []
let checkedEdges = 0
while (queue.length) {
  const packageDir = queue.shift()
  const key = packageDir.toLowerCase()
  if (visited.has(key)) continue
  visited.add(key)
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
  const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}))
  for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    if (meta?.optional) optional.add(name)
  }
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  }
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('node:')) continue
    checkedEdges += 1
    const resolved = await dependencyDir(packageDir, name)
    if (!resolved) {
      if (optional.has(name)) {
        missingOptional.push({ package: manifest.name, dependency: name })
        continue
      }
      missingRequired.push({ package: manifest.name, dependency: name })
      continue
    }
    queue.push(resolved)
  }
}

for (const required of [
  'config/agent-presets',
  'node_modules/@deepseek-ai/dsh-agent-presets/presets',
]) {
  if (!await stat(path.join(runtime, ...required.split('/'))).then(value => value.isDirectory(), () => false)) {
    throw new Error(`Runtime configuration asset is missing: ${required}`)
  }
}

const evidence = {
  schema: 1,
  runtime,
  stageReceipt: path.join(stage, '.r10-materialization.json'),
  rosterPackages: Object.keys(receipt.packages).length,
  dependencyPresenceClosure: {
    reachablePackageInstances: visited.size,
    checkedDependencyEdges: checkedEdges,
    missingRequired,
  },
  missingOptional,
  inventory: { directories, files, bytes, links: 0 },
  criticalSha256,
}
await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`)
const ok = missingRequired.length === 0
console.log(JSON.stringify({ ok, output, ...evidence.inventory, reachablePackageInstances: visited.size, checkedDependencyEdges: checkedEdges, missingRequired: missingRequired.length, missingOptional: missingOptional.length }))
if (!ok) process.exitCode = 1
