// Build maintainer command: reconstruct source in a NEW checkout, not the user's worktree.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = path.resolve(import.meta.dirname, '..')
const baseline = JSON.parse(await fs.readFile(path.join(root, 'maintenance/baseline.json'), 'utf8'))
const patch = path.join(root, 'maintenance/harness-alpha2.patch')
if (createHash('sha256').update(await fs.readFile(patch)).digest('hex') !== baseline.patchsetSha256) throw Error('Pinned patchset changed')
const [repository, targetArg] = process.argv.slice(2)
if (!repository || !targetArg) throw Error('Usage: prepare-pinned-source.mjs <upstream-repository-or-local-clone> <new-directory>')
const target = path.resolve(targetArg)
try { await fs.lstat(target); throw Error('Target must not exist') } catch (error) { if (error.code !== 'ENOENT') throw error }
function git(args) {
  const result = spawnSync('git', args, { stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) throw Error('Pinned source preparation failed; retain directory for diagnosis')
}
git(['clone', '--no-checkout', '--no-hardlinks', '--', repository, target])
git(['-C', target, 'checkout', '--detach', baseline.engineCommit])
git(['-C', target, 'apply', '--check', patch])
git(['-C', target, 'apply', patch])
console.log(JSON.stringify({ source: target, commit: baseline.engineCommit, patchsetSha256: baseline.patchsetSha256, next: 'Use pinned Node/pnpm; install --frozen-lockfile; build and qualify in this checkout only' }))
