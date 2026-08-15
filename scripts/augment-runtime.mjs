/**
 * augment-runtime.mjs — fill the holes `pnpm deploy` leaves in the runtime
 * closure (peer dependencies it never walks). For every `@deepseek-ai/*`
 * import site in the runtime's built JS, verify REAL resolution from that
 * file's location via import.meta.resolve; unresolvable sites name the
 * missing package, which is then copied from the checkout workspace into the
 * hoisted runtime node_modules. Fixed point until every site resolves.
 *
 * Usage: node augment-runtime.mjs <runtimeRoot> <checkoutRoot>
 */
import { cp, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const [runtimeArg, checkoutArg] = process.argv.slice(2)
if (!runtimeArg || !checkoutArg) {
  console.error('usage: node augment-runtime.mjs <runtimeRoot> <checkoutRoot>')
  process.exit(2)
}
const runtimeRoot = path.resolve(runtimeArg)
const checkout = path.resolve(checkoutArg)

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\.resolve\(\s*|import\.meta\.resolve\(\s*)['"](@deepseek-ai\/[^'"]+)['"]/g

/** Collect (specifier, importingFile) pairs from every built JS file. */
async function collectSites() {
  const sites = []
  const walk = async (dir, depth) => {
    if (depth > 14) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      // Junctions/symlinks report isDirectory()=false and are not followed,
      // which prevents cycles inside .pnpm.
      if (entry.isDirectory()) await walk(abs, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        try {
          const text = await readFile(abs, 'utf8')
          for (const m of text.matchAll(IMPORT_RE)) sites.push({ spec: m[1], from: abs })
        } catch {}
      }
    }
  }
  await walk(runtimeRoot, 0)
  return sites
}

/** Package root of a specifier: strip any export subpath. */
function pkgRoot(spec) {
  const parts = spec.split('/')
  return parts.slice(0, 2).join('/')
}

async function resolvable(spec, fromFile) {
  try {
    // createRequire honors the importing file's node_modules chain (import.meta.resolve
    // anchors bare specifiers to the current module instead).
    createRequire(fromFile).resolve(spec)
    return true
  } catch {
    return false
  }
}

/** Glob with single `*` segments, relative to base. */
async function walkGlob(base, parts, index) {
  if (index >= parts.length) return [base]
  const part = parts[index]
  const results = []
  let entries
  try { entries = await readdir(base, { withFileTypes: true }) } catch { return results }
  for (const entry of entries) {
    const name = entry.name
    if (part !== '*' && name !== part) continue
    results.push(...await walkGlob(path.join(base, name), parts, index + 1))
  }
  return results
}

/** Find a workspace package's real directory in the checkout. */
async function findInCheckout(rootName) {
  const basename = rootName.split('/').pop()
  for (const parts of [
    ['packages', '*', '*', 'package.json'],
    ['vendor', '*', 'package.json'],
    ['apps', '*', 'package.json'],
  ]) {
    for (const manifest of await walkGlob(checkout, parts, 0)) {
      try {
        const json = JSON.parse(await readFile(manifest, 'utf8'))
        if (json.name === rootName || path.basename(path.dirname(manifest)) === basename) {
          return path.dirname(manifest)
        }
      } catch {}
    }
  }
  return undefined
}

async function copyPackage(rootName, sourceDir) {
  const dest = path.join(runtimeRoot, 'node_modules', ...rootName.split('/'))
  await rm(dest, { recursive: true, force: true })
  await mkdir(path.dirname(dest), { recursive: true })
  await cp(sourceDir, dest, {
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
  return dest
}

const sites = await collectSites()
console.log(`collected ${sites.length} import sites`)

const knownMissing = new Set()
const unfindable = new Set()
let round = 0
while (true) {
  round += 1
  const unresolved = []
  for (const { spec, from } of sites) {
    if (await resolvable(spec, from)) continue
    unresolved.push({ spec, from })
  }
  if (unresolved.length === 0) {
    console.log(`round ${round}: all sites resolve`)
    break
  }
  const roots = new Set(unresolved.map(({ spec }) => pkgRoot(spec)))
  console.log(`round ${round}: ${unresolved.length} unresolved site(s) → ${roots.size} package root(s)`)
  let copied = 0
  for (const rootName of roots) {
    if (knownMissing.has(rootName)) continue
    const sourceDir = await findInCheckout(rootName)
    if (!sourceDir) {
      unfindable.add(rootName)
      console.warn(`  warn: ${rootName} not found in checkout — leaving as-is`)
      continue
    }
    await copyPackage(rootName, sourceDir)
    knownMissing.add(rootName)
    copied += 1
    console.log(`  copied ${rootName} <- ${sourceDir}`)
  }
  if (copied === 0) {
    console.error('no further packages could be copied; unresolved sites:')
    for (const { spec, from } of unresolved.slice(0, 20)) {
      console.error(`  ${spec}\n    at ${path.relative(runtimeRoot, from)}`)
    }
    break
  }
}

if (unfindable.size > 0) {
  console.warn(`unfindable packages (verify manually): ${[...unfindable].join(', ')}`)
}
console.log('augmentation done')
