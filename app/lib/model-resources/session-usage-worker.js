'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')
const { decodeInput, parseJsonLines } = require('../trajectory/adapters/dsh-jsonl')
const { parseRun } = require('../trajectory/parser')

const SESSION_NAMES = new Set(['session.jsonl', 'session.jsonl.zstd'])
// The resource chip is latency-sensitive. Harness Lab can inspect large runs on
// demand; the background ledger deliberately skips heavyweight history.
const MAX_FILE_BYTES = 8 * 1024 * 1024

function walk(directory, root, depth, output) {
  if (depth > 5) return
  let entries
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const candidate = path.join(directory, entry.name)
    const relative = path.relative(root, candidate)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    if (entry.isDirectory()) walk(candidate, root, depth + 1, output)
    if (!entry.isFile() || !SESSION_NAMES.has(entry.name)) continue
    try {
      const stat = fs.statSync(candidate)
      if (stat.size <= MAX_FILE_BYTES) output.push({ filePath: candidate, mtimeMs: stat.mtimeMs, size: stat.size })
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

function collect() {
  const sessionsRoot = path.resolve(workerData.sessionsRoot)
  const files = []
  walk(sessionsRoot, sessionsRoot, 0, files)
  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const selected = files.slice(0, Math.max(1, Math.min(60, workerData.maxFiles || 40)))
  const today = bucket()
  const month = bucket()
  let currentSession = bucket()
  let route = null
  let scannedSessions = 0
  const now = new Date()

  for (const entry of selected) {
    try {
      const input = fs.readFileSync(entry.filePath)
      const text = decodeInput(input, { fileName: entry.filePath })
      const parsed = parseJsonLines(text)
      const fileRoute = routeFromParsed(parsed)
      const run = parseRun(text, { fileName: 'session.jsonl', identitySeed: entry.filePath })
      scannedSessions += 1
      if (sameLocalDay(run.startedAt, now)) add(today, run.metrics)
      if (sameLocalMonth(run.startedAt, now)) add(month, run.metrics)
      if (!route && fileRoute) {
        route = fileRoute
        currentSession = bucket()
        add(currentSession, run.metrics)
      }
    } catch {}
  }
  return { route, localUsage: { today, month, currentSession, scannedSessions } }
}

try {
  parentPort.postMessage({ ok: true, value: collect() })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.code || error?.name || 'WORKER_FAILED' })
}
