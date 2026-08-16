'use strict'

const zlib = require('node:zlib')
const { normalizeDshRecords } = require('../normalize')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024

function zstdUnavailableError() {
  const error = new Error('This runtime cannot read zstd-compressed DSH sessions')
  error.code = 'HARNESS_LAB_ZSTD_UNAVAILABLE'
  return error
}

function isZstd(buffer, fileName = '') {
  return fileName.toLowerCase().endsWith('.zstd')
    || (buffer.length >= 4 && buffer.subarray(0, 4).equals(ZSTD_MAGIC))
}

function decodeInput(input, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
  if (!isZstd(buffer, options.fileName)) return buffer.toString('utf8')
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw zstdUnavailableError()
  }
  const decodedFrames = []
  let decodedBytes = 0
  let offset = 0
  while (offset < buffer.length) {
    const result = zlib.zstdDecompressSync(buffer.subarray(offset), {
      info: true,
      maxOutputLength: MAX_DECOMPRESSED_BYTES - decodedBytes,
    })
    const frame = Buffer.isBuffer(result) ? result : result.buffer
    const consumed = Buffer.isBuffer(result) ? buffer.length - offset : result.engine.bytesWritten
    if (!Number.isSafeInteger(consumed) || consumed <= 0) throw new Error('Invalid zstd frame boundary')
    decodedFrames.push(frame)
    decodedBytes += frame.length
    if (decodedBytes > MAX_DECOMPRESSED_BYTES) throw new Error('Decompressed session is too large')
    offset += consumed
  }
  return Buffer.concat(decodedFrames, decodedBytes).toString('utf8')
}

function parseJsonLines(text) {
  const records = []
  let header = null
  let malformedLines = 0
  let blankLines = 0
  const lines = String(text).split(/\r?\n/)

  for (const line of lines) {
    if (!line.trim()) {
      blankLines += 1
      continue
    }
    try {
      const value = JSON.parse(line)
      if (!header && value && value.type === 'session' && !Object.hasOwn(value, 'data')) {
        header = value
      } else {
        records.push(value)
      }
    } catch {
      malformedLines += 1
    }
  }

  return {
    header,
    records,
    diagnostics: { blankLines, malformedLines },
  }
}

function parseDshJsonl(input, options = {}) {
  const text = decodeInput(input, options)
  return normalizeDshRecords(parseJsonLines(text), {
    ...options,
    identitySeed: options.identitySeed ?? text,
  })
}

module.exports = {
  decodeInput,
  isZstd,
  MAX_DECOMPRESSED_BYTES,
  parseDshJsonl,
  parseJsonLines,
  zstdUnavailableError,
}
