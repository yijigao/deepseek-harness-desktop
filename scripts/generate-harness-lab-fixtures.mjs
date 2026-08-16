import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function buildRun({ id, startedAt, steps, toolCalls, retries, failedCalls, testAt, inputTokens, outputTokens, variant }) {
  const start = Date.parse(startedAt)
  let seq = -1
  let clock = 0
  const records = [{
    type: 'session',
    version: 0,
    id,
    createdAt: start,
    cwd: `C:\\synthetic\\workspace\\${variant}`,
    delegationDepth: 0,
  }]

  const event = (type, data = {}) => {
    records.push({ type, seq: seq += 1, time: start + (clock += 350), data })
  }

  event('turn/start', { turn: 1 })
  event('user/message', { message: { role: 'user', content: 'Synthetic fixture task; not copied from a user session.' } })

  let callIndex = 0
  for (let step = 0; step < steps; step += 1) {
    event('step/start', { step })
    const callsThisStep = step < toolCalls - steps ? 2 : 1
    for (let local = 0; local < callsThisStep && callIndex < toolCalls; local += 1) {
      const spec = toolSpec(variant, callIndex, testAt)
      const callId = `${variant}-call-${callIndex}`
      event('tool/call', {
        callId,
        name: spec.name,
        arguments: JSON.stringify(spec.args),
      })
      const failed = failedCalls.includes(callIndex)
      const resultBlock = {
        type: 'tool-result',
        toolCallId: callId,
        isError: failed,
        content: failed ? 'Synthetic command failure.' : 'Synthetic command success.',
      }
      const result = { callId, message: { role: 'tool', content: [resultBlock] } }
      if (failed) result.error = { code: 'SYNTHETIC_FAILURE' }
      event('tool/result', result)
      callIndex += 1
    }
    event('step/end', { step })
  }

  for (let index = 0; index < retries; index += 1) {
    event('llm/retry', { attempt: index + 1, reason: 'synthetic transient condition' })
  }
  event('assistant/message', {
    message: {
      role: 'assistant',
      content: 'Synthetic fixture completion.',
      source: { model: variant === 'run-a' ? 'deepseek-demo-a' : 'deepseek-demo-b' },
    },
    usage: { inputTokens, outputTokens },
  })
  event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function toolSpec(variant, index, testAt) {
  if (variant === 'run-a' && index < 3) {
    return { name: 'grep', args: { pattern: 'SYNTHETIC_MARKER', path: 'C:\\synthetic\\workspace\\run-a' } }
  }
  if (variant === 'run-a' && [3, 10, 20, 21].includes(index)) {
    return { name: 'bash', args: { command: 'npm test' } }
  }
  if (variant === 'run-b' && index === testAt) {
    return { name: 'bash', args: { command: 'npm test' } }
  }

  if (variant === 'run-a') {
    const mode = index % 6
    if (mode === 0) return { name: 'read', args: { path: `C:\\synthetic\\workspace\\run-a\\source-${index}.js` } }
    if (mode === 1) return { name: 'grep', args: { pattern: `synthetic-${index}`, path: 'C:\\synthetic\\workspace\\run-a' } }
    if (mode === 2) return { name: 'glob', args: { pattern: `**/synthetic-${index}.js` } }
    if (mode === 3) return { name: 'edit', args: { path: `C:\\synthetic\\workspace\\run-a\\edit-${index}.js`, replacement: 'synthetic edit' } }
    if (mode === 4) return { name: 'write', args: { path: `C:\\synthetic\\workspace\\run-a\\write-${index}.js`, content: 'synthetic file' } }
    return { name: 'bash', args: { command: `node synthetic-check-${index}.js` } }
  }

  const mode = index % 7
  if (mode === 0) return { name: 'read', args: { path: `C:\\synthetic\\workspace\\run-b\\source-${index}.js` } }
  if (mode === 1) return { name: 'grep', args: { pattern: `synthetic-${index}`, path: 'C:\\synthetic\\workspace\\run-b' } }
  if (mode === 2) return { name: 'glob', args: { pattern: `**/synthetic-${index}.js` } }
  if (mode === 3) return { name: 'edit', args: { path: `C:\\synthetic\\workspace\\run-b\\edit-${index}.js`, replacement: 'synthetic edit' } }
  if (mode === 4) return { name: 'read_image', args: { path: `C:\\synthetic\\workspace\\run-b\\image-${index}.png` } }
  if (mode === 5) return { name: 'bash', args: { command: `node synthetic-check-${index}.js` } }
  return { name: 'inspect', args: { target: `synthetic-${index}` } }
}

const runA = buildRun({
  id: 'synthetic-run-a',
  startedAt: '2026-01-03T10:00:00.000Z',
  steps: 31,
  toolCalls: 46,
  retries: 6,
  failedCalls: [3, 10, 20],
  testAt: 3,
  inputTokens: 9600,
  outputTokens: 2800,
  variant: 'run-a',
})

const runB = buildRun({
  id: 'synthetic-run-b',
  startedAt: '2026-01-02T10:00:00.000Z',
  steps: 18,
  toolCalls: 27,
  retries: 1,
  failedCalls: [],
  testAt: 7,
  inputTokens: 6100,
  outputTokens: 1700,
  variant: 'run-b',
})

const unknownEvents = [
  JSON.stringify({ type: 'session', version: 0, id: 'synthetic-unknown', createdAt: Date.parse('2026-01-04T10:00:00.000Z'), cwd: '/synthetic/workspace/unknown', delegationDepth: 0 }),
  JSON.stringify({ type: 'future/event', seq: 0, time: Date.parse('2026-01-04T10:00:01.000Z'), data: { futureField: 42, content: 'Synthetic content that must be omitted.', path: '/synthetic/workspace/unknown/file.js' } }),
  '{"type":',
  JSON.stringify({ seq: 1, time: Date.parse('2026-01-04T10:00:02.000Z'), data: { futureField: true } }),
  JSON.stringify({ type: 'turn/end', seq: 2, time: Date.parse('2026-01-04T10:00:03.000Z'), data: {} }),
].join('\n') + '\n'

const secretRedaction = [
  JSON.stringify({ type: 'session', version: 0, id: 'synthetic-redaction', createdAt: Date.parse('2026-01-05T10:00:00.000Z'), cwd: 'C:\\synthetic\\workspace\\redaction', delegationDepth: 0 }),
  JSON.stringify({ type: 'future/metadata', seq: 0, time: Date.parse('2026-01-05T10:00:01.000Z'), data: { api_key: 'synthetic-placeholder', apikey: 'synthetic-placeholder', token: 'synthetic-placeholder', authorization: 'synthetic-placeholder', proxy_authorization: 'synthetic-placeholder', password: 'synthetic-placeholder', secret: 'synthetic-placeholder', cookie: 'synthetic-placeholder', session_token: 'synthetic-placeholder', access_token: 'synthetic-placeholder', path: 'C:\\synthetic\\workspace\\redaction\\fixture.js' } }),
  JSON.stringify({ type: 'user/message', seq: 1, time: Date.parse('2026-01-05T10:00:02.000Z'), data: { message: { role: 'user', content: 'Synthetic prompt content.' } } }),
].join('\n') + '\n'

const destinations = [
  ['tests/fixtures/run-a.jsonl', runA],
  ['tests/fixtures/run-b.jsonl', runB],
  ['tests/fixtures/run-unknown-events.jsonl', unknownEvents],
  ['tests/fixtures/run-secret-redaction.jsonl', secretRedaction],
  ['app/demo/run-a.jsonl', runA],
  ['app/demo/run-b.jsonl', runB],
]

for (const [relativePath, contents] of destinations) {
  const target = path.join(repositoryRoot, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents, 'utf8')
}
