'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')

const { HarnessLabSessionService, publicRun } = require('../app/lib/harness-lab/session-service')
const { compareRuns } = require('../app/lib/trajectory/compare')
const { parseRun } = require('../app/lib/trajectory/parser')
const { REDACTED, safeIdentifier, sanitizeMetadata } = require('../app/lib/trajectory/redaction')
const { normalizeToolCategory } = require('../app/lib/trajectory/tool-categories')

const fixtureDir = path.join(__dirname, 'fixtures')

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name))
}

function parsed(name) {
  return parseRun(fixture(name), { fileName: name, format: name.startsWith('codex-') ? 'codex-jsonl' : 'dsh-jsonl' })
}

test('normal DSH JSONL parses into the canonical trajectory without message content', () => {
  const run = parsed('run-a.jsonl')
  assert.equal(run.source, 'deepseek-harness')
  assert.equal(run.sourceVersion, '0')
  assert.equal(run.workspace, 'run-a')
  assert.equal(run.status, 'success')
  assert.equal(run.model, 'deepseek-demo-a')
  assert.ok(run.steps.some((step) => step.type === 'user'))
  assert.ok(run.steps.some((step) => step.type === 'assistant'))
  assert.ok(run.steps.some((step) => step.type === 'tool_call'))
  assert.ok(run.steps.some((step) => step.type === 'tool_result'))
  assert.doesNotMatch(JSON.stringify(run), /Synthetic fixture task|Synthetic fixture completion/)
})

test('unknown events, malformed lines, and missing fields are tolerated', () => {
  const run = parsed('run-unknown-events.jsonl')
  assert.equal(run._diagnostics.malformedLines, 1)
  assert.equal(run._diagnostics.unknownEvents, 2)
  const future = run.steps.find((step) => step.rawType === 'future/event')
  assert.equal(future.type, 'unknown')
  assert.equal(future.metadata.unknownData.futureField, 42)
  assert.equal(future.metadata.unknownData.content, '[CONTENT OMITTED]')
  assert.equal(future.metadata.unknownData.path, '[CONTENT OMITTED]')
  const missingType = run.steps.find((step) => step.rawType === 'unknown')
  assert.ok(missingType)
  assert.equal(run.status, 'unknown')
})

test('secret keys and common credential-shaped strings are redacted', () => {
  const run = parsed('run-secret-redaction.jsonl')
  const serialized = JSON.stringify(run)
  assert.doesNotMatch(serialized, /synthetic-placeholder/)
  assert.match(serialized, /\[REDACTED\]/)

  const shaped = {
    api_key: ['synthetic', 'key', 'value'].join('-'),
    note: [
      ['sk', 'synthetic', 'value'].join('-'),
      `${['Bear', 'er'].join('')} ${['synthetic', 'authorization'].join('-')}`,
      ['ghp', 'syntheticvalue'].join('_'),
      ['github', 'pat', 'syntheticvalue'].join('_'),
    ].join(' '),
  }
  const clean = sanitizeMetadata(shaped)
  assert.equal(clean.api_key, REDACTED)
  assert.doesNotMatch(clean.note, /syntheticvalue|authorization/)

  const hostileMetadata = sanitizeMetadata(JSON.parse('{"__proto__":{"polluted":true},"note":"C:\\\\Users\\\\Synthetic User\\\\private\\\\file.txt"}'))
  assert.equal(Object.getPrototypeOf(hostileMetadata), null)
  assert.doesNotMatch(JSON.stringify(hostileMetadata), /[A-Za-z]:\\\\|Synthetic User/)

  const variants = sanitizeMetadata({
    secretKey: 'synthetic-placeholder',
    accessKeyId: 'synthetic-placeholder',
    authorizationHeader: 'synthetic-placeholder',
  })
  assert.ok(Object.values(variants).every((value) => value === REDACTED))

  const pathShapes = sanitizeMetadata({
    one: '/synthetic',
    spaced: '/synthetic/private file.txt',
    network: String.raw`\\synthetic-host\share\private file.txt`,
  })
  assert.deepEqual(Object.values(pathShapes), ['[PATH]', '[PATH]', '[PATH]'])
  assert.equal(safeIdentifier(['file', '/synthetic/private'].join(':')), null)
  assert.equal(safeIdentifier(['mail', 'to'].join('') + ':synthetic-private'), null)
  assert.equal(safeIdentifier(['https', 'synthetic-private'].join(':')), null)
})

