// Generate byte-preserving release evidence without touching the source index.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const [sourceArg, replayArg, outArg] = process.argv.slice(2)
if (!sourceArg || !replayArg || !outArg) throw Error('usage: prepare-source-provenance.mjs <built-source> <fresh-base-worktree> <new-evidence-dir>')
const source = path.resolve(sourceArg)
const replay = path.resolve(replayArg)
const out = path.resolve(outArg)
const desktop = path.resolve(import.meta.dirname, '../..')
const base = JSON.parse(await fs.readFile(path.join(desktop, 'maintenance/baseline.json'), 'utf8'))
const fixedPatch = path.join(desktop, 'maintenance/harness-alpha2.patch')
const hash = data => createHash('sha256').update(data).digest('hex')
if (hash(await fs.readFile(fixedPatch)) !== base.patchsetSha256) throw Error('r9 fixed patch differs from trusted baseline')
try { await fs.lstat(out); throw Error('Evidence output already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
function git(cwd, args, index, input) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], {
    env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
    input, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw Error(`git ${args[0]} failed: ${result.error ?? result.stderr.toString()}`)
  return result.stdout
}
for (const dir of [source, replay]) {
  if (git(dir, ['rev-parse', 'HEAD']).toString().trim() !== base.engineCommit) throw Error('Wrong source base commit')
}
if (git(replay, ['status', '--porcelain']).length !== 0) throw Error('Replay worktree is not fresh')
await fs.mkdir(out, { recursive: true })
const baseIndex = path.join(out, 'r9.index')
const finalIndex = path.join(out, 'r10.index')
git(source, ['read-tree', base.engineCommit], baseIndex)
git(source, ['apply', '--cached', '--check', fixedPatch], baseIndex)
git(source, ['apply', '--cached', fixedPatch], baseIndex)
const baseTree = git(source, ['write-tree'], baseIndex).toString().trim()
const names = bytes => bytes.toString().split('\0').filter(Boolean)
const relevant = [...new Set([
  ...names(git(source, ['diff', '--name-only', '-z', base.engineCommit, baseTree])),
  ...names(git(source, ['diff', '--name-only', '-z', base.engineCommit])),
  ...names(git(source, ['ls-files', '--others', '--exclude-standard', '-z'])),
])].sort()
git(source, ['read-tree', base.engineCommit], finalIndex)
const files = []
for (const relative of relevant) {
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw Error('Unsafe source path')
  const file = path.join(source, relative)
  const info = await fs.lstat(file).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (info === undefined) {
    git(source, ['update-index', '--force-remove', '--', relative], finalIndex)
    files.push({ path: relative, deleted: true })
    continue
  }
  if (!info.isFile()) throw Error(`Only regular release source files allowed: ${relative}`)
  const content = await fs.readFile(file)
  const object = git(source, ['hash-object', '-w', '--no-filters', '--stdin'], undefined, content).toString().trim()
  const treeEntry = git(source, ['ls-tree', base.engineCommit, '--', relative]).toString()
  const mode = treeEntry.startsWith('100755 ') ? '100755' : '100644'
  git(source, ['update-index', '--add', '--cacheinfo', mode, object, relative], finalIndex)
  files.push({ path: relative, sha256: hash(content) })
}
const finalTree = git(source, ['write-tree'], finalIndex).toString().trim()
const delta = git(source, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', baseTree, finalTree])
const composed = git(source, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', base.engineCommit, finalTree])
const deltaPath = path.join(out, 'r9-to-r10.patch')
await fs.writeFile(deltaPath, delta)
await fs.writeFile(path.join(out, 'base-to-r10.patch'), composed)
git(replay, ['apply', '--check', fixedPatch])
git(replay, ['apply', fixedPatch])
git(replay, ['apply', '--check', deltaPath])
git(replay, ['apply', deltaPath])
for (const file of files) {
  const content = await fs.readFile(path.join(replay, file.path)).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (file.deleted ? content !== undefined : content === undefined || hash(content) !== file.sha256) throw Error(`Replay hash mismatch: ${file.path}`)
}
const releaseId = 'desktop-2.2.0-alpha2-r10'
const descriptor = { ...base, releaseId, patchsetSha256: hash(composed), capabilities: [...base.capabilities, 'task-scoped-performance-guards'] }
await fs.writeFile(path.join(out, 'baseline.json'), JSON.stringify(descriptor, null, 2) + '\n')
const version = JSON.parse(await fs.readFile(path.join(desktop, 'maintenance/version.json'), 'utf8'))
await fs.writeFile(path.join(out, 'version.json'), JSON.stringify({ ...version, desktopReleaseId: releaseId }, null, 2) + '\n')
const receipt = {
  releaseId, source, replay, baseCommit: base.engineCommit, fixedPatchSha256: base.patchsetSha256,
  baseTree, finalTree, deltaSha256: hash(delta), composedSha256: hash(composed),
  replayVerified: true, files,
}
await fs.writeFile(path.join(out, 'source-provenance.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, out, replay, checkedFiles: files.length, deltaSha256: receipt.deltaSha256, composedSha256: receipt.composedSha256 }))
