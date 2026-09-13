'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')
const { decodeInput } = require('../trajectory/adapters/dsh-jsonl')
const { normalizeDshRecords } = require('../trajectory/normalize')

const { selectGeneration, generation } = require('../trajectory/session-generation')
// Parsing remains isolated in a worker and unchanged files reuse summaries.
// The hard memory limit is reported as incomplete coverage, never hidden.
const MAX_FILE_BYTES = 512 * 1024 * 1024

function walk(directory, root, depth, output) {
  if (depth > 5) return
  let entries
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
  const selection = selectGeneration(entries)
  if (selection.ambiguous || selection.entry && !selection.entry.isFile()) {
    output.push({ filePath: directory, size: Infinity, mtimeMs: 0 })
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const candidate = path.join(directory, entry.name)
    const relative = path.relative(root, candidate)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    if (entry.isDirectory()) walk(candidate, root, depth + 1, output)
    if (!entry.isFile() || entry !== selection.entry) continue
    try {
      const stat = fs.statSync(candidate)
      output.push({ filePath: candidate, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch {}
  }
}

function routeFromParsed(parsed) {
  for (let index = parsed.records.length - 1; index >= 0; index -= 1) {
    const data = parsed.records[index]?.data
    const candidates = [data?.header?.config, data?.config, data?.context, data?.message?.source, data?.source]
    for (const candidate of candidates) {
      if (typeof candidate?.provider === 'string' && typeof candidate?.model === 'string') {
        return { provider: candidate.provider, model: candidate.model, source: 'active-session' }
      }
    }
  }
  return null
}

function bucket() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function add(target, metrics) {
  target.requests += Number(metrics.assistant_messages) || 0
  target.inputTokens += Number(metrics.input_tokens) || 0
  target.outputTokens += Number(metrics.output_tokens) || 0
  target.totalTokens += Number(metrics.total_tokens) || 0
}

function sameLocalDay(iso, now) {
  if (!iso) return false
  const value = new Date(iso)
  return value.getFullYear() === now.getFullYear()
    && value.getMonth() === now.getMonth()
    && value.getDate() === now.getDate()
}

function sameLocalMonth(iso, now) {
  if (!iso) return false
  const value = new Date(iso)
  return value.getFullYear() === now.getFullYear() && value.getMonth() === now.getMonth()
}

// Usage does not need tool arguments, outputs, images, or assistant text. Avoid
// building the full trajectory and hashing large tool payloads on every update.
function readUsageRecords(text) {
  const parsed = { header: null, records: [], diagnostics: { malformedLines: 0, blankLines: 0 } }
  let offset = 0
  while (offset < text.length) {
    const end = text.indexOf('\n', offset)
    const line = text.slice(offset, end < 0 ? text.length : end)
    offset = end < 0 ? text.length : end + 1
    if (!/"type"\s*:\s*"(?:session|request\/header|assistant\/message|assistant\/attempt|assistant\/chunk)"/.test(line)) continue
    try {
      const record = JSON.parse(line)
      if (record.type === 'session' && !Object.hasOwn(record, 'data')) { parsed.header = record; continue }
      const data = record.data || {}
      if (record.type === 'assistant/chunk' && data.chunk?.type !== 'usage') continue
      if (!['request/header', 'assistant/message', 'assistant/attempt', 'assistant/chunk'].includes(record.type)) continue
      parsed.records.push({ type: record.type, seq: record.seq, time: record.time, timestamp: record.timestamp,
        data: { turn: data.turn, step: data.step, usage: data.usage,
          stream: Array.isArray(data.stream) ? data.stream.filter(item => item.type === 'chunk' && item.chunk?.type === 'usage') : undefined,
          chunk: data.chunk?.type === 'usage' ? data.chunk : undefined,
          header: { config: data.header?.config || data.config }, source: data.source,
          message: { source: data.message?.source, usage: data.message?.usage } } })
    } catch { parsed.diagnostics.malformedLines++ }
  }
  return parsed
}

function collect() {
  const sessionsRoot = path.resolve(workerData.sessionsRoot)
  const files = []
  walk(sessionsRoot, sessionsRoot, 0, files)
  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const selected = workerData.maxFiles ? files.slice(0, workerData.maxFiles) : files
  const today = bucket()
  const month = bucket()
  let currentSession = bucket()
  let route = null
  let scannedSessions = 0
  let skippedSessions = files.length - selected.length
  let cachedSessions = 0
  let prior = {}
  if (workerData.summaryFile) {
    try {
      const cache = JSON.parse(fs.readFileSync(workerData.summaryFile, 'utf8'))
      if (cache.version === 1 && cache.root === sessionsRoot) prior = cache.entries || {}
    } catch {}
  }
  const entries = Object.create(null)
  const now = new Date()
  const deadline = Date.now() + 10_000

  for (const entry of selected) {
    try {
      if (entry.size > MAX_FILE_BYTES) throw new Error('session exceeds reader limit')
      const key = path.relative(sessionsRoot, entry.filePath)
      const fingerprint = `${entry.size}:${entry.mtimeMs}`
      let summary = prior[key]?.fingerprint === fingerprint ? prior[key] : null
      if (summary) cachedSessions += 1
      else {
        if (Date.now() > deadline) throw new Error('history backfill continues on next refresh')
        const input = fs.readFileSync(entry.filePath)
        const text = decodeInput(input, { fileName: entry.filePath })
        const parsed = readUsageRecords(text)
        const version = parsed.header?.version ?? 0
        if (![0, 2].includes(version) || generation(path.basename(entry.filePath)) !== version
          || parsed.diagnostics.malformedLines) throw new Error('unsupported or incomplete log')
        if (!parsed.header) throw new Error('missing session header')
        const run = normalizeDshRecords(parsed, { identitySeed: entry.filePath })
        const days = Object.create(null)
        const totals = bucket()
        for (const step of run.steps) {
          const usage = step.metadata?.usage
          if (!usage) continue
          const metrics = { assistant_messages: 1, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
            total_tokens: (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) }
          add(totals, metrics)
          // Store UTC instants, not day strings: local timezone changes remain correct.
          if (step.timestamp) {
            const instant = step.timestamp
            days[instant] ||= bucket()
            add(days[instant], metrics)
          }
        }
        summary = { fingerprint, route: routeFromParsed(parsed), totals, days }
      }
      entries[key] = summary
      scannedSessions += 1
      for (const [instant, usage] of Object.entries(summary.days)) {
        const metrics = { assistant_messages: usage.requests, input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens, total_tokens: usage.totalTokens }
        if (sameLocalDay(instant, now)) add(today, metrics)
        if (sameLocalMonth(instant, now)) add(month, metrics)
      }
      if (!route && summary.route) {
        route = summary.route
        currentSession = summary.totals
      }
    } catch { skippedSessions += 1 }
  }
  if (workerData.summaryFile) {
    const temporary = `${workerData.summaryFile}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, root: sessionsRoot, entries }), { mode: 0o600 })
      fs.renameSync(temporary, workerData.summaryFile)
    } catch {}
  }
  return { route, localUsage: { today, month, currentSession, scannedSessions, skippedSessions, cachedSessions,
    incomplete: skippedSessions > 0, currentSessionSource: 'most-recent-session' } }
}

try {
  parentPort.postMessage({ ok: true, value: collect() })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.code || error?.name || 'WORKER_FAILED' })
}
