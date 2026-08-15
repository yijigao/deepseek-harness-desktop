/**
 * augment-deps.mjs — bring registry dependencies of the augmented workspace
 * packages into the runtime root's hoisted node_modules.
 *
 * Augmented packages are real dirs under runtime/node_modules/@deepseek-ai/*
 * (the deploy's own links are junctions). Their dependencies/peerDependencies
 * are collected (workspace/@deepseek-ai specs excluded), the missing ones are
 * resolved with npm into a temp dir, and every top-level result that the
 * runtime root does not already have is merged in.
 *
 * Usage: node augment-deps.mjs <runtimeRoot>
 */
import { mkdir, readdir, readFile, rm, stat, cp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'

const [runtimeArg] = process.argv.slice(2)
if (!runtimeArg) {
  console.error('usage: node augment-deps.mjs <runtimeRoot>')
  process.exit(2)
}
const runtimeRoot = path.resolve(runtimeArg)
const rootModules = path.join(runtimeRoot, 'node_modules')
const scoped = path.join(rootModules, '@deepseek-ai')

async function isRealDir(p) {
  try {
    const s = await stat(p)
    return s.isDirectory() && !s.isSymbolicLink()
  } catch {
    return false
  }
}

/** Augmented packages = real dirs directly under node_modules/@deepseek-ai. */
async function augmentedPackages() {
  const out = []
  let entries
  try { entries = await readdir(scoped, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const pkgDir = path.join(scoped, entry.name)
    if (!(await isRealDir(pkgDir))) continue
    const manifestPath = path.join(pkgDir, 'package.json')
    try {
      out.push({ name: `@deepseek-ai/${entry.name}`, dir: pkgDir, manifest: JSON.parse(await readFile(manifestPath, 'utf8')) })
    } catch {}
  }
  return out
}

async function hoisted(name) {
  try {
    await stat(path.join(rootModules, ...name.split('/'), 'package.json'))
    return true
  } catch {
    return false
  }
}

function externalSpecs(manifest, pkgName) {
  const specs = {}
  const NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i
  const RANGE_RE = /^[0-9^*~xX<>=|.\s-]+$/i
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith('@deepseek-ai/') || typeof range !== 'string') continue
      if (range.startsWith('workspace:') || range.startsWith('file:')) continue
      if (!NAME_RE.test(name) || !RANGE_RE.test(range)) {
        console.warn(`  skip malformed spec in ${pkgName}: ${JSON.stringify(name)} = ${JSON.stringify(range)}`)
        continue
      }
      specs[name] = range
    }
  }
  return specs
}

const packages = await augmentedPackages()
console.log(`augmented packages: ${packages.length}`)

const wanted = new Map() // name -> range (first seen wins)
for (const pkg of packages) {
  for (const [name, range] of Object.entries(externalSpecs(pkg.manifest, pkg.name))) {
    if (!wanted.has(name)) wanted.set(name, range)
  }
}

const missing = []
for (const [name] of wanted) {
  if (!(await hoisted(name))) missing.push(name)
}
console.log(`registry deps wanted: ${wanted.size}, missing: ${missing.length}`)
if (missing.length === 0) {
  console.log('nothing to install')
  process.exit(0)
}

const temp = await mkdir(path.join(os.tmpdir(), `dsh-augment-${Date.now()}`), { recursive: true })
const tempPlain = temp.replace(/^\\\\\?\\/, '') // cmd.exe rejects \\?\ (UNC-like) cwd
const installArgs = missing.map((name) => `${name}@${wanted.get(name)}`)
console.log(`npm install into ${tempPlain} ...`)
const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--no-save', '--registry=https://registry.npmmirror.com', ...installArgs], {
  cwd: tempPlain,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
})
if (result.status !== 0) {
  console.error(`npm install failed: ${String(result.stderr ?? result.stdout ?? '').slice(-2000)}`)
  process.exit(1)
}

const tempModules = path.join(temp, 'node_modules')
const entries = await readdir(tempModules, { withFileTypes: true })
let merged = 0
for (const entry of entries) {
  if (!entry.isDirectory() || entry.name === '.bin' || entry.name.startsWith('.')) continue
  const dest = path.join(rootModules, entry.name)
  if (await hoisted(entry.name)) continue
  await cp(path.join(tempModules, entry.name), dest, {
    recursive: true,
    dereference: true,
    errorOnExist: false,
    force: false,
  })
  merged += 1
}
// Scoped packages too.
const tempScoped = path.join(tempModules, '@deepseek-ai')
for (const name of missing) {
  if (!name.startsWith('@')) continue
  const [scope, rest] = name.split('/')
  const src = path.join(tempModules, scope, rest)
  const dest = path.join(rootModules, scope, rest)
  if (await hoisted(name)) continue
  await cp(src, dest, { recursive: true, dereference: true, errorOnExist: false, force: false })
  merged += 1
}

await rm(temp, { recursive: true, force: true })
console.log(`merged ${merged} package(s) into runtime node_modules`)
