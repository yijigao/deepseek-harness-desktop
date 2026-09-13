/**
 * flatten-runtime.mjs — convert the pnpm junction layout into a flat,
 * junction-free node_modules. Every real package instance under
 * .pnpm/<key>/node_modules/<name> is hoisted to node_modules/<name>; when a
 * name has several versions, the highest wins top-level and the others are
 * nested as real copies under the packages whose dependency ranges demand
 * them (resolution then walks up: nested → parent → top-level).
 *
 * Usage: node flatten-runtime.mjs <srcRuntime> <dstRuntime> [--dependency-root <checkoutRoot>]
 */
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import process from 'node:process'

const [srcArg, dstArg, ...extraArgs] = process.argv.slice(2)
if (!srcArg || !dstArg || srcArg.startsWith('--') || dstArg.startsWith('--')
  || (extraArgs.length !== 0 && (extraArgs.length !== 2
    || extraArgs[0] !== '--dependency-root' || !extraArgs[1] || extraArgs[1].startsWith('--')))) {
  console.error('usage: node flatten-runtime.mjs <srcRuntime> <dstRuntime> [--dependency-root <checkoutRoot>]')
  process.exit(2)
}
const src = path.resolve(srcArg)
const dst = path.resolve(dstArg)
const dependencyRoot = extraArgs.length === 0 ? src : path.resolve(extraArgs[1])
const pnpmRoot = path.join(dependencyRoot, 'node_modules', '.pnpm')

// Validate inputs before touching the destination. A separate dependency root
// supplies only its virtual store; runtime files and materialized workspace
// packages always come from src.
const inside = (base, candidate) => {
  const relative = path.relative(base, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
if (inside(src, dst) || inside(dst, src) || inside(dependencyRoot, dst) || inside(dst, dependencyRoot)) {
  throw new Error('runtime destination must not overlap either source root')
}
if (!(await stat(pnpmRoot).then(value => value.isDirectory(), () => false))) {
  throw new Error(`pnpm dependency store missing: ${pnpmRoot}`)
}

// semver lives in the dshexe/app devDependencies (electron-builder pulls it).
const require2 = createRequire(new URL('../app/package.json', import.meta.url))
let semver
try {
  semver = require2('semver')
} catch {
  console.error('semver package required (install it in the dshexe/app node_modules)')
  process.exit(3)
}

const isRealDir = async (p) => {
  try {
    const s = await lstat(p)
    return s.isDirectory() && !s.isSymbolicLink()
  } catch {
    return false
  }
}

/** (name, version) of a package directory. */
async function identity(dir) {
  try {
    const json = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
    return { name: json.name, version: json.version ?? '0.0.0' }
  } catch {
    return { name: undefined, version: '0.0.0' }
  }
}

/** Collect real package instances: top-level hoisted dirs + .pnpm instances. */
async function collectInstances() {
  const instances = [] // { name, version, dir, sourceOwned }
  const seen = new Set()
  const push = async (dir, nameHint, sourceOwned) => {
    if (!(await isRealDir(dir))) return
    const packageIdentity = await identity(dir)
    const name = nameHint ?? packageIdentity.name
    const version = packageIdentity.version
    if (!name || !packageIdentity.name) return
    const key = `${name}@${version}`
    if (seen.has(key)) return
    seen.add(key)
    instances.push({ name, version, dir, sourceOwned })
  }

  // existing top-level real dirs (deploy hoist + augmented copies)
  const top = path.join(src, 'node_modules')
  for (const scope of await readdir(top, { withFileTypes: true })) {
    if (!scope.isDirectory() || scope.name.startsWith('.')) continue
    if (scope.name.startsWith('@')) {
      for (const sub of await readdir(path.join(top, scope.name), { withFileTypes: true })) {
        if (sub.isDirectory()) await push(path.join(top, scope.name, sub.name), undefined, true)
      }
    } else {
      await push(path.join(top, scope.name), undefined, true)
    }
  }

  // .pnpm virtual store instances
  const pnpm = pnpmRoot
  for (const key of await readdir(pnpm, { withFileTypes: true })) {
    if (!key.isDirectory()) continue
    const nm = path.join(pnpm, key.name, 'node_modules')
    let scopes
    try { scopes = await readdir(nm, { withFileTypes: true }) } catch { continue }
    for (const scope of scopes) {
      if (!scope.isDirectory() || scope.name.startsWith('.')) continue
      if (scope.name.startsWith('@')) {
        for (const sub of await readdir(path.join(nm, scope.name), { withFileTypes: true })) {
          if (sub.isDirectory()) await push(path.join(nm, scope.name, sub.name), `${scope.name}/${sub.name}`, false)
        }
      } else {
        await push(path.join(nm, scope.name), scope.name, false)
      }
    }
  }
  return instances
}

const cmpVersions = (a, b) => {
  const av = semver.valid(a)
  const bv = semver.valid(b)
  if (av && bv) return semver.rcompare(av, bv)
  return String(b).localeCompare(String(a))
}

const npmAlias = (range) => {
  if (!range.startsWith('npm:')) return undefined
  const match = range.match(/^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/)
  return match ? { actualName: match[1], range: match[2] } : undefined
}

const comparableRange = (range) => {
  return npmAlias(range)?.range ?? range
}

const platformAllows = (values, current) => {
  if (!Array.isArray(values) || values.length === 0) return true
  if (values.includes(`!${current}`)) return false
  const positive = values.filter(value => !value.startsWith('!'))
  return positive.length === 0 || positive.includes(current)
}

async function platformCompatibleInstance(inst) {
  const manifest = JSON.parse(await readFile(path.join(inst.dir, 'package.json'), 'utf8'))
  return platformAllows(manifest.os, process.platform)
    && platformAllows(manifest.cpu, process.arch)
}

async function compatibleAliasInstance(inst, range) {
  return await platformCompatibleInstance(inst)
    && semver.satisfies(semver.valid(inst.version) ?? inst.version, comparableRange(range), { loose: true })
}

async function copyPackageContent(from, to) {
  await rm(to, { recursive: true, force: true })
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    dereference: true,
    errorOnExist: false,
    force: true,
    filter: (source) => {
      const base = path.basename(source)
      if (base === 'node_modules' || base === 'tests') return false
      try { return !lstatSync(source).isSymbolicLink() } catch { return false }
    },
  })
}

