'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { HarnessLabSessionService } = require('../app/lib/harness-lab/session-service')
const { generation, selectGeneration } = require('../app/lib/trajectory/session-generation')
const { parseDshJsonl } = require('../app/lib/trajectory/adapters/dsh-jsonl')

test('generation selection refuses ambiguity and noncanonical names', () => {
  for (const name of ['session.v0.jsonl', 'session.v02.jsonl', 'session.V2.jsonl', 'session.v2.jsonl.tmp']) {
    assert.equal(generation(name), null)
  }
  const entries = ['session.jsonl', 'session.v2.jsonl.zstd'].map(name => ({ name }))
  assert.equal(selectGeneration(entries).entry.name, 'session.v2.jsonl.zstd')
  assert.equal(selectGeneration([...entries, { name: 'session.v2.jsonl' }]).ambiguous, true)
})

test('Lab v2 keeps accounting timestamps and does not double count settlement usage', () => {
  const now = Date.now()
  const rows = [ { type: 'session', version: 2 },
    { type: 'assistant/message', seq: 0, time: now, data: {
      usage: { inputTokens: 12, outputTokens: 3 },
      stream: [{ type: 'chunk', time: now - 100, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } } }],
    } } ]
  const run = parseDshJsonl(rows.map(JSON.stringify).join('\n'))
  assert.equal(run.metrics.total_tokens, 15)
  assert.equal(run.steps.find(step => step.metadata.usage).timestamp, new Date(now - 100).toISOString())
  assert.throws(() => parseDshJsonl(JSON.stringify({ type: 'session', version: 3 })), /Unsupported/)
})

test('Lab selects the successor while preserving its opaque navigation identity', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lab-generation-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const directory = path.join(home, 'sessions', 'project', 'test')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'session.jsonl'), JSON.stringify({ type: 'session', version: 0, id: 'test' }))
  const service = new HarnessLabSessionService({ dshHome: home })
  const old = await service.listRuns()
  fs.writeFileSync(path.join(directory, 'session.v2.jsonl'), JSON.stringify({ type: 'session', version: 2, id: 'test' }))
  const files = await service.discoverFiles()
  assert.equal(files.length, 1)
  assert.equal(path.basename(files[0].filePath), 'session.v2.jsonl')
  const current = await service.listRuns()
  assert.equal(current[0].runId, old[0].runId)
})
