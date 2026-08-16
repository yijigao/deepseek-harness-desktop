'use strict'

const crypto = require('node:crypto')
const { createCanonicalRun, createCanonicalStep } = require('../schema')
const { calculateMetrics } = require('../metrics')
const { argumentSignature, parseArguments, toIso } = require('../normalize')
const { basenameOnly, safeIdentifier, safeLabel, sanitizeMetadata } = require('../redaction')
const { normalizeToolCategory } = require('../tool-categories')

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function parseCodexLines(input) {
  const records = []
  let malformedLines = 0
  let blankLines = 0
  for (const line of String(input).split(/\r?\n/)) {
    if (!line.trim()) {
      blankLines += 1
      continue
    }
    try {
      records.push(JSON.parse(line))
    } catch {
      malformedLines += 1
    }
  }
  return { records, diagnostics: { blankLines, malformedLines } }
}

function rawTypeFor(record) {
  const envelope = safeIdentifier(record?.type, 'unknown', 80) ?? 'unknown'
  const nested = safeIdentifier(record?.payload?.type, null, 100)
  return nested ? `${envelope}/${nested}` : envelope
}

function messageRole(payload) {
  const role = String(payload?.role ?? '').toLowerCase()
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'system'
}

function eventType(record) {
  const envelope = record?.type
  const payloadType = record?.payload?.type
  if (envelope === 'response_item' && payloadType === 'message') return messageRole(record.payload)
  if (envelope === 'response_item' && ['function_call', 'custom_tool_call'].includes(payloadType)) return 'tool_call'
  if (envelope === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payloadType)) return 'tool_result'
  if (envelope === 'event_msg' && ['agent_message', 'user_message'].includes(payloadType)) return payloadType === 'user_message' ? 'user' : 'assistant'
  if (envelope === 'event_msg' && /(?:error|failed|failure)$/.test(String(payloadType ?? ''))) return 'error'
  if (envelope === 'response_item' && payloadType === 'reasoning') return 'system'
  if (['session_meta', 'turn_context', 'world_state', 'compacted', 'inter_agent_communication_metadata'].includes(envelope)) return 'system'
  if (envelope === 'event_msg') return 'system'
  return 'unknown'
}

function summaryFor(type, rawType, tool, success) {
  if (type === 'user') return 'User message (content hidden)'
  if (type === 'assistant') return 'Assistant message (content hidden)'
  if (type === 'tool_call') return `Called ${tool || 'tool'}`
  if (type === 'tool_result') return success === false ? `Tool ${tool || 'operation'} failed` : `Tool ${tool || 'operation'} completed`
  if (type === 'error') return 'Execution error (details hidden)'
  if (rawType === 'event_msg/task_started') return 'Task started'
  if (rawType === 'event_msg/task_complete') return 'Task completed'
  if (rawType === 'event_msg/token_count') return 'Token usage reported'
  return rawType.startsWith('response_item/reasoning') ? 'Reasoning event (content hidden)' : `Codex event: ${safeLabel(rawType, 'unknown', 100)}`
}

function toolName(payload) {
  const namespace = safeIdentifier(payload?.namespace, null, 40)
  const name = safeIdentifier(payload?.name, 'unknown-tool', 80) ?? 'unknown-tool'
  return namespace ? `${namespace}.${name}` : name
}

function toolArguments(payload) {
  return parseArguments(payload?.arguments ?? payload?.input)
}

function toolSucceeded(payload) {
  if (payload?.status && /^(?:failed|error|cancelled)$/i.test(String(payload.status))) return false
  const output = payload?.output
  if (output && typeof output === 'object') {
    if (output.isError === true) return false
    if (Number.isFinite(Number(output.exit_code)) && Number(output.exit_code) !== 0) return false
  }
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output)
      if (parsed?.isError === true || (Number.isFinite(Number(parsed?.exit_code)) && Number(parsed.exit_code) !== 0)) return false
    } catch {}
  }
  return true
}

function usageFrom(record) {
  if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') return null
  const usage = record.payload?.info?.total_token_usage
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = Number(usage.input_tokens)
  const outputTokens = Number(usage.output_tokens)
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
  }
}

