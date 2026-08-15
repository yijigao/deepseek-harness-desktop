/**
 * fix-junctions.mjs — launch-time junction repair for the bundled runtime.
 *
 * Junction targets are stored absolute on Windows (libuv resolves relative
 * targets at creation time), so a tree extracted to a new location (the
 * portable exe extracts to a fresh temp dir on every run) has every junction
 * pointing at the old build-time root. Using the manifest snapshot
 * (.dsh-junctions.json, generated at build time), this script rewrites each
 * junction to point at the same layout under the CURRENT tree root.
 *
 * A marker file (.dsh-junction-root) records the last repaired root; when it
 * matches, the repair is skipped (fixed install location, subsequent runs).
 *
 * Usage: node fix-junctions.mjs <runtimeRoot>
 */
import { lstat, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [rootArg] = process.argv.slice(2)
if (!rootArg) {
  console.error('usage: node fix-junctions.mjs <runtimeRoot>')
  process.exit(2)
}
const root = path.resolve(rootArg)
const manifestPath = path.join(root, '.dsh-junctions.json')
const markerPath = path.join(root, '.dsh-junction-root')

async function readMarker() {
  try {
    return (await readFile(markerPath, 'utf8')).trim()
  } catch {
    return ''
  }
}

let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch {
  manifest = null
}

if (manifest === null) {
  console.log('fix-junctions: no manifest — junction-free layout, nothing to do')
  process.exit(0)
}

if ((await readMarker()) === root) {
  console.log('fix-junctions: marker matches, junctions already valid')
  process.exit(0)
}

const t0 = Date.now()
let done = 0
let failed = 0
const CONCURRENCY = 48
const queue = [...manifest]

async function worker() {
  while (queue.length > 0) {
    const entry = queue.pop()
    if (entry === undefined) return
    const destPath = path.join(root, ...entry.rel.split('/'))
    const newTarget = path.join(root, ...entry.suffix.split('/'))
    try {
      await rm(destPath, { recursive: true, force: true })
      await symlink(newTarget, destPath, 'junction')
      done += 1
    } catch (error) {
      failed += 1
      if (failed <= 5) console.error(`fix-junctions: ${entry.rel}: ${error.message}`)
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

if (failed > 0) {
  console.error(`fix-junctions: ${failed}/${manifest.length} junctions failed`)
  process.exit(4)
}
await writeFile(markerPath, root)
console.log(`fix-junctions: rewrote ${done} junctions in ${Date.now() - t0}ms`)
