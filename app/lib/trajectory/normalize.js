'use strict'

const crypto = require('node:crypto')
const { createCanonicalRun, createCanonicalStep } = require('./schema')
const {
  REDACTED,
  basenameOnly,
  isSecretKey,
  redactSecretPatterns,
  redactString,
  safeIdentifier,
  safeLabel,
  sanitizeMetadata,
} = require('./redaction')
const { calculateMetrics } = require('./metrics')
const { isTestCommand, normalizeToolCategory } = require('./tool-categories')

const PACKED_STORAGE_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
const VOLATILE_ARGUMENT_KEYS = new Set(['callid', 'requestid', 'timestamp', 'nonce', 'timeout', 'timeoutms'])

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function toIso(value) {
  if (value == null) return null
  let date
  if (typeof value === 'number') {
    date = new Date(value < 10_000_000_000 ? value * 1000 : value)
  } else {
    date = new Date(value)
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function stableValue(value, key = '') {
  if (isSecretKey(key)) return REDACTED
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactSecretPatterns(value)
  if (Array.isArray(value)) return value.map((item) => stableValue(item, key))
  if (typeof value !== 'object') return String(value)
  const output = Object.create(null)
  for (const childKey of Object.keys(value).sort()) {
    const normalized = childKey.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (VOLATILE_ARGUMENT_KEYS.has(normalized)) continue
    output[childKey] = stableValue(value[childKey], childKey)
  }
  return output
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed }
  } catch {
    return { unparsed: value }
  }
}

function argumentSignature(tool, args) {
  const stable = JSON.stringify(stableValue(args))
  return sha256(`${tool}\n${stable}`)
}

function normalizedToolName(value) {
  const safe = safeIdentifier(value, 'unknown-tool', 80)
  return safe || 'unknown-tool'
}

function collectPathBasenames(value, parentKey = '', output = new Set(), depth = 0) {
  if (depth > 5 || value == null) return output
  const key = parentKey.toLowerCase().replace(/[^a-z0-9]/g, '')
  const pathLike = ['path', 'filepath', 'filename', 'file', 'cwd', 'workspace', 'directory', 'dir'].includes(key)
  if (pathLike && typeof value === 'string') {
    const base = basenameOnly(value)
    if (base) output.add(redactString(base).slice(0, 120))
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathBasenames(item, parentKey, output, depth + 1)
  } else if (typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectPathBasenames(child, childKey, output, depth + 1)
    }
  }
  return output
}

function extractCallId(data) {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : []
  const block = blocks.find((item) => item && typeof item === 'object' && (item.toolCallId != null || item.callId != null))
  return data?.callId
    ?? data?.toolCallId
    ?? data?.message?.toolCallId
    ?? block?.toolCallId
    ?? block?.callId
    ?? null
}

function hasStructuredFailure(value, depth = 0) {
  if (depth > 6 || value == null) return false
  if (Array.isArray(value)) return value.some((item) => hasStructuredFailure(item, depth + 1))
  if (typeof value !== 'object') return false
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (normalized === 'iserror' && child === true) return true
    if (normalized === 'error' && child) return true
    if (['exitcode', 'statuscode'].includes(normalized) && Number.isFinite(Number(child)) && Number(child) !== 0) return true
    if (normalized === 'status' && typeof child === 'string' && /^(?:error|failed|failure)$/i.test(child)) return true
    if (hasStructuredFailure(child, depth + 1)) return true
  }
  return false
}

function contentIndicatesFailure(value, depth = 0) {
  if (depth > 6 || value == null) return false
  if (typeof value === 'string') {
    return /(?:process|command)\s+(?:exited|failed).*?(?:code|status)\s*[:=]?\s*[1-9]\d*/i.test(value)
  }
  if (Array.isArray(value)) return value.some((item) => contentIndicatesFailure(item, depth + 1))
  if (typeof value === 'object') return Object.values(value).some((item) => contentIndicatesFailure(item, depth + 1))
  return false
}