const collectedInstances = await collectInstances()
console.log(`collected ${collectedInstances.length} real package instances`)
let instances = collectedInstances
if (extraArgs.length > 0) {
  // A separate checkout store contains build/test dependencies that are not
  // part of the runtime. Materialized packages are roots because config can
  // load them dynamically; retain only their transitive runtime dependencies.
  const eligibleInstances = []
  for (const inst of collectedInstances) {
    if (inst.sourceOwned || await platformCompatibleInstance(inst)) eligibleInstances.push(inst)
  }
  const availableByName = new Map()
  for (const inst of eligibleInstances) {
    const list = availableByName.get(inst.name) ?? []
    list.push(inst)
    availableByName.set(inst.name, list)
  }
  const reachableNames = new Set(collectedInstances.filter(inst => inst.sourceOwned).map(inst => inst.name))
  const reachabilityQueue = [src, ...collectedInstances.filter(inst => inst.sourceOwned).map(inst => inst.dir)]
  const inspected = new Set()
  while (reachabilityQueue.length > 0) {
    const current = reachabilityQueue.shift()
    if (inspected.has(current)) continue
    inspected.add(current)
    for (const [name, range] of Object.entries(await depSpecs(current))) {
      const alias = npmAlias(range)
      if (alias) {
        const aliasInstances = availableByName.get(name) ?? []
        const existingVersions = new Set(aliasInstances.map(inst => inst.version))
        const added = []
        for (const inst of availableByName.get(alias.actualName) ?? []) {
          if (!existingVersions.has(inst.version) && await compatibleAliasInstance(inst, range)) {
            added.push({ ...inst, name })
            existingVersions.add(inst.version)
          }
        }
        if (added.length > 0) {
          aliasInstances.push(...added)
          availableByName.set(name, aliasInstances)
          eligibleInstances.push(...added)
        }
        if (!reachableNames.has(name)) {
          reachableNames.add(name)
          for (const inst of aliasInstances) reachabilityQueue.push(inst.dir)
        } else {
          for (const inst of added) reachabilityQueue.push(inst.dir)
        }
        continue
      }
      if (reachableNames.has(name)) continue
      reachableNames.add(name)
      for (const inst of availableByName.get(name) ?? []) reachabilityQueue.push(inst.dir)
    }
  }
  instances = eligibleInstances.filter(inst => inst.sourceOwned || reachableNames.has(inst.name))
  console.log(`retained ${instances.length} runtime-reachable package instances`)
}

// choose top-level per name
const byName = new Map()
for (const inst of instances) {
  const list = byName.get(inst.name) ?? []
  list.push(inst)
  byName.set(inst.name, list)
}
const topLevel = new Map() // name -> { version, dir }
const alternates = new Map() // name -> instances not at top level
const rootSpecs = await depSpecs(src)
for (const [name, list] of byName) {
  list.sort((a, b) => cmpVersions(a.version, b.version))
  // The runtime root cannot have a second nested node_modules. Prefer its
  // required version at top level, then nest alternatives for other packages.
  const rootRange = rootSpecs[name]
  const selected = rootRange === undefined ? list[0]
    : list.find(inst => semver.satisfies(semver.valid(inst.version) ?? inst.version, comparableRange(rootRange), { loose: true })) ?? list[0]
  topLevel.set(name, selected)
  if (list.length > 1) alternates.set(name, list.filter(inst => inst !== selected))
}
console.log(`top-level packages: ${topLevel.size}, names with alternates: ${alternates.size}`)

