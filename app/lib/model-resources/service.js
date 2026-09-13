'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { EventEmitter } = require('node:events')
const { cachePath, normalizeCodexUsage, normalizeDeepSeekBalance, parseDefaultRoute, publicSnapshot } = require('./resource-utils')

const REFRESH_TTL_MS = 60_000
// Electron's cold decompression of a large history can exceed 15 seconds.
// The worker saves bounded batches; allow one slow file to finish and checkpoint.
const WORKER_TIMEOUT_MS = 45_000

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

function readCredentials(dshHome) {
  const data = readJson(path.join(dshHome, 'oauth-credentials.json'))
  const credential = data?.['openai-codex']
  if (!credential || typeof credential !== 'object') return null
  if (typeof credential.access !== 'string' || typeof credential.accountId !== 'string') return null
  return { access: credential.access, accountId: credential.accountId }
}

function runSessionWorker(sessionsRoot, maxFiles, summaryFile) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'session-usage-worker.js'), {
      workerData: { sessionsRoot, maxFiles, summaryFile },
      stdout: process.env.MODEL_RESOURCE_DEBUG === '1',
      stderr: process.env.MODEL_RESOURCE_DEBUG === '1',
    })
    if (worker.stdout) worker.stdout.pipe(process.stdout)
    if (worker.stderr) worker.stderr.pipe(process.stderr)
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {})
      finish(null)
    }, WORKER_TIMEOUT_MS)
    worker.once('message', (message) => finish(message?.ok ? message.value : null))
    worker.once('error', (error) => {
      if (process.env.MODEL_RESOURCE_DEBUG === '1') process.stderr.write(`[model-resource-worker] ${error.stack || error}\n`)
      finish(null)
    })
    worker.once('exit', (code) => {
      if (code && process.env.MODEL_RESOURCE_DEBUG === '1') process.stderr.write(`[model-resource-worker] exited ${code}\n`)
      finish(null)
    })
  })
}

class ModelResourceService extends EventEmitter {
  constructor(options) {
    super()
    this.dshHome = path.resolve(options.dshHome)
    this.probeProviderResources = options.probeProviderResources
    this.snapshotFile = cachePath(this.dshHome)
    this.snapshot = this.initialSnapshot()
    this.refreshPromise = null
    this.lastRefreshStartedAt = 0
    this.watcher = null
    this.watchTimer = null
    this.retryTimer = null
    this.stopped = false
    this.providerData = null
    this.providerFetchedAt = 0
  }

  defaultRoute() {
    try { return parseDefaultRoute(fs.readFileSync(path.join(this.dshHome, 'settings.yaml'), 'utf8')) } catch { return parseDefaultRoute('') }
  }

  initialSnapshot() {
    const route = this.defaultRoute()
    const cached = readJson(this.snapshotFile)
    return publicSnapshot(cached || {
      route,
      account: { connected: Boolean(readCredentials(this.dshHome)), kind: route.provider === 'openai-codex' ? 'chatgpt-subscription' : 'provider-account' },
      quota: { status: 'unavailable', source: 'unavailable', windows: [], message: '正在后台读取额度。' },
      updatedAt: null,
    }, route)
  }

  getCachedSnapshot() {
    const stale = this.snapshot.quota.fetchedAt
      && Date.now() - Date.parse(this.snapshot.quota.fetchedAt) > REFRESH_TTL_MS * 5
    return publicSnapshot({
      ...this.snapshot,
      quota: stale && this.snapshot.quota.status === 'available'
        ? { ...this.snapshot.quota, status: 'stale' }
        : this.snapshot.quota,
    }, this.defaultRoute())
  }

  scheduleRefresh(options = {}) {
    const force = Boolean(options.force)
    if (this.refreshPromise) return this.refreshPromise
    if (!force && Date.now() - this.lastRefreshStartedAt < REFRESH_TTL_MS) return Promise.resolve(this.getCachedSnapshot())
    this.lastRefreshStartedAt = Date.now()
    this.refreshPromise = this.refreshNow({ forceProvider: force && !options.localOnly }).finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }

