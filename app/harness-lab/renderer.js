(() => {
  'use strict'

  const METRIC_DEFINITIONS = [
    { key: 'duration_ms', label: '耗时', kind: 'duration' },
    { key: 'total_steps', label: '步骤', kind: 'count' },
    { key: 'tool_calls', label: '工具调用', kind: 'count' },
    { key: 'failed_tool_calls', label: '失败', kind: 'count' },
    { key: 'retry_count', label: '重试', kind: 'count' },
    { key: 'total_tokens', label: 'Token', kind: 'count' },
  ]

  const METRIC_ALIASES = {
    duration_ms: ['duration_ms', 'durationMs', 'duration'],
    total_steps: ['total_steps', 'totalSteps', 'steps', 'step_count', 'stepCount'],
    tool_calls: ['tool_calls', 'toolCalls', 'total_tool_calls', 'totalToolCalls'],
    failed_tool_calls: ['failed_tool_calls', 'failedToolCalls', 'failures', 'failed_calls', 'error_count', 'errorCount'],
    retry_count: ['retry_count', 'retryCount', 'retries'],
    error_count: ['error_count', 'errorCount', 'errors', 'failed_tool_calls', 'failedToolCalls'],
    input_tokens: ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'],
    output_tokens: ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'],
    total_tokens: ['total_tokens', 'totalTokens', 'tokens'],
  }

  const SIDE_ALIASES = {
    a: ['a', 'runA', 'run_a', 'left', 'before', 'base'],
    b: ['b', 'runB', 'run_b', 'right', 'after', 'candidate'],
  }

  const PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|tmp|var|mnt|workspace|root)(?:[\\/]|$))/i
  const RAW_CONTENT_RE = /(?:^|\s)(?:system|user|assistant|prompt|message)\s*[:>]/i

  const elements = {
    tabRuns: document.getElementById('tab-runs'),
    tabCompare: document.getElementById('tab-compare'),
    panelRuns: document.getElementById('panel-runs'),
    panelCompare: document.getElementById('panel-compare'),
    runsCount: document.getElementById('runs-count'),
    compareTabState: document.getElementById('compare-tab-state'),
    refreshRuns: document.getElementById('refresh-runs'),
    refreshEmpty: document.getElementById('refresh-empty'),
    runsFeedback: document.getElementById('runs-feedback'),
    runsEmpty: document.getElementById('runs-empty'),
    runsTableWrap: document.getElementById('runs-table-wrap'),
    runsBody: document.getElementById('runs-body'),
    selectionAName: document.getElementById('selection-a-name'),
    selectionBName: document.getElementById('selection-b-name'),
    compareSelected: document.getElementById('compare-selected'),
    compareFeedback: document.getElementById('compare-feedback'),
    compareEmpty: document.getElementById('compare-empty'),
    openRuns: document.getElementById('open-runs'),
    compareRunPair: document.getElementById('compare-run-pair'),
    runComparison: document.getElementById('run-comparison'),
    compareContent: document.getElementById('compare-content'),
    summaryCards: document.getElementById('summary-cards'),
    diagnosisHeadline: document.getElementById('diagnosis-headline'),
    diagnosisFindings: document.getElementById('diagnosis-findings'),
    diagnosisRecommendations: document.getElementById('diagnosis-recommendations'),
    diagnosisCaveat: document.getElementById('diagnosis-caveat'),
    divergenceCount: document.getElementById('divergence-count'),
    divergenceList: document.getElementById('divergence-list'),
    metricDiffs: document.getElementById('metric-diffs'),
    copyBrief: document.getElementById('copy-brief'),
    exportReport: document.getElementById('export-report'),
    setBaseline: document.getElementById('set-baseline'),
    actionFeedback: document.getElementById('action-feedback'),
    runHealth: document.getElementById('run-health'),
    runHealthGate: document.getElementById('run-health-gate'),
    runHealthHeadline: document.getElementById('run-health-headline'),
    executionGate: document.getElementById('execution-gate'),
    businessGate: document.getElementById('business-gate'),
    testGate: document.getElementById('test-gate'),
    runHealthIssues: document.getElementById('run-health-issues'),
    runHealthActions: document.getElementById('run-health-actions'),
    runHealthCaveat: document.getElementById('run-health-caveat'),
    openOriginal: document.getElementById('open-original'),
    copyRunFix: document.getElementById('copy-run-fix'),
    runHealthFeedback: document.getElementById('run-health-feedback'),
  }

  const state = {
    activeTab: 'runs',
    runs: [],
    selectedA: null,
    selectedB: null,
    runsLoading: false,
    runsError: '',
    compareLoading: false,
    compareError: '',
    compareResult: null,
    compareRequest: 0,
    inspectedRunId: null,
    inspectedRun: null,
  }

  function getApi() {
    const api = window.harnessLab
    if (!api || typeof api.listRuns !== 'function' || typeof api.compareRuns !== 'function') {
      throw new Error('Harness Lab bridge is unavailable')
    }
    return api
  }

  function rawString(value) {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return ''
  }

  function compactString(value, fallback = '—', maxLength = 96) {
    const valueString = rawString(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!valueString) return fallback
    if (PATH_RE.test(valueString) || valueString.includes('/') || valueString.includes('\\')) return '[path hidden]'
    if (valueString.length <= maxLength) return valueString
    return `${valueString.slice(0, maxLength - 1).trimEnd()}…`
  }

  function summaryString(value, fallback = '暂无脱敏摘要。') {
    const valueString = rawString(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!valueString || PATH_RE.test(valueString) || valueString.includes('/') || valueString.includes('\\') || RAW_CONTENT_RE.test(valueString)) {
      return fallback
    }
    if (valueString.length > 260) return `${valueString.slice(0, 259).trimEnd()}…`
    return valueString
  }

  function numberOrNull(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  function metricFromObject(source, key) {
    if (!source || typeof source !== 'object') return null
    const aliases = METRIC_ALIASES[key] || [key]
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(source, alias)) {
        const value = numberOrNull(source[alias])
        if (value !== null) return value
      }
    }
    if (key === 'total_tokens') {
      const input = metricFromObject(source, 'input_tokens')
      const output = metricFromObject(source, 'output_tokens')
      if (input !== null || output !== null) return (input || 0) + (output || 0)
    }
    return null
  }

  function metricFromRun(run, key) {
    if (!run || typeof run !== 'object') return null
    return metricFromObject(run.metrics, key) ?? metricFromObject(run, key)
  }

  function timestampMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 100000000000 ? value * 1000 : value
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) return numeric < 100000000000 ? numeric * 1000 : numeric
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  function normalizeRun(value) {
    if (!value || typeof value !== 'object') return null
    const runId = rawString(value.runId || value.id)
    if (!runId) return null
    const metrics = value.metrics && typeof value.metrics === 'object' ? value.metrics : {}
    return {
      runId,
      startedAt: value.startedAt ?? value.started_at ?? null,
      model: rawString(value.model || value.modelName),
      status: rawString(value.status || 'unknown').toLowerCase(),
      isBaseline: value.isBaseline === true,
      lineageId: rawString(value.lineageId),
      hasParent: value.hasParent === true,
      metrics,
    }
  }

  function sortRuns(runs) {
    return [...runs].sort((left, right) => {
      const rightTime = timestampMs(right.startedAt)
      const leftTime = timestampMs(left.startedAt)
      if (rightTime !== null && leftTime !== null && rightTime !== leftTime) return rightTime - leftTime
      if (rightTime !== null && leftTime === null) return -1
      if (rightTime === null && leftTime !== null) return 1
      return right.runId.localeCompare(left.runId)
    })
  }

  function formatDate(value) {
    const timestamp = timestampMs(value)
    if (timestamp === null) return '—'
    try {
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return '—'
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    } catch {
      return '—'
    }
  }

  function formatDuration(value) {
    const duration = numberOrNull(value)
    if (duration === null || duration < 0) return '—'
    if (duration < 1000) return `${Math.round(duration)} ms`
    const seconds = duration / 1000
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
    const minutes = Math.floor(seconds / 60)
    const remainder = Math.round(seconds % 60)
    if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  }

  function formatCount(value) {
    const count = numberOrNull(value)
    if (count === null) return '—'
    return Math.round(count).toLocaleString()
  }

  function formatMetric(value, kind) {
    return kind === 'duration' ? formatDuration(value) : formatCount(value)
  }

  function formatDelta(value, kind) {
    const delta = numberOrNull(value)
    if (delta === null) return 'Δ —'
    if (kind === 'duration') {
      const sign = delta > 0 ? '+' : delta < 0 ? '-' : ''
      return `Δ ${sign}${formatDuration(Math.abs(delta))}`
    }
    const sign = delta > 0 ? '+' : ''
    return `Δ ${sign}${Math.round(delta).toLocaleString()}`
  }

  function displayStatus(value) {
    const normalized = rawString(value).replace(/[-_]+/g, ' ').trim()
    if (!normalized) return '未知'
    const labels = { success: '成功', completed: '已完成', complete: '已完成', passed: '通过', failed: '失败', error: '错误', crashed: '崩溃', running: '运行中', 'in-progress': '进行中', cancelled: '已取消', canceled: '已取消', timeout: '超时' }
    return labels[normalized] || compactString(normalized, '未知', 32)
  }

  function statusClass(value) {
    const normalized = rawString(value).toLowerCase().replace(/\s+/g, '-')
    const allowed = ['success', 'completed', 'complete', 'passed', 'failed', 'error', 'crashed', 'running', 'in-progress', 'cancelled', 'canceled', 'timeout']
    return allowed.includes(normalized) ? `status-${normalized}` : ''
  }

  function createTextElement(tagName, value, className) {
    const element = document.createElement(tagName)
    if (className) element.className = className
    element.textContent = value === null || value === undefined ? '' : String(value)
    return element
  }

  function createButton(label, className, attributes = {}) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = label
    for (const [name, value] of Object.entries(attributes)) {
      button.setAttribute(name, String(value))
    }
    return button
  }

  function setFeedback(element, message, kind = '') {
    if (!message) {
      element.hidden = true
      element.textContent = ''
      element.className = 'feedback'
      return
    }
    element.hidden = false
    element.className = `feedback${kind ? ` is-${kind}` : ''}`
    element.textContent = message
  }

  function selectedRun(side) {
    const runId = side === 'a' ? state.selectedA : state.selectedB
    return state.runs.find((run) => run.runId === runId) || null
  }

  function hasDistinctSelection() {
    return Boolean(state.selectedA && state.selectedB && state.selectedA !== state.selectedB)
  }

  function hasComparableSelection() {
    if (!hasDistinctSelection()) return false
    const runA = selectedRun('a')
    const runB = selectedRun('b')
    return Boolean(runA && runB && runA.lineageId && runA.lineageId === runB.lineageId)
  }

  function selectionLabel(side) {
    const run = selectedRun(side)
    return run ? compactString(run.runId, '已选择', 34) : '未选择'
  }

  function renderTabState() {
    const runsActive = state.activeTab === 'runs'
    elements.tabRuns.classList.toggle('is-active', runsActive)
    elements.tabRuns.setAttribute('aria-selected', String(runsActive))
    elements.tabRuns.tabIndex = runsActive ? 0 : -1
    elements.tabCompare.classList.toggle('is-active', !runsActive)
    elements.tabCompare.setAttribute('aria-selected', String(!runsActive))
    elements.tabCompare.tabIndex = runsActive ? -1 : 0
    elements.panelRuns.hidden = !runsActive
    elements.panelCompare.hidden = runsActive
  }

  function setActiveTab(tab) {
    state.activeTab = tab === 'compare' ? 'compare' : 'runs'
    renderTabState()
    if (state.activeTab === 'compare') renderCompare()
  }

  function renderSelection() {
    elements.selectionAName.textContent = selectionLabel('a')
    elements.selectionBName.textContent = selectionLabel('b')
    const ready = hasComparableSelection()
    elements.compareSelected.disabled = !ready || state.compareLoading
    elements.runComparison.disabled = !ready || state.compareLoading
    elements.compareTabState.textContent = ready ? '可以实验' : hasDistinctSelection() ? '任务不可比' : '请选择同任务尝试'
    elements.compareTabState.classList.toggle('is-ready', ready)
  }

  function renderRuns() {
    elements.runsCount.textContent = state.runs.length.toLocaleString()
    elements.runsBody.replaceChildren()
    elements.runsTableWrap.hidden = state.runs.length === 0 || state.runsLoading
    elements.runsEmpty.hidden = state.runs.length !== 0 || state.runsLoading || Boolean(state.runsError)

    for (const run of state.runs) {
      const row = document.createElement('tr')
      const selectorCell = document.createElement('td')
      selectorCell.className = 'select-column'
      const selectorPair = document.createElement('div')
      selectorPair.className = 'selector-pair'
      const selectA = createButton('A', 'select-run', {
        'data-select-side': 'a',
        'data-run-id': run.runId,
        'aria-label': `将 ${compactString(run.runId, '运行', 42)} 选为运行 A`,
        'aria-pressed': String(state.selectedA === run.runId),
      })
      const selectB = createButton('B', 'select-run', {
        'data-select-side': 'b',
        'data-run-id': run.runId,
        'aria-label': `将 ${compactString(run.runId, '运行', 42)} 选为运行 B`,
        'aria-pressed': String(state.selectedB === run.runId),
      })
      const inspect = createButton('体检', 'select-run inspect-run', {
        'data-action': 'inspect',
        'data-run-id': run.runId,
      })
      const open = createButton('原对话', 'select-run inspect-run', {
        'data-action': 'open',
        'data-run-id': run.runId,
      })
      if (state.selectedA === run.runId) selectA.classList.add('is-selected-a')
      if (state.selectedB === run.runId) selectB.classList.add('is-selected-b')
      selectorPair.append(selectA, selectB, inspect, open)
      selectorCell.append(selectorPair)
      row.append(selectorCell)

      const startedCell = createTextElement('td', formatDate(run.startedAt), 'time-cell')
      startedCell.title = compactString(run.runId, 'Run', 80)
      row.append(startedCell)
      if (run.isBaseline) startedCell.append(createTextElement('span', '基线', 'baseline-badge'))
      row.append(createTextElement('td', compactString(run.model, '未知模型', 42), 'model-cell'))
      row.append(createTextElement('td', formatDuration(metricFromRun(run, 'duration_ms')), 'metric-cell'))

      const statusCell = document.createElement('td')
      const statusBadge = createTextElement('span', displayStatus(run.status), `status-badge ${statusClass(run.status)}`.trim())
      statusCell.append(statusBadge)
      row.append(statusCell)

      row.append(createTextElement('td', formatCount(metricFromRun(run, 'total_steps')), 'metric-cell numeric-column'))
      row.append(createTextElement('td', formatCount(metricFromRun(run, 'tool_calls')), 'metric-cell numeric-column'))
      row.append(createTextElement('td', formatCount(metricFromRun(run, 'error_count')), 'metric-cell numeric-column'))
      elements.runsBody.append(row)
    }

    if (state.runsLoading) {
      elements.runsTableWrap.hidden = true
      elements.runsEmpty.hidden = true
    }
    if (state.runsLoading) {
      setFeedback(elements.runsFeedback, '正在读取运行摘要…', 'loading')
    } else {
      setFeedback(elements.runsFeedback, state.runsError, state.runsError ? 'error' : '')
    }
    elements.refreshRuns.disabled = state.runsLoading
    elements.refreshEmpty.disabled = state.runsLoading
    renderSelection()
  }

  function renderRunHealth() {
    const run = state.inspectedRun
    elements.runHealth.hidden = !run
    if (!run) return
    const diagnosis = run.diagnosis || {}
    document.getElementById('run-health-title').textContent = `任务体检 · ${compactString(run.workspace || run.model, '未知项目', 40)} · ${formatDate(run.startedAt)}`
    const gateLabels = { passed: '已完成', failed: '未完成', unknown: '未知' }
    elements.runHealthGate.textContent = gateLabels[diagnosis.executionGate] || '未知'
    elements.runHealthHeadline.textContent = summaryString(diagnosis.headline, '暂无体检结论。')
    elements.executionGate.textContent = gateLabels[diagnosis.executionGate] || '未知'
    elements.businessGate.textContent = '尚未验收'
    elements.testGate.textContent = diagnosis.testDetected ? '已检测' : '未检测'
    elements.runHealthIssues.replaceChildren(...(diagnosis.issues || []).map((item) => createTextElement('li', summaryString(item))))
    elements.runHealthActions.replaceChildren(...(diagnosis.actions || []).map((item) => createTextElement('li', summaryString(item))))
    elements.runHealthCaveat.textContent = summaryString(diagnosis.caveat, '执行完成不代表业务验收通过。')
  }

  async function inspectRun(runId) {
    elements.runHealth.hidden = false
    elements.runHealthHeadline.textContent = '正在生成单次任务体检…'
    elements.runHealthFeedback.textContent = ''
    try {
      state.inspectedRun = await getApi().getRun(runId)
      state.inspectedRunId = runId
      renderRunHealth()
      elements.runHealth.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (error) {
      elements.runHealthFeedback.textContent = `体检失败：${compactString(error && error.message, '未知错误', 120)}`
    }
  }

  async function openOriginalRun(runId) {
    try {
      const result = await getApi().openOriginal(runId)
      if (!result || !result.opened) elements.runHealthFeedback.textContent = '已切换到主窗口，但未能自动定位该历史对话。'
    } catch (error) {
      elements.runHealthFeedback.textContent = `无法打开原始对话：${compactString(error && error.message, '未知错误', 120)}`
    }
  }

  function findSideValue(source, key, side) {
    if (!source || typeof source !== 'object') return null
    const sideAliases = SIDE_ALIASES[side]
    const direct = metricFromObject(source, key)
    if (direct !== null && !sideAliases.some((alias) => source[alias] && typeof source[alias] === 'object')) return direct

    const metricObject = source[key]
    if (metricObject && typeof metricObject === 'object') {
      for (const alias of sideAliases) {
        const value = numberOrNull(metricObject[alias])
        if (value !== null) return value
      }
      const value = numberOrNull(metricObject[side])
      if (value !== null) return value
    }

    for (const alias of sideAliases) {
      const sideObject = source[alias]
      const value = metricFromObject(sideObject, key) ?? metricFromObject(sideObject && sideObject.metrics, key)
      if (value !== null) return value
    }

    const nestedMetrics = source.metrics
    if (nestedMetrics && nestedMetrics !== source) {
      const value = findSideValue(nestedMetrics, key, side)
      if (value !== null) return value
    }
    return direct
  }

  function findMetricDelta(source, key, sideA, sideB) {
    if (Array.isArray(source)) {
      const entry = source.find((candidate) => {
        if (!candidate || typeof candidate !== 'object') return false
        const metricName = rawString(candidate.metric || candidate.key || candidate.name)
        return metricName === key || METRIC_ALIASES[key].includes(metricName)
      })
      if (entry) {
        for (const alias of ['diff', 'delta', 'difference', 'change']) {
          const value = numberOrNull(entry[alias])
          if (value !== null) return value
        }
      }
    }
    if (source && typeof source === 'object') {
      const sourceValue = source[key]
      if (sourceValue && typeof sourceValue === 'object') {
        for (const alias of ['diff', 'delta', 'difference', 'change']) {
          const value = numberOrNull(sourceValue[alias])
          if (value !== null) return value
        }
      }
      for (const alias of [key, ...METRIC_ALIASES[key]]) {
        const value = numberOrNull(source[`${alias}Diff`] ?? source[`${alias}_diff`] ?? source[`${alias}Delta`] ?? source[`${alias}_delta`])
        if (value !== null) return value
      }
    }
    if (sideA !== null && sideB !== null) return sideB - sideA
    return null
  }

  function compareMetricValue(result, key, side, fallbackRun) {
    const summary = result && result.summary
    const diffSource = result && result.metricDiffs
    const summaryValue = findSideValue(summary, key, side)
    if (summaryValue !== null) return summaryValue
    const diffValue = findSideValue(diffSource, key, side)
    if (diffValue !== null) return diffValue
    return metricFromRun(fallbackRun, key)
  }

  function makeSummaryCard(definition, valueA, valueB, delta) {
    const card = document.createElement('article')
    card.className = 'summary-card'
    card.append(createTextElement('span', definition.label, 'summary-label'))
    const valueRow = document.createElement('div')
    valueRow.className = 'summary-value-row'
    valueRow.append(createTextElement('strong', formatMetric(valueB, definition.kind), 'summary-value'))
    valueRow.append(createTextElement('span', formatDelta(delta, definition.kind), 'summary-delta'))
    card.append(valueRow)
    const sides = document.createElement('div')
    sides.className = 'summary-sides'
    sides.append(
      createTextElement('span', `A ${formatMetric(valueA, definition.kind)}`, 'summary-side-a'),
      createTextElement('span', `B ${formatMetric(valueB, definition.kind)}`, 'summary-side-b'),
    )
    card.append(sides)
    return card
  }

  function renderSummaryCards(result) {
    elements.summaryCards.replaceChildren()
    const runA = selectedRun('a')
    const runB = selectedRun('b')
    for (const definition of METRIC_DEFINITIONS) {
      const valueA = compareMetricValue(result, definition.key, 'a', runA)
      const valueB = compareMetricValue(result, definition.key, 'b', runB)
      const delta = findMetricDelta(result && result.metricDiffs, definition.key, valueA, valueB)
      elements.summaryCards.append(makeSummaryCard(definition, valueA, valueB, delta))
    }
  }

  function renderDiagnosis(result) {
    const diagnosis = result && result.diagnosis && typeof result.diagnosis === 'object' ? result.diagnosis : {}
    elements.diagnosisHeadline.textContent = summaryString(diagnosis.headline, '暂无足够信息生成执行结论。')
    elements.diagnosisFindings.replaceChildren()
    const findings = Array.isArray(diagnosis.findings) ? diagnosis.findings : []
    for (const finding of findings.slice(0, 5)) {
      elements.diagnosisFindings.append(createTextElement('li', summaryString(finding && finding.text, '指标发生变化。')))
    }
    if (findings.length === 0) elements.diagnosisFindings.append(createTextElement('li', '关键执行指标没有明显差异。'))
    elements.diagnosisRecommendations.replaceChildren()
    const recommendations = Array.isArray(diagnosis.recommendations) ? diagnosis.recommendations : []
    for (const recommendation of recommendations.slice(0, 4)) {
      elements.diagnosisRecommendations.append(createTextElement('li', summaryString(recommendation, '结合最终产物质量人工复核。')))
    }
    elements.diagnosisCaveat.textContent = summaryString(diagnosis.caveat, '结论只评价执行轨迹。')
  }

  function normalizeSeverity(value) {
    const severity = rawString(value).toLowerCase().replace(/\s+/g, '-')
    return ['critical', 'error', 'warning', 'warn', 'info', 'low'].includes(severity) ? severity : 'warning'
  }

  function divergenceRunLabel(value) {
    const runA = state.selectedA
    const runB = state.selectedB
    if (value === runA || rawString(value).toLowerCase() === 'a' || rawString(value).toLowerCase() === 'runa') return '运行 A'
    if (value === runB || rawString(value).toLowerCase() === 'b' || rawString(value).toLowerCase() === 'runb') return '运行 B'
    return '两次运行'
  }

  function stepIndexes(value) {
    const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
    const indexes = values.map(numberOrNull).filter((index) => index !== null && index >= 0).map((index) => Math.round(index))
    return [...new Set(indexes)].slice(0, 8)
  }

  function displayDivergenceType(value) {
    const normalized = rawString(value).replace(/[-_]+/g, ' ').trim()
    const labels = { repeated_tool_loop: '重复工具循环', extra_failed_command: '额外失败命令', unnecessary_file_churn: '不必要的文件修改', extra_search_read_path: '额外搜索与读取', test_execution_timing: '测试执行时机', failure_recovery: '失败后恢复', unrecovered_failure: '未恢复的失败' }
    return labels[rawString(value)] || compactString(normalized, '执行路径差异', 64)
  }

  function renderDivergences(result) {
    const divergences = result && Array.isArray(result.divergences) ? result.divergences : []
    elements.divergenceList.replaceChildren()
    elements.divergenceCount.textContent = divergences.length.toLocaleString()
    if (divergences.length === 0) {
      elements.divergenceList.append(createTextElement('p', '这两次运行没有检测到明显的执行路径差异。', 'divergence-empty'))
      return
    }

    divergences.forEach((divergence, index) => {
      const item = divergence && typeof divergence === 'object' ? divergence : {}
      const severity = normalizeSeverity(item.severity)
      const card = document.createElement('article')
      card.className = `divergence-card severity-${severity}`
      card.append(createTextElement('span', String(index + 1).padStart(2, '0'), 'divergence-index'))
      const body = document.createElement('div')
      const meta = document.createElement('div')
      meta.className = 'divergence-meta'
      const severityLabels = { critical: '严重', error: '错误', warning: '警告', warn: '警告', info: '提示', low: '提示' }
      meta.append(
        createTextElement('span', severityLabels[severity] || '警告', 'severity-badge'),
        createTextElement('span', divergenceRunLabel(item.run), 'run-chip'),
      )
      const indexes = stepIndexes(item.stepIndexes ?? item.step_indices ?? item.steps)
      if (indexes.length > 0) {
        meta.append(createTextElement('span', indexes.length === 1 ? `步骤 ${indexes[0]}` : `步骤 ${indexes.join(' · ')}`, 'step-chip'))
      }
      body.append(meta)
      body.append(createTextElement('h4', displayDivergenceType(item.type), 'divergence-type'))
      body.append(createTextElement('p', summaryString(item.message), 'divergence-message'))
      card.append(body)
      elements.divergenceList.append(card)
    })
  }

  function renderMetricDiffs(result) {
    elements.metricDiffs.replaceChildren()
    const runA = selectedRun('a')
    const runB = selectedRun('b')
    for (const definition of METRIC_DEFINITIONS) {
      const valueA = compareMetricValue(result, definition.key, 'a', runA)
      const valueB = compareMetricValue(result, definition.key, 'b', runB)
      const delta = findMetricDelta(result && result.metricDiffs, definition.key, valueA, valueB)
      const row = document.createElement('div')
      row.className = 'metric-row'
      row.append(createTextElement('span', definition.label, 'metric-name'))
      const values = document.createElement('div')
      values.className = 'metric-values'
      values.append(
        createTextElement('span', `A ${formatMetric(valueA, definition.kind)}`, 'metric-side-a'),
        createTextElement('span', `B ${formatMetric(valueB, definition.kind)}`, 'metric-side-b'),
        createTextElement('span', formatDelta(delta, definition.kind), 'metric-delta'),
      )
      row.append(values)
      elements.metricDiffs.append(row)
    }
  }

  function renderComparePair() {
    elements.compareRunPair.replaceChildren()
    const runA = selectedRun('a')
    const runB = selectedRun('b')
    const pillA = document.createElement('span')
    pillA.className = 'pair-pill pair-pill-a'
    pillA.append(createTextElement('b', 'A', 'pair-letter'), createTextElement('span', runA ? compactString(runA.runId, '未选择', 24) : '未选择'))
    const divider = createTextElement('span', '对比', 'pair-divider')
    const pillB = document.createElement('span')
    pillB.className = 'pair-pill pair-pill-b'
    pillB.append(createTextElement('b', 'B', 'pair-letter'), createTextElement('span', runB ? compactString(runB.runId, '未选择', 24) : '未选择'))
    elements.compareRunPair.append(pillA, divider, pillB)
  }

  function renderCompare() {
    renderComparePair()
    renderSelection()
    const ready = hasComparableSelection()
    elements.compareEmpty.hidden = ready
    elements.compareContent.hidden = !ready || !state.compareResult || state.compareLoading
    elements.runComparison.disabled = !ready || state.compareLoading
    elements.runComparison.querySelector('span:last-child').textContent = state.compareLoading ? '正在分析…' : '重新分析'
    if (!ready) {
      const incompatible = hasDistinctSelection()
      setFeedback(elements.compareFeedback, incompatible ? '这两条记录不属于同一任务谱系，不能进行受控实验。' : '', incompatible ? 'error' : '')
      return
    }
    if (state.compareLoading) {
      setFeedback(elements.compareFeedback, '正在对比脱敏执行轨迹…', 'loading')
      return
    }
    if (state.compareError) {
      elements.compareEmpty.hidden = true
      elements.compareContent.hidden = true
      setFeedback(elements.compareFeedback, state.compareError, 'error')
      return
    }
    setFeedback(elements.compareFeedback, '', '')
    if (state.compareResult) {
      renderDiagnosis(state.compareResult)
      renderSummaryCards(state.compareResult)
      renderDivergences(state.compareResult)
      renderMetricDiffs(state.compareResult)
    }
  }

  async function refreshRuns() {
    if (state.runsLoading) return
    state.runsLoading = true
    state.runsError = ''
    state.compareResult = null
    state.compareError = ''
    renderRuns()
    try {
      const api = getApi()
      const result = await api.listRuns()
      if (!Array.isArray(result)) throw new Error('会话库返回了无效摘要列表')
      state.runs = sortRuns(result.map(normalizeRun).filter(Boolean))
      const baseline = state.runs.find((run) => run.isBaseline)
      if (!state.selectedA && baseline) state.selectedA = baseline.runId
      if (!state.runs.some((run) => run.runId === state.selectedA)) state.selectedA = null
      if (!state.runs.some((run) => run.runId === state.selectedB)) state.selectedB = null
    } catch (error) {
      state.runs = []
      state.runsError = `无法加载运行记录：${compactString(error && error.message, '未知错误', 160)}`
    } finally {
      state.runsLoading = false
      renderRuns()
      renderCompare()
    }
  }

  async function compareSelectedRuns() {
    if (!hasComparableSelection() || state.compareLoading) return
    const runA = state.selectedA
    const runB = state.selectedB
    state.activeTab = 'compare'
    state.compareLoading = true
    state.compareError = ''
    state.compareResult = null
    const requestId = ++state.compareRequest
    renderTabState()
    renderCompare()
    try {
      const api = getApi()
      const result = await api.compareRuns(runA, runB)
      if (requestId !== state.compareRequest) return
      if (!result || typeof result !== 'object') throw new Error('对比结果无效')
      state.compareResult = result
    } catch (error) {
      if (requestId !== state.compareRequest) return
      state.compareError = `无法对比运行：${compactString(error && error.message, '未知错误', 160)}`
    } finally {
      if (requestId === state.compareRequest) {
        state.compareLoading = false
        renderCompare()
      }
    }
  }

  async function runAction(action, successText) {
    if (!hasDistinctSelection() || !state.compareResult) return
    elements.actionFeedback.textContent = '正在执行…'
    try {
      await action(getApi())
      elements.actionFeedback.textContent = successText
    } catch (error) {
      elements.actionFeedback.textContent = `操作失败：${compactString(error && error.message, '未知错误', 120)}`
    }
  }

  function betterRunId() {
    const verdict = state.compareResult && state.compareResult.diagnosis && state.compareResult.diagnosis.verdict
    if (verdict === 'a_better') return state.selectedA
    if (verdict === 'b_better') return state.selectedB
    return state.selectedB
  }

  function handleRunSelection(event) {
    const button = event.target.closest('button[data-run-id]')
    if (!button || !elements.runsBody.contains(button)) return
    const action = button.getAttribute('data-action')
    const runId = button.getAttribute('data-run-id')
    if (action === 'inspect') { inspectRun(runId); return }
    if (action === 'open') { openOriginalRun(runId); return }
    const side = button.getAttribute('data-select-side')
    if (!runId || (side !== 'a' && side !== 'b')) return
    if (side === 'a') state.selectedA = state.selectedA === runId ? null : runId
    if (side === 'b') state.selectedB = state.selectedB === runId ? null : runId
    state.compareResult = null
    state.compareError = ''
    renderRuns()
    renderCompare()
  }

  function bindEvents() {
    elements.tabRuns.addEventListener('click', () => setActiveTab('runs'))
    elements.tabCompare.addEventListener('click', () => setActiveTab('compare'))
    elements.refreshRuns.addEventListener('click', refreshRuns)
    elements.refreshEmpty.addEventListener('click', refreshRuns)
    elements.runsBody.addEventListener('click', handleRunSelection)
    elements.compareSelected.addEventListener('click', compareSelectedRuns)
    elements.runComparison.addEventListener('click', compareSelectedRuns)
    elements.copyBrief.addEventListener('click', () => runAction(
      (api) => api.copyOptimizationBrief(state.selectedA, state.selectedB),
      '优化任务已复制，可直接粘贴到 DSH 开始下一轮。',
    ))
    elements.exportReport.addEventListener('click', () => runAction(
      (api) => api.exportReport(state.selectedA, state.selectedB),
      '对比报告已导出。',
    ))
    elements.setBaseline.addEventListener('click', () => runAction(
      (api) => api.setBaseline(betterRunId()),
      '更优运行已设为后续对比基线。',
    ))
    elements.openOriginal.addEventListener('click', () => state.inspectedRunId && openOriginalRun(state.inspectedRunId))
    elements.copyRunFix.addEventListener('click', async () => {
      if (!state.inspectedRunId) return
      try {
        await getApi().copyRunFix(state.inspectedRunId)
        elements.runHealthFeedback.textContent = '修复任务已复制，可粘贴到原对话继续执行。'
      } catch (error) {
        elements.runHealthFeedback.textContent = `复制失败：${compactString(error && error.message, '未知错误', 120)}`
      }
    })
    elements.openRuns.addEventListener('click', () => setActiveTab('runs'))
    elements.tabRuns.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        elements.tabCompare.focus()
        setActiveTab('compare')
      }
    })
    elements.tabCompare.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        elements.tabRuns.focus()
        setActiveTab('runs')
      }
    })
  }

  bindEvents()
  renderTabState()
  renderRuns()
  renderCompare()
  refreshRuns()
})()
