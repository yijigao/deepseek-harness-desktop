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
      const operation = group.category === 'search' ? '仓库搜索' : `${group.tool} 工具调用`
      addDivergence(
        divergences,
        'repeated_tool_loop',
        'warning',
        label,
        group.stepIndexes,
        `运行 ${label} 使用相同参数重复执行了 ${group.stepIndexes.length} 次${operation}。`,
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
    `运行 ${label} 多出 ${count} 次失败的命令行调用。`,
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
    `运行 ${label} 多执行了 ${own.writeSteps.length - other.writeSteps.length} 次文件写入。`,
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
    `运行 ${label} 多执行了 ${own.readSearchSteps.length - other.readSearchSteps.length} 次搜索或读取。`,
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
    `运行 ${laterLabel} 更晚才执行测试（第 ${later.firstTestCallOrdinal + 1} 次工具调用，对方为第 ${earlier.firstTestCallOrdinal + 1} 次）。`,
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
        `运行 ${label} 的命令曾失败，但随后使用相同命令恢复成功。`,
      )
    }
    if (analysis.unrecoveredShellResults.length > 0) {
      addDivergence(
        divergences,
        'unrecovered_failure',
        'warning',
        label,
        analysis.unrecoveredShellResults.map((step) => step.index),
        `运行 ${label} 结束时仍有失败命令未通过重试恢复。`,
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

function buildDiagnosis(runA, runB, metricDiffs, divergences) {
  const findings = []
  const recommendations = []
  const delta = (name) => metricDiffs[name]?.available ? metricDiffs[name].delta : null
  const fewer = (name, noun) => {
    const value = delta(name)
    if (!value) return
    const better = value < 0 ? 'B' : 'A'
    findings.push({
      tone: 'positive',
      text: `运行 ${better} 少用了 ${Math.abs(value).toLocaleString()} ${noun}。`,
    })
  }

  fewer('tool_calls', '次工具调用')
  fewer('total_steps', '个执行步骤')
  fewer('retry_count', '次重试')
  fewer('failed_tool_calls', '次失败工具调用')

  const durationDelta = delta('duration_ms')
  if (durationDelta) {
    const faster = durationDelta < 0 ? 'B' : 'A'
    findings.push({ tone: 'positive', text: `运行 ${faster} 用时更短，差值约 ${Math.round(Math.abs(durationDelta) / 1000).toLocaleString()} 秒。` })
  }

  const warningsByRun = { A: [], B: [] }
  for (const item of divergences) {
    if ((item.severity === 'warning' || item.severity === 'error') && warningsByRun[item.run]) {
      warningsByRun[item.run].push(item.type)
    }
  }
  for (const label of ['A', 'B']) {
    const types = new Set(warningsByRun[label])
    if (types.has('repeated_tool_loop')) recommendations.push(`检查运行 ${label} 的提示词或搜索策略，避免对相同参数重复调用工具。`)
    if (types.has('extra_failed_command') || types.has('unrecovered_failure')) recommendations.push(`优先修复运行 ${label} 的失败命令，并在重试前调整参数或执行路径。`)
    if (types.has('unnecessary_file_churn')) recommendations.push(`收紧运行 ${label} 的文件修改范围，并在写入前明确目标文件。`)
  }
  const lateTest = divergences.find((item) => item.type === 'test_execution_timing')
  if (lateTest) recommendations.push(`运行 ${lateTest.run} 较晚运行测试；建议在关键修改后更早执行最小验证。`)

  const statusRank = (status) => status === 'success' ? 2 : status === 'failed' || status === 'error' ? 0 : 1
  const rankA = statusRank(runA.status)
  const rankB = statusRank(runB.status)
  let winner = null
  if (rankA !== rankB) winner = rankA > rankB ? 'A' : 'B'
  else {
    const score = (label) => {
      const sign = label === 'A' ? -1 : 1
      return (
        (delta('failed_tool_calls') ?? 0) * sign * 8
        + (delta('retry_count') ?? 0) * sign * 4
        + (delta('tool_calls') ?? 0) * sign
        + (delta('total_steps') ?? 0) * sign
      )
    }
    const scoreA = score('A')
    const scoreB = score('B')
    if (scoreA !== scoreB) winner = scoreA < scoreB ? 'A' : 'B'
  }

  const headline = winner
    ? `运行 ${winner} 的执行轨迹整体更精简、稳定。`
    : '两次运行各有取舍，暂时没有明确更优者。'
  if (recommendations.length === 0) recommendations.push('当前未发现明显的规则级问题；结合最终产物质量决定保留哪次配置。')

  return {
    verdict: winner ? `${winner.toLowerCase()}_better` : 'mixed',
    headline,
    findings: findings.slice(0, 5),
    recommendations: [...new Set(recommendations)].slice(0, 4),
    caveat: '结论只评价执行轨迹，不判断最终产物的业务质量。',
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

  const diagnosis = buildDiagnosis(runA, runB, metricDiffs, divergences)

  return {
    summary: {
      runA: publicRunSummary(runA, 'A'),
      runB: publicRunSummary(runB, 'B'),
      efficiencySignals: efficiencySignals(metricDiffs),
    },
    metricDiffs,
    divergences,
    diagnosis,
  }
}

module.exports = {
  METRICS,
  compareRuns,
}
