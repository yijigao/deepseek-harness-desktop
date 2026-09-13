// Private diagnostic: only the temporary copy is opened by candidate persistence.
// Usage: node scripts/verify-session-migration.mjs <candidate-root> <source-log> [--inspect]
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { zstdCompressSync } from 'node:zlib'
const require = createRequire(import.meta.url)
const { decodeInput } = require('../app/lib/trajectory/adapters/dsh-jsonl')
const { runSessionWorker } = require('../app/lib/model-resources/service')
const { repairProvenance } = require('../app/lib/trajectory/repair-provenance')
const [candidate, source, mode] = process.argv.slice(2)
if (!candidate || !source) throw new Error('Candidate root and source log required')
const before = await fs.readFile(source)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const text = decodeInput(before, { fileName: source })
const header = JSON.parse(text.slice(0, text.indexOf('\n')))
if (mode === '--audit-refs') {
  console.log(JSON.stringify(text.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.seq < 2400).map(row => ({
    seq: row.seq, type: row.type, sourceKind: row.type === 'user/message' ? row.data?.source?.kind : undefined,
    refs: Object.fromEntries(Object.entries(row.data || {}).filter(([key]) => /seq/i.test(key))),
  })).filter(row => Object.keys(row.refs).length || row.sourceKind)))
} else if (mode === '--audit-provenance') {
  const result = repairProvenance(text.split('\n').filter(Boolean).map(JSON.parse))
  console.log(JSON.stringify({ changes: result.changes.length, unresolvedCount: result.unresolved.length,
    unresolved: result.unresolved.slice(0, 12) }))
} else if (mode === '--inspect-schema') {
  console.log(JSON.stringify(text.split('\n').slice(1, 65).filter(Boolean).map(line => {
    const row = JSON.parse(line)
    return { seq: row.seq, type: row.type, turn: row.data?.turn, step: row.data?.step,
      chunkType: row.data?.chunk?.type, sources: row.sourceEventSeqs, surfaceOp: row.surfaceOp,
      keys: row.type.startsWith('tool/') ? { source: Object.keys(row.data?.message?.source || {}),
        content: row.data?.message?.content?.map(item => ({ type: item.type, keys: Object.keys(item) })) } : undefined }
  })))
} else if (mode === '--inspect') {
  let title
  for (const line of text.split('\n')) {
    if (!line.includes('title')) continue
    try { const row = JSON.parse(line); if (row.type.includes('title')) title = row.data?.title } catch {}
  }
  console.log(JSON.stringify({ id: header.id, title, bytes: before.length, lines: text.split('\n').length }))
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-private-migration-'))
  const copyDir = path.join(root, path.basename(path.dirname(path.dirname(source))), header.id)
  await fs.mkdir(copyDir, { recursive: true })
  const copy = path.join(copyDir, path.basename(source))
  let prepared = before
  let repair
  let semanticContentUnchanged
  if (mode === '--repair-copy') {
    if (header.version !== 0) throw new Error('Recovery is limited to legacy v0')
    const originalRows = text.split('\n').filter(Boolean).map(JSON.parse)
    repair = repairProvenance(originalRows)
    if (repair.unresolved.length) throw new Error(`Unresolved provenance: ${repair.unresolved.length}`)
    const omitRepairFields = row => {
      const value = { ...row }
      if (['assistant/message', 'tool/result'].includes(row.type)) delete value.sourceEventSeqs
      if (['session/title', 'session/title-llm-request'].includes(row.type)) {
        value.data = { ...row.data }
        delete value.data.messageSeqs
      }
      return value
    }
    semanticContentUnchanged = originalRows.length === repair.rows.length && originalRows.every((row, index) =>
      JSON.stringify(omitRepairFields(row)) === JSON.stringify(omitRepairFields(repair.rows[index])))
    if (!semanticContentUnchanged) throw new Error('Recovery changed non-reference fields')
    const lines = repair.rows.map(row => JSON.stringify(row) + '\n')
    prepared = source.endsWith('.zstd')
      ? Buffer.concat([zstdCompressSync(Buffer.from(lines[0])), zstdCompressSync(Buffer.from(lines.slice(1).join('')))])
      : Buffer.from(lines.join(''))
    await fs.writeFile(path.join(root, 'original-source.bin'), before, { mode: 0o600 })
  }
  await fs.writeFile(copy, prepared, { mode: 0o600 })
  const initialGenerations = (await fs.readdir(copyDir)).filter(name => /^session.*jsonl/.test(name)).sort()
  const importBuilt = relative => import(pathToFileURL(path.join(candidate, relative)).href)
  const { Context } = await importBuilt('vendor/cordis/lib/index.js')
  const { default: Persistence } = await importBuilt('packages/session/session-persistence-jsonl/lib/index.js')
  const ctx = new Context()
  const report = { id: header.id, diagnosticRoot: root, sourceBytes: before.length, phases: [] }
  report.sourceSha256 = digest(before)
  if (repair) { report.referenceRepairs = repair.changes; report.semanticContentUnchanged = semanticContentUnchanged }
  try {
    const beforeUsage = await runSessionWorker(root)
    await ctx.plugin(Persistence, { root, compression: source.endsWith('.zstd') ? 'zstd' : 'none' })
    for (const access of ['read', 'write', 'read']) {
      const started = performance.now()
      const handle = await ctx.sessionPersistence.open(header.id, access)
      try {
        const opened = performance.now()
        const result = await handle.read()
        report.phases.push({ access, openMs: Math.round(opened - started),
          readMs: Math.round(performance.now() - opened), events: result.events.length })
      } finally { await handle.close() }
      if (report.phases.length === 1) {
        const currentGenerations = (await fs.readdir(copyDir)).filter(name => /^session.*jsonl/.test(name)).sort()
        report.readDidNotPublish = JSON.stringify(currentGenerations) === JSON.stringify(initialGenerations)
      }
    }
    await ctx.sessionPersistence.flush()
    report.generations = (await fs.readdir(copyDir)).filter(name => /^session.*jsonl/.test(name))
    const afterUsage = await runSessionWorker(root)
    report.accounting = {
      beforeTokens: beforeUsage?.localUsage.currentSession.totalTokens,
      afterTokens: afterUsage?.localUsage.currentSession.totalTokens,
      complete: beforeUsage?.localUsage.incomplete === false && afterUsage?.localUsage.incomplete === false,
      selectedSessions: afterUsage?.localUsage.scannedSessions,
    }
  } catch (error) {
    // Migration errors may quote message/tool payloads; emit only the error class.
    report.errorClass = error.name
    report.errorCode = error.code
    await fs.writeFile(path.join(root, 'error-private.txt'), String(error.stack), { mode: 0o600 })
    process.exitCode = 1
  } finally {
    await ctx.fiber.dispose()
    report.sourceUnchanged = digest(await fs.readFile(source)) === digest(before)
    report.copyPredecessorUnchanged = digest(await fs.readFile(copy)) === digest(prepared)
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(report))
  }
}
