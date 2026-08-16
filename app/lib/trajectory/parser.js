'use strict'

const { parseDshJsonl } = require('./adapters/dsh-jsonl')

const adapters = Object.freeze({
  'dsh-jsonl': parseDshJsonl,
})

function parseRun(input, options = {}) {
  const format = options.format ?? 'dsh-jsonl'
  const adapter = adapters[format]
  if (!adapter) throw new Error(`Unsupported session format: ${format}`)
  return adapter(input, options)
}

module.exports = {
  adapters,
  parseRun,
}