test('unknown and malformed identifier fields cannot export arbitrary text', () => {
  const records = [
    { type: 'session', version: 'C:/synthetic/private-version', id: 'synthetic-privacy-probe', createdAt: 1760000000000, cwd: '/synthetic/privacy', delegationDepth: 0 },
    { type: 'private sentence here', seq: 0, time: 1760000000100, data: {
      note: 'synthetic private text',
      secretKey: 'synthetic-placeholder',
      path: '/synthetic/private file.txt',
      count: 7,
    } },
    { type: 'tool/call', seq: 1, time: 1760000000200, data: { callId: 'synthetic-call', name: 'C:/synthetic/private-tool', arguments: {} } },
    { type: 'request/header', seq: 2, time: 1760000000300, data: { header: { config: { model: 'C:/synthetic/private-model' } } } },
  ]
  const run = parseRun(`${records.map(JSON.stringify).join('\n')}\n`)
  const exported = publicRun(run)
  const serialized = JSON.stringify(exported)
  assert.doesNotMatch(serialized, /private sentence|private text|private-tool|private-model|private-version|synthetic-placeholder/)
  const unknown = exported.steps.find((step) => step.type === 'unknown')
  assert.equal(unknown.rawType, 'unknown')
  assert.equal(unknown.metadata.unknownData.note, '[CONTENT OMITTED]')
  assert.equal(unknown.metadata.unknownData.secretKey, REDACTED)
  assert.equal(unknown.metadata.unknownData.path, '[CONTENT OMITTED]')
  assert.equal(unknown.metadata.unknownData.count, 7)
  assert.equal(exported.steps.find((step) => step.type === 'tool_call').tool, 'unknown-tool')
  assert.equal(exported.model, null)
  assert.equal(exported.sourceVersion, null)
})

test('deterministic run metrics match the demo contract', () => {
  const a = parsed('run-a.jsonl')
  const b = parsed('run-b.jsonl')
  assert.deepEqual(
    {
      steps: a.metrics.total_steps,
      tools: a.metrics.tool_calls,
      retries: a.metrics.retry_count,
      failures: a.metrics.failed_tool_calls,
    },
    { steps: 31, tools: 46, retries: 6, failures: 3 },
  )
  assert.deepEqual(
    {
      steps: b.metrics.total_steps,
      tools: b.metrics.tool_calls,
      retries: b.metrics.retry_count,
      failures: b.metrics.failed_tool_calls,
    },
    { steps: 18, tools: 27, retries: 1, failures: 0 },
  )
  assert.equal(a.metrics.failed_shell_commands, 3)
  assert.equal(a.metrics.error_count, 3)
  assert.equal(a.metrics.unique_tools, 6)
  assert.equal(a.metrics.repeated_tool_calls, 3)
  assert.ok(a.metrics.files_written > b.metrics.files_written)
})

test('token usage is available only when source usage exists', () => {
  const available = parsed('run-a.jsonl')
  const unavailable = parsed('run-unknown-events.jsonl')
  assert.deepEqual(
    [available.metrics.input_tokens, available.metrics.output_tokens, available.metrics.total_tokens],
    [9600, 2800, 12400],
  )
  assert.deepEqual(
    [unavailable.metrics.input_tokens, unavailable.metrics.output_tokens, unavailable.metrics.total_tokens],
    [null, null, null],
  )
})

test('official turn reason objects and streaming usage chunks are normalized', () => {
  const records = [
    { type: 'session', version: 0, id: 'synthetic-official-shape', createdAt: 1760000000000, cwd: '/synthetic/workspace/official', delegationDepth: 0 },
    { type: 'turn/start', seq: 0, time: 1760000000100, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1760000000200, data: { turn: 1, step: 1 } },
    { type: 'assistant/chunk', seq: 2, time: 1760000000300, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 120, outputTokens: 30 } } } },
    { type: 'assistant/message', seq: 3, time: 1760000000400, data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { model: 'deepseek-synthetic' } }, usage: { inputTokens: 120, outputTokens: 30 } } },
    { type: 'step/end', seq: 4, time: 1760000000500, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1760000000600, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const run = parseRun(`${records.map(JSON.stringify).join('\n')}\n`)
  assert.equal(run.status, 'success')
  assert.equal(run.metrics.input_tokens, 120)
  assert.equal(run.metrics.output_tokens, 30)
  assert.equal(run.metrics.total_tokens, 150)
  assert.equal(run.metrics.assistant_messages, 1)
})