function eventType(rawType, data) {
  if (rawType === 'user/message') return 'user'
  if (rawType === 'assistant/message') return 'assistant'
  if (rawType === 'tool/call') return 'tool_call'
  if (rawType === 'tool/result') return 'tool_result'
  if (rawType === 'assistant/chunk') return 'system'
  if (/(?:^|\/)error$/.test(rawType)) return 'error'
  if (rawType === 'system' || /^(?:turn|step|request|session)\//.test(rawType) || rawType.startsWith('llm/retry')) return 'system'
  return 'unknown'
}

function summaryFor(type, rawType, tool, category, success) {
  if (type === 'user') return 'User message (content hidden)'
  if (type === 'assistant') return 'Assistant message (content hidden)'
  if (type === 'tool_call') {
    const labels = { read: 'file read', search: 'repository search', write: 'file write', shell: 'shell command', other: 'tool' }
    return `Called ${tool} (${labels[category]})`
  }
  if (type === 'tool_result') return success === false ? `Tool ${tool || 'operation'} failed` : `Tool ${tool || 'operation'} completed`
  if (type === 'error') return 'Execution error (details hidden)'
  if (rawType === 'llm/retry') return 'Model request retry'
  if (rawType === 'llm/retry-started') return 'Model request retry started'
  if (rawType === 'step/start') return 'Step started'
  if (rawType === 'step/end') return 'Step completed'
  if (rawType === 'turn/start') return 'Turn started'
  if (rawType === 'turn/end') return 'Turn completed'
  if (rawType === 'request/header') return 'Model request metadata'
  if (rawType === 'assistant/chunk') return 'Token usage reported'
  return `Unrecognized event: ${safeLabel(rawType, 'unknown', 80)}`
}

function sourceModel(rawType, data) {
  const candidate = rawType === 'request/header'
    ? data?.header?.config?.model ?? data?.config?.model
    : data?.message?.source?.model ?? data?.source?.model ?? data?.model
  return safeIdentifier(candidate, null, 120)
}

function tokenUsage(data) {
  const usage = data?.usage
    ?? data?.message?.usage
    ?? (data?.chunk?.type === 'usage' ? data.chunk.usage : null)
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = Number(usage.inputTokens)
  const outputTokens = Number(usage.outputTokens)
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
  }
}

function statusFromTurnReason(reason) {
  const value = reason && typeof reason === 'object' ? reason.kind : reason
  const normalized = String(value ?? '').toLowerCase()
  if (['stop', 'success', 'completed', 'complete'].includes(normalized)) return 'success'
  if (['error', 'failed', 'failure', 'cancelled', 'canceled', 'aborted', 'blocked', 'interrupted', 'max-tokens'].includes(normalized)) return 'failed'
  return 'unknown'
}

function turnStepKey(data) {
  if (data?.turn == null || data?.step == null) return null
  const turn = Number(data?.turn)
  const step = Number(data?.step)
  return Number.isInteger(turn) && Number.isInteger(step) ? `${turn}:${step}` : null
}

