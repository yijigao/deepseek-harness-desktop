/**
 * gen-junction-manifest.mjs — snapshot every junction inside a runtime tree
 * into <runtime>/.dsh-junctions.json. Each entry records the junction's path
 * relative to the tree root and the part of its target after the first
 * `node_modules` segment — that suffix is layout-stable no matter where the
 * tree is extracted, so a launch-time fixer can rebuild correct junctions.
 *
 * Usage: node gen-junction-manifest.mjs <runtimeRoot>
 */
import { lstat, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [rootArg] = process.argv.slice(2)
if (!rootArg) {
  console.error('usage: node gen-junction-manifest.mjs <runtimeRoot>')
  process.exit(2)
}
const root = path.resolve(rootArg)

const norm = (p) => {
  let s = String(p)
  for (const pre of ['\\\\?\\', '\\??\\']) {
    if (s.startsWith(pre)) s = s.slice(pre.length)
  }
  return s.replace(/^"|"$/g, '')
}

const junctions = []
async function walk(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    let st
    try { st = await lstat(abs) } catch { continue }
    if (st.isSymbolicLink()) {
      const target = norm(await readlink(abs))
      const marker = target.indexOf('node_modules')
      if (marker === -1) {
        console.warn(`junction without node_modules in target, skipping: ${abs} -> ${target}`)
        continue
      }
      junctions.push({
        rel: path.relative(root, abs).split(path.sep).join('/'),
        suffix: target.slice(marker).split(path.sep).join('/'),
      })
    } else if (st.isDirectory()) {
      await walk(abs)
    }
  }
}

await walk(root)
const manifestPath = path.join(root, '.dsh-junctions.json')
await writeFile(manifestPath, JSON.stringify(junctions, null, 0))
await rm(path.join(root, '.dsh-junction-root'), { force: true })
console.log(`manifest written: ${manifestPath} (${junctions.length} junctions)`)
