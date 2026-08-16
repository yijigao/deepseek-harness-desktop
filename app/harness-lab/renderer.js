(() => {
  'use strict'

  const METRIC_DEFINITIONS = [
    { key: 'duration_ms', label: 'Duration', kind: 'duration' },
    { key: 'total_steps', label: 'Steps', kind: 'count' },
    { key: 'tool_calls', label: 'Tool calls', kind: 'count' },
    { key: 'failed_tool_calls', label: 'Failures', kind: 'count' },
    { key: 'retry_count', label: 'Retries', kind: 'count' },
    { key: 'total_tokens', label: 'Tokens', kind: 'count' },
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
    divergenceCount: document.getElementById('divergence-count'),
    divergenceList: document.getElementById('divergence-list'),
    metricDiffs: document.getElementById('metric-diffs'),
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

  function summaryString(value, fallback = 'No sanitized summary available.') {
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
      source: rawString(value.source),
      model: rawString(value.model || value.modelName),
      status: rawString(value.status || 'unknown').toLowerCase(),
      metrics,
    }
  }

  function sourceLabel(source) {
    return source === 'codex' ? 'Codex' : source === 'deepseek-harness' ? 'DeepSeek Harness' : 'Unknown source'
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
    if (!normalized) return 'Unknown'
    return compactString(normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()), 'Unknown', 32)
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

  function selectionLabel(side) {
    const run = selectedRun(side)
    return run ? compactString(run.runId, 'Selected run', 34) : 'Not selected'
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
    const ready = hasDistinctSelection()
    elements.compareSelected.disabled = !ready || state.compareLoading
    elements.runComparison.disabled = !ready || state.compareLoading
    elements.compareTabState.textContent = ready ? 'Ready' : 'Select two'
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
        'aria-label': `Select ${compactString(run.runId, 'run', 42)} as Run A`,
        'aria-pressed': String(state.selectedA === run.runId),
      })
      const selectB = createButton('B', 'select-run', {
        'data-select-side': 'b',
        'data-run-id': run.runId,
        'aria-label': `Select ${compactString(run.runId, 'run', 42)} as Run B`,
        'aria-pressed': String(state.selectedB === run.runId),
      })
      if (state.selectedA === run.runId) selectA.classList.add('is-selected-a')
      if (state.selectedB === run.runId) selectB.classList.add('is-selected-b')
      selectorPair.append(selectA, selectB)
      selectorCell.append(selectorPair)
      row.append(selectorCell)

      const startedCell = createTextElement('td', formatDate(run.startedAt), 'time-cell')
      startedCell.title = compactString(run.runId, 'Run', 80)
      row.append(startedCell)
      row.append(createTextElement('td', sourceLabel(run.source), 'source-cell'))
      row.append(createTextElement('td', compactString(run.model, 'Unknown model', 42), 'model-cell'))
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
      setFeedback(elements.runsFeedback, 'Loading run summaries…', 'loading')
    } else {
      setFeedback(elements.runsFeedback, state.runsError, state.runsError ? 'error' : '')
    }
    elements.refreshRuns.disabled = state.runsLoading
    elements.refreshEmpty.disabled = state.runsLoading
    renderSelection()
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
      const safeDefinition = definition.key === 'total_tokens' && result?.summary?.tokenComparability === 'not directly comparable'
        ? { ...definition, label: 'Tokens · not directly comparable' }
        : definition
      elements.summaryCards.append(makeSummaryCard(safeDefinition, valueA, valueB, delta))
    }
  }

  function normalizeSeverity(value) {
    const severity = rawString(value).toLowerCase().replace(/\s+/g, '-')
    return ['critical', 'error', 'warning', 'warn', 'info', 'low'].includes(severity) ? severity : 'warning'
  }

  function divergenceRunLabel(value) {
    const runA = state.selectedA
    const runB = state.selectedB
    if (value === runA || rawString(value).toLowerCase() === 'a' || rawString(value).toLowerCase() === 'runa') return 'Run A'
    if (value === runB || rawString(value).toLowerCase() === 'b' || rawString(value).toLowerCase() === 'runb') return 'Run B'
    return compactString(value, 'Both runs', 20) === '[path hidden]' ? 'Both runs' : compactString(value, 'Both runs', 20)
  }

  function stepIndexes(value) {
    const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
    const indexes = values.map(numberOrNull).filter((index) => index !== null && index >= 0).map((index) => Math.round(index))
    return [...new Set(indexes)].slice(0, 8)
  }

  function displayDivergenceType(value) {
    const normalized = rawString(value).replace(/[-_]+/g, ' ').trim()
    return compactString(normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()), 'Trajectory mismatch', 64)
  }

  function renderDivergences(result) {
    const divergences = result && Array.isArray(result.divergences) ? result.divergences : []
    elements.divergenceList.replaceChildren()
    elements.divergenceCount.textContent = divergences.length.toLocaleString()
    if (divergences.length === 0) {
      elements.divergenceList.append(createTextElement('p', 'No trajectory divergences were reported for these runs.', 'divergence-empty'))
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
      meta.append(
        createTextElement('span', severity, 'severity-badge'),
        createTextElement('span', divergenceRunLabel(item.run), 'run-chip'),
      )
      const indexes = stepIndexes(item.stepIndexes ?? item.step_indices ?? item.steps)
      if (indexes.length > 0) {
        meta.append(createTextElement('span', indexes.length === 1 ? `Step ${indexes[0]}` : `Steps ${indexes.join(' · ')}`, 'step-chip'))
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
      const label = definition.key === 'total_tokens' && result?.summary?.tokenComparability === 'not directly comparable'
        ? 'Tokens · not directly comparable'
        : definition.label
      row.append(createTextElement('span', label, 'metric-name'))
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
    pillA.append(createTextElement('b', 'A', 'pair-letter'), createTextElement('span', runA ? sourceLabel(runA.source) : 'Not selected'))
    const divider = createTextElement('span', 'VS', 'pair-divider')
    const pillB = document.createElement('span')
    pillB.className = 'pair-pill pair-pill-b'
    pillB.append(createTextElement('b', 'B', 'pair-letter'), createTextElement('span', runB ? sourceLabel(runB.source) : 'Not selected'))
    elements.compareRunPair.append(pillA, divider, pillB)
  }

  function renderCompare() {
    renderComparePair()
    renderSelection()
    const ready = hasDistinctSelection()
    elements.compareEmpty.hidden = ready
    elements.compareContent.hidden = !ready || !state.compareResult || state.compareLoading
    elements.runComparison.disabled = !ready || state.compareLoading
    elements.runComparison.querySelector('span:last-child').textContent = state.compareLoading ? 'Comparing…' : 'Run comparison'
    if (!ready) {
      setFeedback(elements.compareFeedback, '', '')
      return
    }
    if (state.compareLoading) {
      setFeedback(elements.compareFeedback, 'Comparing sanitized trajectories…', 'loading')
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
      if (!Array.isArray(result)) throw new Error('Run archive returned an invalid summary list')
      state.runs = sortRuns(result.map(normalizeRun).filter(Boolean))
      if (!state.runs.some((run) => run.runId === state.selectedA)) state.selectedA = null
      if (!state.runs.some((run) => run.runId === state.selectedB)) state.selectedB = null
    } catch (error) {
      state.runs = []
      state.runsError = `Unable to load runs: ${compactString(error && error.message, 'unknown bridge error', 160)}`
    } finally {
      state.runsLoading = false
      renderRuns()
      renderCompare()
    }
  }

  async function compareSelectedRuns() {
    if (!hasDistinctSelection() || state.compareLoading) return
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
      if (!result || typeof result !== 'object') throw new Error('Comparison returned an invalid result')
      state.compareResult = result
    } catch (error) {
      if (requestId !== state.compareRequest) return
      state.compareError = `Unable to compare runs: ${compactString(error && error.message, 'unknown bridge error', 160)}`
    } finally {
      if (requestId === state.compareRequest) {
        state.compareLoading = false
        renderCompare()
      }
    }
  }

  function handleRunSelection(event) {
    const button = event.target.closest('button[data-select-side][data-run-id]')
    if (!button || !elements.runsBody.contains(button)) return
    const side = button.getAttribute('data-select-side')
    const runId = button.getAttribute('data-run-id')
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