function normalizeCodexRecords(parsed, options = {}) {
  const records = Array.isArray(parsed.records) ? parsed.records : []
  const steps = []
  const calls = new Map()
  const pendingCalls = []
  const timestamps = []
  let sessionMeta = null
  let model = null
  let workspace = null
  let terminalStatus = 'unknown'
  let latestUsage = null

  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'session_meta' && !sessionMeta) sessionMeta = record.payload && typeof record.payload === 'object' ? record.payload : {}
    if (record.type === 'turn_context') {
      model = safeIdentifier(record.payload?.model, model, 120)
      workspace = basenameOnly(record.payload?.cwd) ?? workspace
    }
    const usage = usageFrom(record)
    if (usage) latestUsage = usage

    const timestamp = toIso(record.timestamp ?? record.payload?.timestamp ?? record.payload?.completed_at ?? record.payload?.started_at)
    if (timestamp) timestamps.push(Date.parse(timestamp))
    const rawType = rawTypeFor(record)
    const type = eventType(record)
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {}
    const metadata = {}
    let tool = null
    let success = null
    let durationMs = Number.isFinite(Number(payload.duration_ms ?? payload.duration)) ? Number(payload.duration_ms ?? payload.duration) : null

    if (rawType === 'event_msg/task_started') metadata.lifecycle = 'step/start'
    if (rawType === 'event_msg/task_complete') {
      metadata.lifecycle = 'step/end'
      terminalStatus = 'success'
    }
    if (rawType === 'event_msg/turn_aborted') terminalStatus = 'failed'
    if (rawType === 'event_msg/context_compacted') metadata.retry = false

    if (type === 'tool_call') {
      tool = toolName(payload)
      const args = toolArguments(payload)
      const categoryArgs = payload.type === 'custom_tool_call' && payload.name === 'exec'
        ? { command: typeof payload.input === 'string' ? payload.input : '' }
        : args
      const category = normalizeToolCategory(tool, categoryArgs)
      const signature = argumentSignature(tool, args)
      const callId = payload.call_id == null ? null : String(payload.call_id)
      metadata.toolCategory = category
      metadata.callSignature = signature
      metadata.testCommand = category === 'test'
      if (callId) metadata.callIdHash = sha256(callId).slice(0, 16)
      const info = { callId, category, signature, stepIndex: steps.length, timestamp, tool, paired: false }
      if (callId) calls.set(callId, info)
      pendingCalls.push(info)
    } else if (type === 'tool_result') {
      const callId = payload.call_id == null ? null : String(payload.call_id)
      const call = (callId && calls.get(callId)) || [...pendingCalls].reverse().find((candidate) => !candidate.paired) || null
      if (call) {
        call.paired = true
        tool = call.tool
        metadata.toolCategory = call.category
        metadata.callSignature = call.signature
        metadata.relatedCallIndex = call.stepIndex
        metadata.testCommand = call.category === 'test'
        if (durationMs == null && timestamp && call.timestamp) durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(call.timestamp))
      } else {
        metadata.toolCategory = 'other'
      }
      if (callId) metadata.callIdHash = sha256(callId).slice(0, 16)
      success = toolSucceeded(payload)
    } else if (type === 'unknown') {
      metadata.unknownData = sanitizeMetadata(payload, { preserveStrings: false })
    }

    steps.push(createCanonicalStep({
      index: steps.length, timestamp, type, tool,
      summary: summaryFor(type, rawType, tool, success), rawType, durationMs, success, metadata,
    }))
  }

  if (latestUsage) {
    const usageStep = [...steps].reverse().find((step) => step.rawType === 'event_msg/token_count')
    if (usageStep) usageStep.metadata.usage = latestUsage
  }
  const metaTime = toIso(sessionMeta?.timestamp)
  if (metaTime) timestamps.push(Date.parse(metaTime))
  timestamps.sort((a, b) => a - b)
  const startedAt = metaTime ?? (timestamps.length ? new Date(timestamps[0]).toISOString() : null)
  const endedAt = timestamps.length ? new Date(timestamps.at(-1)).toISOString() : startedAt
  const originalId = sessionMeta?.id ?? sessionMeta?.session_id ?? options.identitySeed ?? JSON.stringify(records.map((record) => [record?.type, record?.timestamp]))
  const run = createCanonicalRun({
    runId: options.runId ?? `run-${sha256(originalId).slice(0, 20)}`,
    source: 'codex',
    sourceVersion: safeIdentifier(sessionMeta?.cli_version, null, 32),
    startedAt,
    endedAt,
    durationMs: startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
    model,
    workspace: workspace ?? basenameOnly(sessionMeta?.cwd ?? options.workspace),
    status: terminalStatus,
    steps,
  })
  run.metrics = calculateMetrics(run)
  Object.defineProperty(run, '_diagnostics', { value: {
    malformedLines: parsed.diagnostics?.malformedLines ?? 0,
    missingSessionMeta: !sessionMeta,
    unknownEvents: steps.filter((step) => step.type === 'unknown').length,
  }, enumerable: false })
  return run
}

function parseCodexJsonl(input, options = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input)
  return normalizeCodexRecords(parseCodexLines(text), { ...options, identitySeed: options.identitySeed ?? text })
}

module.exports = { normalizeCodexRecords, parseCodexJsonl, parseCodexLines }
