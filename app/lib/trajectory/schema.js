'use strict'

const STEP_TYPES = Object.freeze([
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'error',
  'system',
  'unknown',
])

const RUN_STATUSES = Object.freeze(['success', 'failed', 'unknown'])

function createCanonicalStep(overrides = {}) {
  const type = STEP_TYPES.includes(overrides.type) ? overrides.type : 'unknown'
  return {
    index: Number.isInteger(overrides.index) ? overrides.index : 0,
    timestamp: overrides.timestamp ?? null,
    type,
    tool: typeof overrides.tool === 'string' ? overrides.tool : null,
    summary: typeof overrides.summary === 'string' ? overrides.summary : '',
    rawType: typeof overrides.rawType === 'string' ? overrides.rawType : '',
    durationMs: Number.isFinite(overrides.durationMs) ? overrides.durationMs : null,
    success: typeof overrides.success === 'boolean' ? overrides.success : null,
    metadata: overrides.metadata && typeof overrides.metadata === 'object'
      ? overrides.metadata
      : {},
  }
}

function createCanonicalRun(overrides = {}) {
  const status = RUN_STATUSES.includes(overrides.status) ? overrides.status : 'unknown'
  return {
    runId: typeof overrides.runId === 'string' ? overrides.runId : '',
    source: overrides.source === 'codex' ? 'codex' : 'deepseek-harness',
    sourceVersion: overrides.sourceVersion == null ? null : String(overrides.sourceVersion),
    startedAt: overrides.startedAt ?? null,
    endedAt: overrides.endedAt ?? null,
    durationMs: Number.isFinite(overrides.durationMs) ? overrides.durationMs : null,
    model: typeof overrides.model === 'string' ? overrides.model : null,
    workspace: typeof overrides.workspace === 'string' ? overrides.workspace : null,
    status,
    steps: Array.isArray(overrides.steps) ? overrides.steps : [],
    metrics: overrides.metrics && typeof overrides.metrics === 'object'
      ? overrides.metrics
      : {},
  }
}

module.exports = {
  RUN_STATUSES,
  STEP_TYPES,
  createCanonicalRun,
  createCanonicalStep,
}
