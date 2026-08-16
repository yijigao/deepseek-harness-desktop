'use strict'

const REPEAT_CALL_WINDOW = 5
const REPEAT_TIME_WINDOW_MS = 120_000

function timestampMs(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function analyzeRun(run) {
  const calls = run.steps.filter((step) => step.type === 'tool_call')
  const results = run.steps.filter((step) => step.type === 'tool_result')
  const repeatedGroups = []
  const groupBySignature = new Map()
  let repeatedToolCalls = 0

  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]
    const signature = call.metadata.callSignature
    if (!signature) continue
    let previous = null
    for (let j = i - 1; j >= Math.max(0, i - REPEAT_CALL_WINDOW); j -= 1) {
      if (calls[j].metadata.callSignature !== signature) continue
      const currentTime = timestampMs(call.timestamp)
      const previousTime = timestampMs(calls[j].timestamp)
      if (currentTime != null && previousTime != null && currentTime - previousTime > REPEAT_TIME_WINDOW_MS) continue
      previous = calls[j]
      break
    }
    if (!previous) {
      const completedGroup = groupBySignature.get(signature)
      if (completedGroup && completedGroup.stepIndexes.length >= 3) repeatedGroups.push(completedGroup)
      groupBySignature.set(signature, {
        signature,
        tool: call.tool,
        category: call.metadata.toolCategory ?? 'other',
        stepIndexes: [call.index],
      })
      continue
    }
    repeatedToolCalls += 1
    let group = groupBySignature.get(signature)
    if (!group) {
      group = {
        signature,
        tool: call.tool,
        category: call.metadata.toolCategory ?? 'other',
        stepIndexes: [previous.index],
      }
      groupBySignature.set(signature, group)
    }
    group.stepIndexes.push(call.index)
  }

  for (const group of groupBySignature.values()) {
    if (group.stepIndexes.length >= 3 && !repeatedGroups.includes(group)) repeatedGroups.push(group)
  }

  const failedResults = results.filter((step) => step.success === false)
  const failedShellResults = failedResults.filter((step) => step.metadata.toolCategory === 'shell')
  const successfulShellResults = results.filter((step) => step.success === true && step.metadata.toolCategory === 'shell')
  const recoveries = []

  for (const failure of failedShellResults) {
    const recovery = successfulShellResults.find((result) => (
      result.index > failure.index
      && result.metadata.callSignature
      && result.metadata.callSignature === failure.metadata.callSignature
    ))
    if (recovery) recoveries.push({ failureIndex: failure.index, recoveryIndex: recovery.index })
  }
  const recoveredFailureIndexes = new Set(recoveries.map((item) => item.failureIndex))
  const unrecoveredShellResults = failedShellResults.filter((step) => !recoveredFailureIndexes.has(step.index))

  const firstTestCall = calls.find((step) => step.metadata.testCommand === true) ?? null
  const firstTestCallOrdinal = firstTestCall ? calls.indexOf(firstTestCall) : null
  const readSearchSteps = calls.filter((step) => ['read', 'search'].includes(step.metadata.toolCategory))
  const writeSteps = calls.filter((step) => step.metadata.toolCategory === 'write')

  return {
    calls,
    failedResults,
    failedShellResults,
    firstTestCall,
    firstTestCallOrdinal,
    readSearchSteps,
    recoveries,
    repeatedGroups,
    repeatedToolCalls,
    results,
    unrecoveredShellResults,
    writeSteps,
  }
}

function calculateMetrics(run) {
  const analysis = analyzeRun(run)
  const tools = new Set(analysis.calls.map((step) => step.tool).filter(Boolean))
  const usageSteps = run.steps.filter((step) => step.metadata.usage)
  const hasInputUsage = usageSteps.some((step) => Number.isFinite(step.metadata.usage.inputTokens))
  const hasOutputUsage = usageSteps.some((step) => Number.isFinite(step.metadata.usage.outputTokens))
  const inputTokens = hasInputUsage
    ? usageSteps.reduce((sum, step) => sum + (Number.isFinite(step.metadata.usage.inputTokens) ? step.metadata.usage.inputTokens : 0), 0)
    : null
  const outputTokens = hasOutputUsage
    ? usageSteps.reduce((sum, step) => sum + (Number.isFinite(step.metadata.usage.outputTokens) ? step.metadata.usage.outputTokens : 0), 0)
    : null
  const totalTokens = hasInputUsage || hasOutputUsage ? (inputTokens ?? 0) + (outputTokens ?? 0) : null
  const explicitErrors = run.steps.filter((step) => step.type === 'error' || step.metadata.terminalError === true).length

  return {
    total_steps: run.steps.filter((step) => step.metadata.lifecycle === 'step/end').length,
    user_messages: run.steps.filter((step) => step.type === 'user').length,
    assistant_messages: run.steps.filter((step) => step.type === 'assistant').length,
    tool_calls: analysis.calls.length,
    tool_results: analysis.results.length,
    failed_tool_calls: analysis.failedResults.length,
    unique_tools: tools.size,
    repeated_tool_calls: analysis.repeatedToolCalls,
    duration_ms: Number.isFinite(run.durationMs) ? run.durationMs : null,
    files_read: analysis.calls.filter((step) => step.metadata.toolCategory === 'read').length,
    files_written: analysis.writeSteps.length,
    shell_commands: analysis.calls.filter((step) => step.metadata.toolCategory === 'shell').length,
    failed_shell_commands: analysis.failedShellResults.length,
    retry_count: run.steps.filter((step) => step.metadata.retry === true).length,
    error_count: explicitErrors + analysis.failedResults.length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  }
}

module.exports = {
  REPEAT_CALL_WINDOW,
  REPEAT_TIME_WINDOW_MS,
  analyzeRun,
  calculateMetrics,
}
