/**
 * Narrow loopback RPC lifecycle diagnostics for the main application window.
 *
 * This observes Chromium's request events without touching request bodies or
 * response data. Only the current engine origin and the two model/session
 * mutation endpoints are admitted; the pending table is deliberately bounded
 * so a broken renderer cannot turn diagnostics into an unbounded cache.
 */

const TRACKED_PATHS = new Map([
  ['/api/session/selectModel', 'session/selectModel'],
  ['/api/session/create', 'session/create'],
])

function originOf(value) {
  try {
    const parsed = new URL(String(value))
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.origin
  } catch {
    return null
  }
}

function field(value, fallback = 'unknown') {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 96)
  return text || fallback
}

function networkError(value) {
  const text = String(value ?? '')
  return /^net::ERR_[A-Z0-9_]+$/u.test(text) ? text : 'unknown'
}

function duration(now, startedAt) {
  return Math.max(0, Math.round(now() - startedAt))
}

/**
 * Attach request lifecycle logging to one Electron WebContents session.
 *
 * @param {object} options
 * @param {object} options.webRequest - Electron WebRequest instance.
 * @param {string} options.engineOrigin - authenticated engine URL or origin.
 * @param {(line: string) => void} options.log - bounded/redacted log sink.
 * @param {number} [options.maxPending=64] - maximum tracked requests.
 * @param {() => number} [options.now=Date.now] - monotonic-ish clock for tests.
 * @returns {{dispose: () => void, pendingCount: () => number}}
 */
function attachRpcLifecycleLogging({ webRequest, engineOrigin, log, maxPending = 64, now = Date.now }) {
  const origin = originOf(engineOrigin)
  const limit = Number.isSafeInteger(maxPending) && maxPending > 0 ? maxPending : 64
  const pending = new Map()
  let disposed = false

  const emit = (stage, entry, status, durationMs, netError) => {
    try {
      log(
        `[rpc] stage=${stage}`
        + ` requestId=${field(entry.requestId)}`
        + ` endpoint=${entry.endpoint}`
        + ` status=${status === undefined ? '-' : field(status)}`
        + ` durationMs=${durationMs === undefined ? '-' : String(durationMs)}`
        + ` netError=${netError === undefined ? '-' : field(netError)}`
        + ` pending=${pending.size}`,
      )
    } catch {
      // Diagnostics must never affect the request or throw from an Electron
      // WebRequest callback.
    }
  }

  const entryFor = (details) => {
    if (disposed || origin === null || details?.method !== 'POST') return null
    // Electron WebRequest calls this field `id`; `requestId` belongs to CDP.
    const requestId = details.id
    if (!Number.isSafeInteger(requestId) || requestId < 0) return null
    let parsed
    try { parsed = new URL(String(details.url)) } catch { return null }
    if (parsed.origin !== origin) return null
    const endpoint = TRACKED_PATHS.get(parsed.pathname)
    if (endpoint === undefined) return null
    const key = String(requestId)
    if (!pending.has(key) && pending.size >= limit) return null
    return { key, requestId: key, endpoint, startedAt: now() }
  }

  const onBeforeRequest = (details, callback) => {
    // Chromium requires the callback to run even when diagnostic parsing or
    // logging encounters hostile input.
    try {
      const entry = entryFor(details)
      if (entry !== null) {
        pending.set(entry.key, entry)
        emit('start', entry)
      }
    } finally {
      callback({})
    }
  }

  const onCompleted = (details) => {
    const key = details?.id === undefined || details?.id === null
      ? undefined
      : Number.isSafeInteger(details.id) && details.id >= 0 ? String(details.id) : undefined
    if (key === undefined) return
    const entry = pending.get(key)
    if (entry === undefined) return
    pending.delete(key)
    emit('complete', entry, details.statusCode, duration(now, entry.startedAt))
  }

  const onErrorOccurred = (details) => {
    const key = details?.id === undefined || details?.id === null
      ? undefined
      : Number.isSafeInteger(details.id) && details.id >= 0 ? String(details.id) : undefined
    if (key === undefined) return
    const entry = pending.get(key)
    if (entry === undefined) return
    pending.delete(key)
    emit('error', entry, undefined, duration(now, entry.startedAt), networkError(details.error))
  }

  webRequest.onBeforeRequest(onBeforeRequest)
  webRequest.onCompleted(onCompleted)
  webRequest.onErrorOccurred(onErrorOccurred)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      pending.clear()
      webRequest.onBeforeRequest(null)
      webRequest.onCompleted(null)
      webRequest.onErrorOccurred(null)
    },
    pendingCount: () => pending.size,
  }
}

module.exports = { attachRpcLifecycleLogging }