test('observed Codex envelopes normalize without exporting content or source identity', () => {
  const run = parsed('codex-run.jsonl')
  assert.equal(run.source, 'codex')
  assert.equal(run.sourceVersion, '0.145.0')
  assert.equal(run.model, 'gpt-5.6-terra')
  assert.equal(run.workspace, 'harness-cross-smoke')
  assert.equal(run.status, 'success')
  assert.equal(run.metrics.tool_calls, 3)
  assert.equal(run.metrics.failed_tool_calls, 1)
  assert.equal(run.metrics.files_written, 1)
  assert.equal(run.metrics.shell_commands, 2)
  assert.equal(run.metrics.failed_shell_commands, 1)
  assert.deepEqual({ ...run.metrics.tool_category_counts }, { test: 2, edit_file: 1 })
  assert.equal(run.metrics.total_tokens, 1440)
  const serialized = JSON.stringify(publicRun(run))
  assert.doesNotMatch(serialized, /synthetic-codex-session|synthetic-source-session-id|Synthetic private|python -m pytest/)
  assert.doesNotMatch(serialized, /[A-Za-z]:\\|harness-cross-smoke\\/)
})

test('Codex unknown, malformed, missing, secret, and absolute-path shapes are safe', () => {
  const run = parsed('codex-unknown-secret.jsonl')
  assert.equal(run._diagnostics.malformedLines, 1)
  assert.ok(run._diagnostics.unknownEvents >= 2)
  const serialized = JSON.stringify(publicRun(run))
  assert.doesNotMatch(serialized, /synthetic-source-session-secret|Synthetic User|private\.py|[A-Za-z]:\\/)
  assert.equal(run.workspace, 'private-workspace')
  assert.doesNotMatch(serialized, /synthetic-authorization-value|synthetic-secret-value|github_pat_syntheticvalue|synthetic-placeholder/)
  assert.match(serialized, /\[REDACTED\]|\[CONTENT OMITTED\]/)
})

test('canonical tool category normalization covers stable cross-harness operations', () => {
  assert.equal(normalizeToolCategory('exec_command', { cmd: 'node script.js' }), 'shell')
  assert.equal(normalizeToolCategory('bash', { command: 'python -m pytest' }), 'test')
  assert.equal(normalizeToolCategory('exec', { command: 'git status -sb' }), 'git')
  assert.equal(normalizeToolCategory('grep', {}), 'search')
  assert.equal(normalizeToolCategory('read_file', {}), 'read_file')
  assert.equal(normalizeToolCategory('write_file', {}), 'write_file')
  assert.equal(normalizeToolCategory('apply_patch', {}), 'edit_file')
  assert.equal(normalizeToolCategory('web_search', {}), 'network')
  assert.equal(normalizeToolCategory('future_tool', {}), 'other')
})

test('Codex-to-Codex and DSH-to-Codex comparisons are supported safely', () => {
  const codexA = parsed('codex-run.jsonl')
  const codexB = parsed('codex-unknown-secret.jsonl')
  const sameSource = compareRuns(codexA, codexB)
  assert.equal(sameSource.summary.runA.source, 'codex')
  assert.equal(sameSource.summary.runB.source, 'codex')
  const crossSource = compareRuns(parsed('run-b.jsonl'), codexA)
  assert.equal(crossSource.summary.runA.source, 'deepseek-harness')
  assert.equal(crossSource.summary.runB.source, 'codex')
  assert.equal(crossSource.summary.tokenComparability, 'not directly comparable')
  assert.equal(crossSource.metricDiffs.total_tokens.delta, null)
  assert.ok(crossSource.divergences.every((item) => !/deepseek/i.test(item.type)))
})