function normalizeDshRecords(parsed, options = {}) {
  const header = parsed.header && typeof parsed.header === 'object' ? parsed.header : {}
  const records = Array.isArray(parsed.records) ? parsed.records : []
  const steps = []
  const callsById = new Map()
  const unpairedCalls = []
  const timestamps = []
  let model = null
  let terminalStatus = 'unknown'
  const usageChunkKeys = new Set(records
    .filter((record) => record?.type === 'assistant/chunk' && record?.data?.chunk?.type === 'usage')
    .map((record) => turnStepKey(record.data))
    .filter(Boolean))

  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const sourceType = typeof record.type === 'string' ? record.type : 'unknown'
    const rawType = safeIdentifier(sourceType, 'unknown', 120, /^[A-Za-z0-9][A-Za-z0-9._/\-]*$/)
    if (PACKED_STORAGE_TYPES.has(sourceType)) continue
    const data = record.data && typeof record.data === 'object' ? record.data : {}
    if (sourceType === 'assistant/chunk' && data.chunk?.type !== 'usage') continue
    const timestamp = toIso(record.time ?? record.timestamp)
    if (timestamp) timestamps.push(Date.parse(timestamp))
    const type = eventType(sourceType, data)
    const metadata = {}
    let tool = null
    let success = null
    let durationMs = data.durationMs != null && Number.isFinite(Number(data.durationMs)) ? Number(data.durationMs) : null

    const discoveredModel = sourceModel(sourceType, data)
    if (!model && discoveredModel) model = discoveredModel

    if (sourceType === 'step/start' || sourceType === 'step/end') metadata.lifecycle = sourceType
    if (sourceType === 'llm/retry') metadata.retry = true
    if (sourceType === 'turn/end') {
      terminalStatus = statusFromTurnReason(data.reason)
      const reasonKind = data.reason && typeof data.reason === 'object' ? data.reason.kind : data.reason
      if (String(reasonKind ?? '').toLowerCase() === 'error') metadata.terminalError = true
    }

    const usage = sourceType === 'assistant/message' && usageChunkKeys.has(turnStepKey(data))
      ? null
      : tokenUsage(data)
    if (usage) metadata.usage = usage

    if (type === 'tool_call') {
      tool = normalizedToolName(data.name ?? data.tool ?? data.toolName)
      const args = parseArguments(data.arguments ?? data.args ?? data.input)
      const category = normalizeToolCategory(tool, args)
      const signature = argumentSignature(tool, args)
      const callId = extractCallId(data)
      metadata.callSignature = signature
      metadata.toolCategory = category
      metadata.pathBasenames = [...collectPathBasenames(args)].sort()
      metadata.testCommand = category === 'test'
      if (callId != null) metadata.callIdHash = sha256(callId).slice(0, 16)
      const callInfo = {
        callId: callId == null ? null : String(callId),
        category,
        signature,
        stepIndex: steps.length,
        timestamp,
        tool,
      }
      if (callInfo.callId) callsById.set(callInfo.callId, callInfo)
      unpairedCalls.push(callInfo)
    } else if (type === 'tool_result') {
      const callId = extractCallId(data)
      let callInfo = callId == null ? null : callsById.get(String(callId))
      if (!callInfo) {
        const namedTool = safeIdentifier(data.name ?? data.tool ?? data.toolName, null, 80)
        callInfo = [...unpairedCalls].reverse().find((candidate) => !candidate.paired && (!namedTool || candidate.tool === namedTool)) ?? null
      }
      if (callInfo) {
        callInfo.paired = true
        tool = callInfo.tool
        metadata.callSignature = callInfo.signature
        metadata.relatedCallIndex = callInfo.stepIndex
        metadata.toolCategory = callInfo.category
        metadata.testCommand = callInfo.category === 'test' && Boolean(steps[callInfo.stepIndex]?.metadata.testCommand)
        if (durationMs == null && timestamp && callInfo.timestamp) {
          durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(callInfo.timestamp))
        }
      } else {
        tool = normalizedToolName(data.name ?? data.tool ?? data.toolName)
        metadata.toolCategory = normalizeToolCategory(tool, {})
      }
      if (callId != null) metadata.callIdHash = sha256(callId).slice(0, 16)
      success = !(hasStructuredFailure(data) || contentIndicatesFailure(data))
    } else if (type === 'unknown') {
      metadata.unknownData = sanitizeMetadata(data, { preserveStrings: false })
    }

    const step = createCanonicalStep({
      index: steps.length,
      timestamp,
      type,
      tool,
      summary: summaryFor(type, rawType, tool, metadata.toolCategory, success),
      rawType,
      durationMs,
      success,
      metadata,
    })
    steps.push(step)
  }

  const headerTime = toIso(header.createdAt ?? header.startedAt)
  if (headerTime) timestamps.push(Date.parse(headerTime))
  timestamps.sort((a, b) => a - b)
  const startedAt = headerTime ?? (timestamps.length ? new Date(timestamps[0]).toISOString() : null)
  const endedAt = timestamps.length ? new Date(timestamps.at(-1)).toISOString() : startedAt
  const durationMs = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null
  const originalId = header.id ?? options.identitySeed ?? JSON.stringify(records.map((item) => [item?.type, item?.seq, item?.time]))
  const runId = options.runId ?? `run-${sha256(originalId).slice(0, 20)}`
  const run = createCanonicalRun({
    runId,
    sourceVersion: header.version == null ? null : safeIdentifier(String(header.version), null, 32),
    startedAt,
    endedAt,
    durationMs,
    model,
    workspace: basenameOnly(header.cwd ?? options.workspace),
    status: terminalStatus,
    steps,
  })
  run.metrics = calculateMetrics(run)
  Object.defineProperty(run, '_diagnostics', {
    value: {
      malformedLines: parsed.diagnostics?.malformedLines ?? 0,
      missingHeader: !parsed.header,
      unknownEvents: steps.filter((step) => step.type === 'unknown').length,
    },
    enumerable: false,
  })
  return run
}

module.exports = {
  argumentSignature,
  isTestCommand,
  normalizeDshRecords,
  parseArguments,
  toolCategory: normalizeToolCategory,
  toIso,
}