// stage the flat tree
await rm(dst, { recursive: true, force: true })
await mkdir(path.join(dst, 'node_modules'), { recursive: true })
const flatDir = (name) => path.join(dst, 'node_modules', ...name.split('/'))

let copied = 0
for (const [name, inst] of topLevel) {
  await copyPackageContent(inst.dir, flatDir(name))
  copied += 1
}
console.log(`hoisted ${copied} packages`)

// The root manifest must exist before the dependency walk below, otherwise
// the CLI's own version ranges never participate in alternate selection.
for (const entry of ['lib', 'config', 'package.json']) {
  const from = path.join(src, entry)
  const to = path.join(dst, entry)
  if (await stat(from).then(() => true, () => false)) await copyPackageContent(from, to)
}

/** Dep specs of a package dir (name -> range), workspace/links skipped. */
async function depSpecs(dir) {
  let json
  try { json = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) } catch { return {} }
  const out = {}
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(json[field] ?? {})) {
      if (typeof range !== 'string') continue
      if (range.startsWith('workspace:') || range.startsWith('file:')) continue
      out[name] = range
    }
  }
  return out
}

/** True when the top-level version of `name` satisfies `range`. */
function topLevelSatisfies(name, range) {
  const inst = topLevel.get(name)
  if (!inst) return false
  return semver.satisfies(semver.valid(inst.version) ?? inst.version, comparableRange(range), { loose: true })
}

/** Find an alternate instance satisfying the range. */
function alternateFor(name, range) {
  for (const alt of alternates.get(name) ?? []) {
    if (semver.satisfies(semver.valid(alt.version) ?? alt.version, comparableRange(range), { loose: true })) return alt
  }
  return undefined
}

// Nest alternates under dependents that need them; fixed-point.
const queue = [path.join(dst)] // dirs to inspect: runtime root first
const handled = new Set()
let nestedCount = 0
const depthOf = new Map([[path.join(dst), 0]])

while (queue.length > 0) {
  const current = queue.shift()
  const depth = depthOf.get(current) ?? 0
  if (handled.has(current) || depth > 8) continue
  handled.add(current)
  const specs = await depSpecs(current)
  for (const [name, range] of Object.entries(specs)) {
    if (name.startsWith('@deepseek-ai/')) continue
    if (topLevelSatisfies(name, range)) continue
    // does a nested copy already exist here (from a previous pass)?
    const nestedHere = path.join(current, 'node_modules', ...name.split('/'))
    if (await isRealDir(nestedHere)) continue
    const alt = alternateFor(name, range)
    if (!alt) {
      console.warn(`  no version of ${name} satisfies ${range} (needed by ${path.relative(dst, current) || '<root>'})`)
      continue
    }
    await copyPackageContent(alt.dir, nestedHere)
    nestedCount += 1
    if (depthOf.get(current) === undefined) depthOf.set(current, depth)
    queue.push(nestedHere)
    depthOf.set(nestedHere, depth + 1)
    queue.push(current) // re-inspect with the nested copy present (for its deps chain)
  }
  // schedule any nested copies this dir already has for their own dep checks
  const selfNm = path.join(current, 'node_modules')
  for (const scope of await readdir(selfNm, { withFileTypes: true }).catch(() => [])) {
    if (!scope.isDirectory() || scope.name.startsWith('.')) continue
    if (scope.name.startsWith('@')) {
      for (const sub of await readdir(path.join(selfNm, scope.name), { withFileTypes: true }).catch(() => [])) {
        if (!sub.isDirectory()) continue
        const candidate = path.join(selfNm, scope.name, sub.name)
        if (await isRealDir(candidate)) {
          queue.push(candidate)
          depthOf.set(candidate, depth + 1)
        }
      }
      continue
    }
    const candidate = path.join(selfNm, scope.name)
    if (await isRealDir(candidate)) {
      queue.push(candidate)
      depthOf.set(candidate, depth + 1)
    }
  }
}
console.log(`nested ${nestedCount} alternate version copies`)

// no junctions remain — the manifest must not be shipped
await rm(path.join(dst, '.dsh-junctions.json'), { force: true })
await rm(path.join(dst, '.dsh-junction-root'), { force: true })

console.log(`flattened runtime written to ${dst}`)
