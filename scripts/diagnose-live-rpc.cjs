// Read-only live-RPC diagnostic. It sends only list/catalog reads and invalid
// model selections; it never submits a prompt or a valid mutation.
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const PORT = Number(process.env.DSH_LIVE_RPC_PORT || 59764)
const LOG_PATH = path.join(os.tmpdir(), 'deepseek-desktop.log')
const TIMEOUT_MS = 8_000

function liveUrl() {
  const log = fs.readFileSync(LOG_PATH, 'utf8')
  const pattern = new RegExp(`http://127\\.0\\.0\\.1:${PORT}/\\?token=([A-Za-z0-9_-]+)`, 'g')
  const matches = [...log.matchAll(pattern)]
  if (matches.length === 0) throw new Error(`no launch URL for live port ${PORT}`)
  const token = matches.at(-1)[1]
  return { launchUrl: `http://127.0.0.1:${PORT}/?token=${token}`, matchCount: matches.length }
}

function scrub(value) {
  return String(value).replace(/[?&]token=[A-Za-z0-9_-]+/g, '$1<redacted>').slice(0, 300)
}

function valueSummary(value, endpoint) {
  if (value === null || typeof value !== 'object') return { valueType: typeof value }
  const keys = Object.keys(value)
  if (endpoint === 'session/list') {
    return { valueKeys: keys, itemCount: Array.isArray(value.items) ? value.items.length : null }
  }
  if (endpoint === 'session/modelCatalog') {
    const groups = Array.isArray(value.groups) ? value.groups : []
    const failures = Array.isArray(value.failures) ? value.failures : []
    return {
      valueKeys: keys,
      groupCount: groups.length,
      modelCount: groups.reduce((count, group) => count + (Array.isArray(group.models) ? group.models.length : 0), 0),
      failureCount: failures.length,
      routableProviderCount: Array.isArray(value.routableProviders) ? value.routableProviders.length : null,
    }
  }
  return { valueKeys: keys }
}

async function authenticate(launchUrl) {
  const start = performance.now()
  try {
    const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    const setCookie = response.headers.get('set-cookie')
    return {
      status: response.status,
      ms: Math.round(performance.now() - start),
      hasCookie: typeof setCookie === 'string' && setCookie.length > 0,
      cookie: typeof setCookie === 'string' ? setCookie.split(';', 1)[0] : undefined,
    }
  } catch (error) {
    return { ms: Math.round(performance.now() - start), error: scrub(error instanceof Error ? `${error.name}: ${error.message}` : error) }
  }
}

