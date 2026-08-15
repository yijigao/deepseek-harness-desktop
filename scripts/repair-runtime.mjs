/**
 * repair-runtime.mjs — make the pnpm-deployed runtime closure self-contained
 * and relocatable.
 *
 * The legacy `pnpm deploy` virtual store links workspace packages with
 * absolute junctions (some pointing OUT of the tree, into the checkout).
 * A moved tree would break those. This script rebuilds the tree at dst:
 *   - regular files / real dirs      → copied as-is (hardlinks become real files)
 *   - junctions whose target is inside src  → recreated as RELATIVE junctions
 *   - junctions whose target is outside src  → materialized as real dir copies
 *
 * Usage: node repair-runtime.mjs <src> <dst>
 */
import { cp, lstat, mkdir, readdir, readlink, rm, symlink, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [srcArg, dstArg] = process.argv.slice(2)
if (!srcArg || !dstArg) {
  console.error('usage: node repair-runtime.mjs <src> <dst>')
  process.exit(2)
}
const src = path.resolve(srcArg)
const dst = path.resolve(dstArg)
if (dst === src || dst.startsWith(src + path.sep)) {
  console.error(`dst must not live inside src: ${dst}`)
  process.exit(2)
}

const norm = (p) => {
  let s = String(p)
  // NT namespace prefixes Node may surface on Windows junctions
  for (const pre of ['\\\\?\\', '\\??\\']) {
    if (s.startsWith(pre)) s = s.slice(pre.length)
  }
  s = s.replace(/^"|"$/g, '')
  return s
}

/** True when candidate is inside base (case-insensitive on win32). */
function isInside(base, candidate) {
  const rel = path.relative(base, candidate)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

const links = [] // { absPath, target }
let dirs = 0
let files = 0
let outsideLinks = 0

async function scan(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    let st
    try {
      st = await lstat(abs)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      const target = norm(await readlink(abs))
      const absTarget = path.isAbsolute(target) ? path.normalize(target) : path.resolve(path.dirname(abs), target)
      links.push({ absPath: abs, rel: path.relative(src, abs), target, absTarget })
      if (!isInside(src, absTarget)) outsideLinks += 1
    } else if (st.isDirectory()) {
      dirs += 1
      await scan(abs)
    } else {
      files += 1
    }
  }
}

async function copyRealTree() {
  await mkdir(dst, { recursive: true })
  await cp(src, dst, {
    recursive: true,
    dereference: false,
    force: false,
    errorOnExist: false,
    filter: (source) => {
      try {
        return !lstatSyncSafe(source)
      } catch {
        return false
      }
    },
  })
}

import { lstatSync as lstatSyncImport } from 'node:fs'
function lstatSyncSafe(p) {
  return lstatSyncImport(p).isSymbolicLink()
}

async function recreateLinks() {
  for (const link of links) {
    const destPath = path.join(dst, link.rel)
    await mkdir(path.dirname(destPath), { recursive: true })
    if (isInside(src, link.absTarget)) {
      const relTarget = path.relative(path.dirname(destPath), path.join(dst, path.relative(src, link.absTarget)))
      try {
        await symlink(relTarget, destPath, 'junction')
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    } else {
      // Materialize the outside target as a real directory: real files only.
      // Skip `node_modules` subtrees and every link entry — runtime resolution
      // goes through the .pnpm sibling junctions, never through the checkout's
      // own (cyclic) peer link farms.
      try {
        await stat(link.absTarget)
      } catch (error) {
        console.error(`outside junction target missing: ${link.absPath} -> ${link.absTarget}`)
        throw error
      }
      await cp(link.absTarget, destPath, {
        recursive: true,
        dereference: true,
        errorOnExist: false,
        force: true,
        filter: (source) => {
          if (path.basename(source) === 'node_modules') return false
          try {
            return !lstatSyncSafe(source)
          } catch {
            return false
          }
        },
      })
    }
  }
}

console.log(`scanning ${src} ...`)
await scan(src)
console.log(`  dirs=${dirs} files=${files} links=${links.length} outside-links=${outsideLinks}`)
await rm(dst, { recursive: true, force: true })
await copyRealTree()
await recreateLinks()
console.log(`repaired runtime written to ${dst}`)