test('fixed DSH and Codex roots are discovered together with opaque IDs', async (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'harness-lab-cross-source-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dshHome = path.join(root, 'dsh')
  const dshSession = path.join(dshHome, 'sessions', 'synthetic', 'one')
  const codexRoot = path.join(root, 'codex', 'sessions')
  const codexSession = path.join(codexRoot, '2026', '02', '01')
  fs.mkdirSync(dshSession, { recursive: true })
  fs.mkdirSync(codexSession, { recursive: true })
  fs.copyFileSync(path.join(fixtureDir, 'run-b.jsonl'), path.join(dshSession, 'session.jsonl'))
  fs.copyFileSync(path.join(fixtureDir, 'codex-run.jsonl'), path.join(codexSession, 'rollout-2026-02-01T10-00-00-synthetic.jsonl'))
  const service = new HarnessLabSessionService({ dshHome, codexSessionsRoot: codexRoot })
  const runs = await service.listRuns()
  assert.deepEqual(new Set(runs.map((run) => run.source)), new Set(['deepseek-harness', 'codex']))
  assert.ok(runs.every((run) => /^[a-f0-9]{24}$/.test(run.runId)))
  const cross = await service.compare(
    runs.find((run) => run.source === 'deepseek-harness').runId,
    runs.find((run) => run.source === 'codex').runId,
  )
  assert.equal(cross.summary.tokenComparability, 'not directly comparable')
})

test('run comparison reports metric deltas and all deterministic divergence classes', () => {
  const comparison = compareRuns(parsed('run-a.jsonl'), parsed('run-b.jsonl'))
  assert.equal(comparison.metricDiffs.total_steps.delta, -13)
  assert.equal(comparison.metricDiffs.tool_calls.delta, -19)
  assert.equal(comparison.metricDiffs.total_tokens.available, true)
  assert.ok(comparison.summary.efficiencySignals.includes('Run B used 13 fewer steps.'))
  assert.ok(comparison.summary.efficiencySignals.includes('Run B used 19 fewer tool calls.'))

  const types = new Set(comparison.divergences.map((item) => item.type))
  for (const expected of [
    'repeated_tool_loop',
    'extra_failed_command',
    'unnecessary_file_churn',
    'extra_search_read_path',
    'test_execution_timing',
    'failure_recovery',
  ]) {
    assert.ok(types.has(expected), `missing ${expected}`)
  }
  const loop = comparison.divergences.find((item) => item.type === 'repeated_tool_loop')
  assert.equal(loop.run, 'A')
  assert.equal(loop.stepIndexes.length, 3)
  assert.match(loop.message, /repository search 3 times/)
})

test('comparison reports recovered and unrecovered failures in the same run', () => {
  const mixedRecords = [
    { type: 'session', version: 0, id: 'synthetic-mixed-recovery', createdAt: 1760000000000, cwd: '/synthetic/mixed', delegationDepth: 0 },
    { type: 'tool/call', seq: 0, time: 1760000000100, data: { callId: 'synthetic-1', name: 'bash', arguments: { command: 'npm test -- synthetic-one' } } },
    { type: 'tool/result', seq: 1, time: 1760000000200, data: { callId: 'synthetic-1', content: [{ type: 'tool_result', isError: true }] } },
    { type: 'tool/call', seq: 2, time: 1760000000300, data: { callId: 'synthetic-2', name: 'bash', arguments: { command: 'npm test -- synthetic-one' } } },
    { type: 'tool/result', seq: 3, time: 1760000000400, data: { callId: 'synthetic-2', content: [{ type: 'tool_result', isError: false }] } },
    { type: 'tool/call', seq: 4, time: 1760000000500, data: { callId: 'synthetic-3', name: 'bash', arguments: { command: 'npm test -- synthetic-two' } } },
    { type: 'tool/result', seq: 5, time: 1760000000600, data: { callId: 'synthetic-3', content: [{ type: 'tool_result', isError: true }] } },
  ]
  const emptyRecords = [
    { type: 'session', version: 0, id: 'synthetic-empty-peer', createdAt: 1760000000000, cwd: '/synthetic/empty', delegationDepth: 0 },
  ]
  const mixed = parseRun(`${mixedRecords.map(JSON.stringify).join('\n')}\n`)
  const empty = parseRun(`${emptyRecords.map(JSON.stringify).join('\n')}\n`)
  const divergences = compareRuns(mixed, empty).divergences.filter((item) => item.run === 'A')
  assert.equal(divergences.filter((item) => item.type === 'failure_recovery').length, 1)
  const unrecovered = divergences.find((item) => item.type === 'unrecovered_failure')
  assert.ok(unrecovered)
  assert.equal(unrecovered.stepIndexes.length, 1)
})

