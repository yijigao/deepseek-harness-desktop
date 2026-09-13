'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRun } = require('../app/lib/trajectory/parser')
const { parseRunOffThread } = require('../app/lib/trajectory/parse-async')

test('background parser preserves the synchronous parser result', async () => {
  const input = Buffer.from(JSON.stringify({ type: 'session', version: 0, id: 'synthetic-worker', createdAt: 1 }))
  const options = { fileName: 'session.jsonl', identitySeed: 'synthetic-worker' }
  assert.deepEqual(await parseRunOffThread(input, options), parseRun(input, options))
})

test('background parser rejects invalid compressed data rather than hanging', async () => {
  await assert.rejects(parseRunOffThread(Buffer.from('invalid'), { fileName: 'session.jsonl.zstd' }))
})
