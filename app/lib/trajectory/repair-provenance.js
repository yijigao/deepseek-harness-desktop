'use strict'

// Explicit recovery only. Never called by discovery or normal session reading.
// Change a reference only when it exactly matches the uniquely observed owner
// after a +1 correction. Content, event sequence and timing remain untouched.
function repairProvenance(rows) {
  let attempt = null
  const calls = new Map()
  const humanMessages = new Set()
  const changes = []
  const unresolved = []
  const repaired = rows.map(row => {
    const data = row.data || {}
    if (row.type === 'user/message' && data.source?.kind === 'user') humanMessages.add(row.seq)
    if (['session/title', 'session/title-llm-request'].includes(row.type) && Array.isArray(data.messageSeqs)) {
      const refs = data.messageSeqs
      if (refs.every(seq => humanMessages.has(seq))) return row
      if (refs.length && refs.every(seq => Number.isSafeInteger(seq) && !humanMessages.has(seq) && humanMessages.has(seq + 1))) {
        changes.push({ seq: row.seq, type: row.type, references: refs.length })
        return { ...row, data: { ...data, messageSeqs: refs.map(seq => seq + 1) } }
      }
      unresolved.push({ seq: row.seq, type: row.type, references: refs.length })
      return row
    }
    // Replacement provenance cites the superseded result, not its tool call.
    if (row.type === 'tool/result' && row.surfaceOp?.op === 'replace') return row
    const packed = ['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(row.type)
    if (row.type === 'assistant/chunk' || packed) {
      const key = `${data.turn}:${data.step}`
      if (!attempt || attempt.key !== key || attempt.terminal) attempt = { key, sources: [], terminal: false }
      const start = packed ? row.seq0 : row.seq
      const count = packed ? (Array.isArray(data.dt) ? data.dt.length + 1 : 0) : 1
      if (!Number.isSafeInteger(start) || count < 1) throw new Error('Invalid chunk sequence')
      for (let index = 0; index < count; index++) attempt.sources.push(start + index)
      attempt.terminal = data.chunk?.type === 'finish'
      return row
    }
    if (row.type === 'tool/call' && typeof data.callId === 'string') {
      const key = `${data.turn}:${data.step}:${data.callId}`
      if (calls.has(key)) calls.set(key, null)
      else calls.set(key, row.seq)
    }
    let expected
    if (row.type === 'assistant/message') {
      if (attempt?.key === `${data.turn}:${data.step}`) expected = attempt.sources
      attempt = null
    } else if (row.type === 'tool/result' && typeof (data.callId ?? data.message?.source?.callId) === 'string') {
      const owner = calls.get(`${data.turn}:${data.step}:${data.callId ?? data.message.source.callId}`)
      if (Number.isSafeInteger(owner)) expected = [owner]
    }
    const encoded = row.sourceEventSeqs
    if (!Array.isArray(encoded) || encoded.length === 0) return row
    if (!['assistant/message', 'tool/result'].includes(row.type)) return row
    const sources = []
    for (const source of encoded) {
      if (Number.isSafeInteger(source)) sources.push(source)
      else if (Array.isArray(source) && source.length === 2 && source.every(Number.isSafeInteger)
        && source[0] >= 0 && source[1] >= source[0] && source[1] < row.seq) {
        if (source[1] - source[0] + sources.length > rows.length * 1000) throw new Error('Reference range exceeds recovery bound')
        for (let seq = source[0]; seq <= source[1]; seq++) sources.push(seq)
      } else throw new Error('Invalid source reference')
    }
    const matches = delta => expected && expected.length === sources.length
      && sources.every((seq, index) => Number.isSafeInteger(seq) && seq + delta === expected[index])
    if (matches(0)) return row
    if (matches(1)) {
      changes.push({ seq: row.seq, type: row.type, references: sources.length })
      return { ...row, sourceEventSeqs: expected.slice() }
    }
    unresolved.push({ seq: row.seq, type: row.type, references: sources.length, expectedCount: expected?.length,
      first: sources[0], last: sources.at(-1), expectedFirst: expected?.[0], expectedLast: expected?.at(-1), surfaceOp: row.surfaceOp })
    return row
  })
  return { rows: repaired, changes, unresolved }
}

module.exports = { repairProvenance }
