'use strict'

const path = require('node:path')

const REDACTED = '[REDACTED]'
const OMITTED = '[CONTENT OMITTED]'

const SECRET_KEYS = new Set([
  'apikey',
  'token',
  'authorization',
  'password',
  'secret',
  'cookie',
  'sessiontoken',
  'accesstoken',
  'clientsecret',
  'privatekey',
  'credential',
  'credentials',
])

const CONTENT_KEYS = new Set([
  'arguments',
  'body',
  'command',
  'prompt',
  'input',
  'messages',
  'message',
  'content',
  'text',
  'output',
  'stdout',
  'stderr',
  'result',
  'reasoning',
  'thinking',
])

const PATH_KEYS = new Set([
  'cwd',
  'workspace',
  'path',
  'filepath',
  'filename',
  'directory',
  'dir',
])

function normalizedKey(key) {
  return String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSecretKey(key) {
  const normalized = normalizedKey(key)
  if (SECRET_KEYS.has(normalized)) return true
  const sensitiveParts = [
    'apikey',
    'authorization',
    'password',
    'secret',
    'secretkey',
    'accesskey',
    'accesskeyid',
    'cookie',
    'sessiontoken',
    'accesstoken',
    'refreshtoken',
    'authtoken',
    'credential',
    'credentials',
  ]
  return sensitiveParts.some((part) => normalized.includes(part))
}

function isContentKey(key) {
  return CONTENT_KEYS.has(normalizedKey(key))
}

function isPathKey(key) {
  return PATH_KEYS.has(normalizedKey(key))
}

function basenameOnly(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return null
  const pieces = trimmed.split(/[\\/]/).filter(Boolean)
  return pieces.at(-1) || null
}

function redactAbsolutePaths(value) {
  return value
    .replace(/["'](?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*["']/g, '[PATH]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|?*,;)\]}]*/g, '[PATH]')
    .replace(/(^|[\s(=[{,:])\\\\[^\\\r\n"'<>|?*,;)\]}]+(?:\\[^\\\r\n"'<>|?*,;)\]}]+)+/g, '$1[PATH]')
    .replace(/(^|[\s(=[{,:])\/(?!\/)[^\r\n"'<>|,;)\]}]*/g, '$1[PATH]')
}

function redactSecretPatterns(value) {
  if (typeof value !== 'string') return value
  let clean = value
  clean = clean.replace(/\b(?:https?|socks5?):\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => {
    const scheme = match.slice(0, match.indexOf('://') + 3)
    return `${scheme}${REDACTED}@`
  })
  clean = clean.replace(/\bBearer\s+[^\s,;]+/gi, REDACTED)
  clean = clean.replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, REDACTED)
  clean = clean.replace(/\bghp_[A-Za-z0-9_]{4,}\b/gi, REDACTED)
  clean = clean.replace(/\bgithub_pat_[A-Za-z0-9_]{4,}\b/gi, REDACTED)
  return clean
}

function redactString(value) {
  return redactAbsolutePaths(redactSecretPatterns(value))
}

function sanitizeMetadata(value, options = {}, depth = 0, parentKey = '') {
  const maxDepth = options.maxDepth ?? 5
  const maxArray = options.maxArray ?? 32
  const maxString = options.maxString ?? 160
  const preserveStrings = options.preserveStrings ?? true

  if (depth > maxDepth) return '[TRUNCATED]'
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (isContentKey(parentKey)) return OMITTED
    if (!preserveStrings) return OMITTED
    if (isPathKey(parentKey)) return basenameOnly(value)
    const clean = redactString(value)
    return clean.length > maxString ? `${clean.slice(0, maxString)}…` : clean
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((item) => sanitizeMetadata(item, options, depth + 1, parentKey))
  }
  if (typeof value !== 'object') return String(value)

  const output = Object.create(null)
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) {
      output[key] = REDACTED
    } else if (isContentKey(key)) {
      output[key] = OMITTED
    } else {
      output[key] = sanitizeMetadata(child, options, depth + 1, key)
    }
  }
  return output
}

function safeLabel(value, fallback = null, maxLength = 80) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  return redactString(value.trim()).slice(0, maxLength)
}

function safeIdentifier(value, fallback = null, maxLength = 80, allowed = /^[A-Za-z0-9][A-Za-z0-9._/@+\-]*$/) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (
    !trimmed
    || trimmed.length > maxLength
    || !allowed.test(trimmed)
    || path.posix.isAbsolute(trimmed)
    || path.win32.isAbsolute(trimmed)
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
  ) return fallback
  const clean = redactSecretPatterns(trimmed)
  return clean === trimmed ? clean : fallback
}

module.exports = {
  OMITTED,
  REDACTED,
  basenameOnly,
  isContentKey,
  isPathKey,
  isSecretKey,
  redactSecretPatterns,
  redactString,
  safeIdentifier,
  safeLabel,
  sanitizeMetadata,
}
