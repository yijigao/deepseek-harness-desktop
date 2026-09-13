// Emits a minimal apply_patch input. Never executes recovered business scripts.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const auditPath = process.argv[2]
if (!auditPath || !path.isAbsolute(auditPath)) throw Error('Absolute audited inventory path required')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const auditBytes = await fs.readFile(auditPath)
if (hash(auditBytes) !== 'c5a72b7d0818d243c2b5de31f2d2014fba783947b5f63cd86953b5d7a583785d') throw Error('Audited input changed')
const audit = JSON.parse(auditBytes)
const backupRoot = path.dirname(audit.maintenanceRoot)
const variants = [
  [audit.installRoot.replaceAll('\\', '\\\\'), audit.recoveryRoot.replaceAll('\\', '\\\\')],
  [audit.installRoot.replaceAll('\\', '/'), audit.recoveryRoot.replaceAll('\\', '/')],
  [audit.installRoot, audit.recoveryRoot],
]
const changes = []
let patch = '*** Begin Patch\n'
for (const extra of audit.extras.filter(e => e.category === 'business' && e.relativePath.endsWith('.py'))) {
  const current = await fs.readFile(extra.destination)
  const original = await fs.readFile(path.join(backupRoot, 'snapshot/install', extra.relativePath))
  if (hash(current) !== extra.sha256 || hash(original) !== extra.sha256) throw Error('Recovered script or original snapshot changed: ' + extra.relativePath)
  const text = current.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(current)) throw Error('Non-UTF8 script requires explicit review: ' + extra.relativePath)
  const lines = text.split(/\r?\n/)
  const hunks = []
  for (const line of lines) {
    let next = line
    for (const [oldPrefix, newPrefix] of variants) next = next.split(oldPrefix).join(newPrefix)
    if (next !== line) hunks.push({ before: line, after: next })
  }
  if (!hunks.length) continue
  patch += '*** Update File: ' + extra.destination.replaceAll('\\', '/') + '\n'
  for (const hunk of hunks) patch += '@@\n-' + hunk.before + '\n+' + hunk.after + '\n'
  changes.push({ file: extra.relativePath, originalSha256: extra.sha256, changedLines: hunks.length })
}
patch += '*** End Patch'
console.log(JSON.stringify({ patch, changes, files: changes.length, lines: changes.reduce((s, c) => s + c.changedLines, 0) }))