test('comparison marks token metrics unavailable unless both runs report usage', () => {
  const comparison = compareRuns(parsed('run-a.jsonl'), parsed('run-unknown-events.jsonl'))
  assert.deepEqual(comparison.metricDiffs.total_tokens, {
    a: 12400,
    b: null,
    delta: null,
    available: false,
    lowerValueRun: null,
    comparability: 'not directly comparable',
  })
})

test('zstd-compressed JSONL is accepted when the runtime supports zstd', () => {
  assert.equal(typeof zlib.zstdCompressSync, 'function')
  const lines = fixture('run-b.jsonl').toString('utf8').split('\n')
  const headerFrame = zlib.zstdCompressSync(Buffer.from(`${lines.shift()}\n`))
  const appendFrame = zlib.zstdCompressSync(Buffer.from(lines.join('\n')))
  const compressed = Buffer.concat([headerFrame, appendFrame])
  const run = parseRun(compressed, { fileName: 'session.jsonl.zstd' })
  assert.equal(run.metrics.tool_calls, 27)
})

test('missing zstd runtime support is surfaced instead of silently omitting runs', { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'harness-lab-zstd-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessionDir = path.join(root, 'sessions', '--synthetic--', 'synthetic-session')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, 'session.jsonl.zstd'),
    zlib.zstdCompressSync(fixture('run-b.jsonl')),
  )
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'zstdDecompressSync')
  Object.defineProperty(zlib, 'zstdDecompressSync', { ...descriptor, value: undefined })
  try {
    const service = new HarnessLabSessionService({ dshHome: root, codexSessionsRoot: path.join(root, 'missing-codex') })
    await assert.rejects(
      service.listRuns(),
      (error) => error?.code === 'HARNESS_LAB_ZSTD_UNAVAILABLE',
    )
  } finally {
    Object.defineProperty(zlib, 'zstdDecompressSync', descriptor)
  }
})

test('demo session service exposes opaque IDs and rejects arbitrary paths', async () => {
  const service = new HarnessLabSessionService({
    demoMode: true,
    demoDir: path.join(__dirname, '..', 'app', 'demo'),
  })
  const runs = await service.listRuns()
  assert.equal(runs.length, 2)
  assert.ok(runs.every((run) => /^[a-f0-9]{24}$/.test(run.runId)))
  assert.ok(runs.every((run) => run.steps === undefined))
  await assert.rejects(service.getRun('../session.jsonl'), /Unknown run/)
  const fullRun = await service.getRun(runs[0].runId)
  const publicPayload = JSON.stringify(fullRun)
  assert.doesNotMatch(publicPayload, /Synthetic fixture task|Synthetic fixture completion|npm test/)
  assert.doesNotMatch(publicPayload, /synthetic-run-[ab]|[A-Za-z]:\\|\/synthetic\//)
  assert.ok(fullRun.steps.every((step) => !Object.hasOwn(step.metadata, 'callSignature')))
  const comparison = await service.compare(runs[0].runId, runs[1].runId)
  assert.equal(comparison.metricDiffs.total_steps.delta, -13)
})

test('session discovery rejects a symbolic-link sessions root', async (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'harness-lab-symlink-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const actualSessions = path.join(root, 'actual-sessions')
  const dshHome = path.join(root, 'dsh-home')
  fs.mkdirSync(actualSessions)
  fs.mkdirSync(dshHome)
  fs.copyFileSync(path.join(fixtureDir, 'run-b.jsonl'), path.join(actualSessions, 'session.jsonl'))
  fs.symlinkSync(actualSessions, path.join(dshHome, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir')
  const service = new HarnessLabSessionService({ dshHome, codexSessionsRoot: path.join(root, 'missing-codex') })
  assert.deepEqual(await service.listRuns(), [])
})
