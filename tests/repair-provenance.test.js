'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { repairProvenance } = require('../app/lib/trajectory/repair-provenance')

function fixture() {
  return [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: 'unchanged' } },
    { type: 'session/title', seq: 2, data: { messageSeqs: [0], title: 'unchanged' } },
    { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'unchanged' } } },
    { type: 'text-chunks', seq0: 4, data: { turn: 1, step: 1, dt: [1], texts: ['a', 'b'] } },
    { type: 'assistant/chunk', seq: 6, data: { turn: 1, step: 1, chunk: { type: 'finish' } } },
    { type: 'assistant/message', seq: 7, sourceEventSeqs: [2, 3, 4, 5], data: { turn: 1, step: 1, message: { content: 'unchanged' } } },
    { type: 'tool/call', seq: 8, data: { turn: 1, step: 1, callId: 'a', arguments: 'unchanged' } },
    { type: 'tool/result', seq: 9, sourceEventSeqs: [7], data: { turn: 1, step: 1, message: { source: { callId: 'a' }, content: 'unchanged' } } },
    { type: 'tool/result', seq: 10, sourceEventSeqs: [9], surfaceOp: { op: 'replace', start: 9, end: 9 }, data: { turn: 1, step: 1, message: { source: { callId: 'a' } } } },
  ]
}

test('recovery corrects only uniquely matched references and leaves input immutable', () => {
  const rows = fixture()
  const before = structuredClone(rows)
  const result = repairProvenance(rows)
  assert.equal(result.changes.length, 3)
  assert.deepEqual(result.unresolved, [])
  assert.deepEqual(rows, before)
  assert.deepEqual(result.rows[5].sourceEventSeqs, [3, 4, 5, 6])
  assert.deepEqual(result.rows[7].sourceEventSeqs, [8])
  assert.strictEqual(result.rows[8], rows[8])
  for (const index of [5, 7]) assert.deepEqual(result.rows[index].data, rows[index].data)
  assert.equal(repairProvenance(result.rows).changes.length, 0)
})

test('canonical compressed references are not rewritten', () => {
  const rows = fixture()
  rows[5].sourceEventSeqs = [[3, 6]]
  assert.strictEqual(repairProvenance(rows).rows[5], rows[5])
})

test('incomplete attempts, ambiguous calls, and larger offsets are refused', () => {
  const rows = fixture()
  rows[5].sourceEventSeqs = [3, 4]
  rows.splice(7, 0, { ...rows[6], seq: 8.5 })
  const result = repairProvenance(rows)
  assert.equal(result.unresolved.length, 2)
  assert.strictEqual(result.rows[5], rows[5])
  const offset = fixture()
  offset[5].sourceEventSeqs = [1, 2, 3, 4]
  assert.ok(repairProvenance(offset).unresolved.some(item => item.seq === 7))
})

test('title recovery never reassigns a reference already pointing to a human message', () => {
  const rows = fixture()
  rows[1].data.messageSeqs = [1]
  assert.strictEqual(repairProvenance(rows).rows[1], rows[1])
})