  async fetchProviderResources() {
    if (typeof this.probeProviderResources !== 'function') return { quota: null, resources: [] }
    let result
    try { result = await this.probeProviderResources() } catch { return { quota: null, resources: [] } }
    const resources = []
    if (result?.deepseek?.ok) resources.push(normalizeDeepSeekBalance(result.deepseek.payload))
    else resources.push({ provider: 'deepseek-official', label: 'DeepSeek API', kind: 'balance', status: 'unavailable', balances: [], fetchedAt: new Date().toISOString(), message: result?.deepseek?.code === 'NOT_CONFIGURED' ? '尚未配置 DeepSeek API Key。' : result?.deepseek?.code === 'INVALID_CREDENTIAL' ? 'DeepSeek API Key 无效。' : 'DeepSeek 余额服务暂不可用。' })
    return { quota: result?.codex?.ok ? normalizeCodexUsage(result.codex.payload) : null, resources }
  }

  async providerResources(force) {
    if (!force && this.providerData && Date.now() - this.providerFetchedAt < REFRESH_TTL_MS) return this.providerData
    this.providerFetchedAt = Date.now()
    this.providerData = await this.fetchProviderResources()
    return this.providerData
  }

  async refreshNow({ forceProvider = false } = {}) {
    const defaultRoute = this.defaultRoute()
    const provisionalRoute = this.snapshot.route?.provider && this.snapshot.route?.model ? this.snapshot.route : defaultRoute
    const [local, providerData] = await Promise.all([
      runSessionWorker(path.join(this.dshHome, 'sessions'), undefined, path.join(this.dshHome, 'model-usage-summaries.json')),
      this.providerResources(forceProvider),
    ])
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    if ((!local || local.localUsage?.incomplete) && !this.stopped) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.scheduleRefresh({ force: true, localOnly: true }).catch(() => {})
      }, REFRESH_TTL_MS)
      this.retryTimer.unref?.()
    }
    const route = local?.route?.provider && local?.route?.model ? local.route : defaultRoute
    const quota = (route.provider === 'openai-codex' ? providerData.quota : null) || {
      status: 'unavailable', source: 'unavailable', windows: [], fetchedAt: new Date().toISOString(),
      message: route.provider ? '该提供商暂未接入账户额度接口。' : '尚未识别当前模型。',
    }
    const next = publicSnapshot({
      route,
      account: {
        connected: route.provider === 'openai-codex' ? Boolean(readCredentials(this.dshHome)) : true,
        kind: route.provider === 'openai-codex' ? 'chatgpt-subscription' : 'provider-account',
      },
      quota,
      resources: providerData.resources,
      localUsage: local?.localUsage || { ...this.snapshot.localUsage, incomplete: true },
      updatedAt: new Date().toISOString(),
    }, defaultRoute)
    this.snapshot = next
    try { atomicWriteJson(this.snapshotFile, next) } catch {}
    this.emit('updated', next)
    return next
  }

  startWatching() {
    this.stopped = false
    if (this.watcher) return
    try {
      this.watcher = fs.watch(path.join(this.dshHome, 'sessions'), { recursive: true }, (_event, filename) => {
        if (!filename || !/(?:^|[\\/])session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(String(filename))) return
        // A bounded throttle also refreshes during continuous streaming. File events
        // must not bypass the provider's independent network refresh interval.
        if (this.watchTimer) return
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null
          this.scheduleRefresh({ force: true, localOnly: true }).catch(() => {})
        }, 15_000)
      })
      this.watcher.on('error', () => this.stopWatching())
    } catch {}
  }

  stopWatching() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    clearTimeout(this.watchTimer)
    this.watchTimer = null
    try { this.watcher?.close() } catch {}
    this.watcher = null
  }

  getLifecycleState() {
    return {
      refreshInFlight: Boolean(this.refreshPromise),
      watcherActive: Boolean(this.watcher),
      stopped: this.stopped,
    }
  }
}

module.exports = {
  ModelResourceService,
  REFRESH_TTL_MS,
  runSessionWorker,
}
