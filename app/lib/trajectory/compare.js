'use strict'

const { analyzeRun } = require('./metrics')

const METRICS = Object.freeze([
  ['duration_ms', 'duration'],
  ['total_steps', 'steps'],
  ['tool_calls', 'tool calls'],
  ['failed_tool_calls', 'failed tool calls'],
  ['retry_count', 'retries'],
  ['unique_tools', 'unique tools'],
  ['files_read', 'file reads'],
  ['files_written', 'file writes'],
  ['shell_commands', 'shell commands'],
  ['total_tokens', 'tokens'],
])

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function metricDiff(metric, runA, runB) {
  const a = finiteOrNull(runA.metrics[metric])
  const b = finiteOrNull(runB.metrics[metric])
  const available = a != null && b != null
  return {
    a,
    b,
    delta: available ? b - a : null,
    available,
    lowerValueRun: available && a !== b ? (a < b ? 'A' : 'B') : null,
  }
}

function addDivergence(list, type, severity, run, stepIndexes, message) {
  list.push({
    type,
    severity,
    run,
    stepIndexes: [...new Set(stepIndexes.filter(Number.isInteger))],
    message,
  })
}

function compareRepeatedLoops(divergences, a, b) {
  for (const [label, own, other] of [['A', a, b], ['B', b, a]]) {
    for (const group of own.repeatedGroups) {
      const counterpart = other.repeatedGroups.find((item) => item.signature === group.signature)
      if (counterpart && counterpart.stepIndexes.length >= group.stepIndexes.length) continue
      const operation = group.category === 'search' ? 'repository search' : `${group.tool} call`
      addDivergence(
        divergences,
        'repeated_tool_loop',
        'warning',
        label,
        group.stepIndexes,
        `Run ${label} repeated the same ${operation} ${group.stepIndexes.length} times.`,
      )
    }
  }
}

function compareExtraFailures(divergences, a, b) {
  const difference = a.failedShellResults.length - b.failedShellResults.length
  if (difference === 0) return
  const label = difference > 0 ? 'A' : 'B'
  const analysis = difference > 0 ? a : b
  const count = Math.abs(difference)
  addDivergence(
    divergences,
    'extra_failed_command',
    'warning',
    label,
    analysis.failedShellResults.map((step) => step.index),
    `Run ${label} had ${count} additional failed shell command${count === 1 ? '' : 's'}.`,
  )
}

function compareFileChurn(divergences, a, b) {
  const difference = a.writeSteps.length - b.writeSteps.length
  if (Math.abs(difference) < 2) return
  const label = difference > 0 ? 'A' : 'B'
  const own = difference > 0 ? a : b
  const other = difference > 0 ? b : a
  addDivergence(
    divergences,
    'unnecessary_file_churn',
    'warning',
    label,
    own.writeSteps.map((step) => step.index),
    `Run ${label} performed ${own.writeSteps.length - other.writeSteps.length} additional file writes.`,
  )
}

function compareSearchReadPaths(divergences, a, b) {
  const difference = a.readSearchSteps.length - b.readSearchSteps.length
  if (Math.abs(difference) < 2) return
  const label = difference > 0 ? 'A' : 'B'
  const own = difference > 0 ? a : b
  const other = difference > 0 ? b : a
  addDivergence(
    divergences,
    'extra_search_read_path',
    'info',
    label,
    own.readSearchSteps.map((step) => step.index),
    `Run ${label} used ${own.readSearchSteps.length - other.readSearchSteps.length} additional search/read operations.`,
  )
}

function compareTestTiming(divergences, a, b) {
  if (a.firstTestCallOrdinal == null || b.firstTestCallOrdinal == null) return
  const difference = a.firstTestCallOrdinal - b.firstTestCallOrdinal
  if (difference === 0) return
  const laterLabel = difference > 0 ? 'A' : 'B'
  const later = difference > 0 ? a : b
  const earlier = difference > 0 ? b : a
  addDivergence(
    divergences,
    'test_execution_timing',
    'info',
    laterLabel,
    [earlier.firstTestCall.index, later.firstTestCall.index],
    `Run ${laterLabel} executed tests later (${later.firstTestCallOrdinal + 1}th vs ${earlier.firstTestCallOrdinal + 1}th tool call).`,
  )
}

function compareRecovery(divergences, a, b) {
  for (const [label, analysis] of [['A', a], ['B', b]]) {
    if (analysis.recoveries.length > 0) {
      const indexes = analysis.recoveries.flatMap((item) => [item.failureIndex, item.recoveryIndex])
      addDivergence(
        divergences,
        'failure_recovery',
        'info',
        label,
        indexes,
        `Run ${label} failed a shell command and later recovered with the same command.`,
      )
    }
    if (analysis.unrecoveredShellResults.length > 0) {
      addDivergence(
        divergences,
        'unrecovered_failure',
        'warning',
        label,
        analysis.unrecoveredShellResults.map((step) => step.index),
        `Run ${label} ended without a matching successful retry for a failed shell command.`,
      )
    }
  }
}

function efficiencySignals(metricDiffs) {
  const signals = []
  for (const [metric, noun] of [['total_steps', 'steps'], ['tool_calls', 'tool calls']]) {
    const diff = metricDiffs[metric]
    if (!diff.available || diff.delta === 0) continue
    const label = diff.delta < 0 ? 'B' : 'A'
    signals.push(`Run ${label} used ${Math.abs(diff.delta)} fewer ${noun}.`)
  }
  return signals
}

function publicRunSummary(run, label) {
  return {
    label: `Run ${label}`,
    runId: run.runId,
    startedAt: run.startedAt,
    model: run.model,
    workspace: run.workspace,
    status: run.status,
  }
}

function compareRuns(runA, runB) {
  if (!runA || !runB) throw new TypeError('Two canonical runs are required')
  const metricDiffs = {}
  for (const [metric] of METRICS) metricDiffs[metric] = metricDiff(metric, runA, runB)

  const analysisA = analyzeRun(runA)
  const analysisB = analyzeRun(runB)
  const divergences = []
  compareRepeatedLoops(divergences, analysisA, analysisB)
  compareExtraFailures(divergences, analysisA, analysisB)
  compareFileChurn(divergences, analysisA, analysisB)
  compareSearchReadPaths(divergences, analysisA, analysisB)
  compareTestTiming(divergences, analysisA, analysisB)
  compareRecovery(divergences, analysisA, analysisB)

  return {
    summary: {
      runA: publicRunSummary(runA, 'A'),
      runB: publicRunSummary(runB, 'B'),
      efficiencySignals: efficiencySignals(metricDiffs),
    },
    metricDiffs,
    divergences,
  }
}

module.exports = {
  METRICS,
  compareRuns,
}