async function rpc(origin, cookie, endpoint, args) {
  const rpcId = `dsh-live-diag-${crypto.randomUUID()}`
  const start = performance.now()
  const result = { endpoint, envelope: 'client-request/payload.args', rpcIdPrefix: rpcId.slice(0, 17) }
  try {
    const response = await fetch(`${origin}/api/${endpoint}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const bodyText = await response.text()
    result.status = response.status
    result.ms = Math.round(performance.now() - start)
    result.bodyBytes = Buffer.byteLength(bodyText)
    let body
    try {
      body = JSON.parse(bodyText)
    } catch (error) {
      result.parseError = scrub(error instanceof Error ? error.message : error)
      return result
    }
    if (body?.result?.ok === true) {
      result.result = 'ok'
      if (endpoint === 'session/list' && typeof body.result.value?.items?.[0]?.sessionId === 'string') {
        result.__firstSessionId = body.result.value.items[0].sessionId
      }
      result.value = valueSummary(body.result.value, endpoint)
    } else if (body?.result?.ok === false && body.result.error) {
      result.result = 'failure'
      result.errorCode = body.result.error.code
      result.errorMessage = scrub(body.result.error.message)
      result.errorDetailKeys = body.result.error.details && typeof body.result.error.details === 'object'
        ? Object.keys(body.result.error.details)
        : []
    } else {
      result.result = 'invalid-envelope'
      result.bodyKeys = body && typeof body === 'object' ? Object.keys(body) : []
    }
  } catch (error) {
    result.ms = Math.round(performance.now() - start)
    result.error = scrub(error instanceof Error ? `${error.name}: ${error.message}` : error)
  }
  return result
}

async function runNode() {
  const { launchUrl, matchCount } = liveUrl()
  const origin = new URL(launchUrl).origin
  const auth = await authenticate(launchUrl)
  const output = { mode: 'node-http', live: { port: PORT, urlMatchedForPort: matchCount, origin }, auth: { status: auth.status, ms: auth.ms, hasCookie: auth.hasCookie, error: auth.error } }
  if (auth.cookie === undefined) return output
  const list = await rpc(origin, auth.cookie, 'session/list', { _request: {} })
  const sessionId = list.__firstSessionId || '__dsh-diagnostic-invalid-session__'
  delete list.__firstSessionId
  const catalog = await rpc(origin, auth.cookie, 'session/modelCatalog', {})
  const invalidProvider = await rpc(origin, auth.cookie, 'session/selectModel', {
    request: { sessionId, provider: '__dsh_diagnostic_missing_provider__', model: '__dsh_diagnostic_missing_model__' },
  })
  const invalidSession = await rpc(origin, auth.cookie, 'session/selectModel', {
    request: { sessionId: '__dsh-diagnostic-invalid-session__', provider: '__dsh_diagnostic_missing_provider__', model: '__dsh_diagnostic_missing_model__' },
  })
  output.calls = [
    list,
    catalog,
    { ...invalidProvider, chosenSession: sessionId === '__dsh-diagnostic-invalid-session__' ? 'synthetic-invalid' : 'existing-from-list' },
    invalidSession,
  ]
  return output
}

async function runRenderer() {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-rpc-diagnostic-')))
  await app.whenReady()
  const { launchUrl, matchCount } = liveUrl()
  const origin = new URL(launchUrl).origin
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const loadStart = performance.now()
  try {
    await Promise.race([
      win.loadURL(launchUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('renderer page load timeout')), TIMEOUT_MS)),
    ])
    const loadMs = Math.round(performance.now() - loadStart)
    const probe = await win.webContents.executeJavaScript(`(async () => {
      const scrub = value => String(value).replace(/[?&]token=[A-Za-z0-9_-]+/g, '$1<redacted>').slice(0, 300)
      const summary = (value, endpoint) => {
        if (value === null || typeof value !== 'object') return { valueType: typeof value }
        const keys = Object.keys(value)
        if (endpoint === 'session/list') return { valueKeys: keys, itemCount: Array.isArray(value.items) ? value.items.length : null }
        if (endpoint === 'session/modelCatalog') {
          const groups = Array.isArray(value.groups) ? value.groups : []
          const failures = Array.isArray(value.failures) ? value.failures : []
          return { valueKeys: keys, groupCount: groups.length, modelCount: groups.reduce((n, group) => n + (Array.isArray(group.models) ? group.models.length : 0), 0), failureCount: failures.length, routableProviderCount: Array.isArray(value.routableProviders) ? value.routableProviders.length : null }
        }
        return { valueKeys: keys }
      }
      const rpc = async (endpoint, args) => {
        const rpcId = 'dsh-live-diag-' + crypto.randomUUID()
        const start = performance.now()
        const result = { endpoint, envelope: 'client-request/payload.args', rpcIdPrefix: rpcId.slice(0, 17) }
        try {
          const response = await fetch('/api/' + endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), signal: AbortSignal.timeout(${TIMEOUT_MS}) })
          const bodyText = await response.text()
          result.status = response.status
          result.ms = Math.round(performance.now() - start)
          result.bodyBytes = new TextEncoder().encode(bodyText).byteLength
          let body
          try { body = JSON.parse(bodyText) } catch (error) { result.parseError = scrub(error.message); return result }
          if (body?.result?.ok === true) {
            result.result = 'ok'
            if (endpoint === 'session/list' && typeof body.result.value?.items?.[0]?.sessionId === 'string') result.__firstSessionId = body.result.value.items[0].sessionId
            result.value = summary(body.result.value, endpoint)
          }
          else if (body?.result?.ok === false && body.result.error) { result.result = 'failure'; result.errorCode = body.result.error.code; result.errorMessage = scrub(body.result.error.message); result.errorDetailKeys = body.result.error.details && typeof body.result.error.details === 'object' ? Object.keys(body.result.error.details) : [] }
          else { result.result = 'invalid-envelope'; result.bodyKeys = body && typeof body === 'object' ? Object.keys(body) : [] }
        } catch (error) { result.ms = Math.round(performance.now() - start); result.error = scrub(error.name + ': ' + error.message) }
        return result
      }
      const list = await rpc('session/list', { _request: {} })
      const sessionId = list.__firstSessionId || '__dsh-diagnostic-invalid-session__'
      delete list.__firstSessionId
      const catalog = await rpc('session/modelCatalog', {})
      const invalidProvider = await rpc('session/selectModel', { request: { sessionId, provider: '__dsh_diagnostic_missing_provider__', model: '__dsh_diagnostic_missing_model__' } })
      const invalidSession = await rpc('session/selectModel', { request: { sessionId: '__dsh-diagnostic-invalid-session__', provider: '__dsh_diagnostic_missing_provider__', model: '__dsh_diagnostic_missing_model__' } })
      return { calls: [list, catalog, { ...invalidProvider, chosenSession: sessionId === '__dsh-diagnostic-invalid-session__' ? 'synthetic-invalid' : 'existing-from-list' }, invalidSession] }
    })()`)
    return { mode: 'electron-renderer', live: { port: PORT, urlMatchedForPort: matchCount, origin }, pageLoadMs: loadMs, ...probe }
  } finally {
    win.destroy()
    app.quit()
  }
}

if (process.versions.electron !== undefined) {
  runRenderer().then(output => console.log(JSON.stringify(output, null, 2))).catch(error => { console.error(scrub(error instanceof Error ? error.stack || error.message : error)); process.exitCode = 1 })
  setTimeout(() => process.exit(2), 60_000).unref()
} else {
  runNode().then(output => console.log(JSON.stringify(output, null, 2))).catch(error => { console.error(scrub(error instanceof Error ? error.stack || error.message : error)); process.exitCode = 1 })
}
