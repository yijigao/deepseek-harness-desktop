import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
const { selectGeneration } = require('./app/lib/trajectory/session-generation')
const reuse = process.argv[2]
const write = process.argv.includes('--write')
const root = reuse ? path.resolve(reuse) : await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-alpha2-sessions-'))
if (reuse && (path.dirname(root).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('desktop-alpha2-sessions-'))) throw new Error('Only an existing isolated session-copy root may be reused')
const source = reuse ? root : 'C:/Users/yi/.dsh/sessions'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const runtime = path.resolve('../harness-alpha2-validation-20260908')
const { Context } = await import(pathToFileURL(path.join(runtime, 'vendor/cordis/lib/index.js')))
const { default: Persistence } = await import(pathToFileURL(path.join(runtime, 'packages/session/session-persistence-jsonl/lib/index.js')))
const rows = []
for (const project of await fs.readdir(source, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const session of await fs.readdir(path.join(source, project.name), { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const dir = path.join(source, project.name, session.name)
    const selected = selectGeneration(await fs.readdir(dir, { withFileTypes: true }))
    if (!selected.entry?.isFile()) continue
    const copy = path.join(root, project.name, session.name)
    await fs.mkdir(copy, { recursive: true })
    if (!reuse) await fs.copyFile(path.join(dir, selected.entry.name), path.join(copy, selected.entry.name))
    rows.push({ id: session.name, project: project.name, file: selected.entry.name })
  }
}
const ctx = new Context()
const failures = []
let passed = 0
const start = Date.now()
try {
  await ctx.plugin(Persistence, { root })
  for (const row of rows) {
    let handle
    try {
      const predecessor = path.join(root, row.project, row.id, row.file)
      const before = digest(await fs.readFile(predecessor))
      handle = await ctx.sessionPersistence.open(row.id, write ? 'write' : 'read')
      const result = await handle.read()
      await handle.close()
      handle = undefined
      if (write) {
        handle = await ctx.sessionPersistence.open(row.id, 'read')
        const reopened = await handle.read()
        if (JSON.stringify(result.events) !== JSON.stringify(reopened.events)) throw new Error('Migration reopen changed logical events')
      }
      if (digest(await fs.readFile(predecessor)) !== before) throw new Error('Predecessor changed')
      passed++
    } catch (error) { failures.push({ ...row, errorClass: error.name, detail: String(error.message) }) }
    finally { if (handle) await handle.close() }
  }
} finally { await ctx.fiber.dispose() }
await fs.writeFile(path.join(root, write ? 'write-report-private.json' : 'read-report-private.json'), JSON.stringify({ passed, failures, total: rows.length }, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ root, write, total: rows.length, passed, failed: failures.length, failures: failures.slice(0, 4).map(({ id, errorClass }) => ({ id, errorClass })), ms: Date.now() - start }))
