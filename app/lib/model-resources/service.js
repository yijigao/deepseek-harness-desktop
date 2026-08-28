'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { EventEmitter } = require('node:events')
const { cachePath, normalizeCodexUsage, parseDefaultRoute, publicSnapshot } = require('./resource-utils')

const REFRESH_TTL_MS = 60_000
const WORKER_TIMEOUT_MS = 15_000

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

function runSessionWorker(sessionsRoot, maxFiles = 40) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'session-usage-worker.js'), {
      workerData: { sessionsRoot, maxFiles },
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
    this.probeCodexUsage = options.probeCodexUsage
    this.snapshotFile = cachePath(this.dshHome)
    this.snapshot = this.initialSnapshot()
    this.refreshPromise = null
    this.lastRefreshStartedAt = 0
    this.watcher = null
    this.watchTimer = null
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
    this.refreshPromise = this.refreshNow().finally(() => { this.refreshPromise = null })
    return this.refreshPromise
  }

  async fetchCodexQuota(route) {
    if (route.provider !== 'openai-codex' || typeof this.probeCodexUsage !== 'function') return null
    const credential = readCredentials(this.dshHome)
    if (!credential) return null
    try {
      const result = await this.probeCodexUsage()
      if (!result?.ok) {
        return {
          status: 'unavailable', source: 'provider-experimental', windows: [], fetchedAt: new Date().toISOString(),
          message: ['LOGIN_EXPIRED', 'NOT_LOGGED_IN'].includes(result?.code)
            ? '登录凭据需要刷新，请重新登录 ChatGPT。'
            : result?.code === 'TIMEOUT' ? '额度服务连接超时，已保留本机用量。' : '额度服务暂不可用，已保留本机用量。',
        }
      }
      return normalizeCodexUsage(result.payload)
    } catch {
      return {
        status: 'unavailable', source: 'provider-experimental', windows: [], fetchedAt: new Date().toISOString(),
        message: '额度服务连接超时，已保留本机用量。',
      }
    }
  }

  async refreshNow() {
    const defaultRoute = this.defaultRoute()
    const provisionalRoute = this.snapshot.route?.provider && this.snapshot.route?.model ? this.snapshot.route : defaultRoute
    const [local, provisionalQuota] = await Promise.all([
      runSessionWorker(path.join(this.dshHome, 'sessions')),
      this.fetchCodexQuota(provisionalRoute),
    ])
    const route = local?.route?.provider && local?.route?.model ? local.route : defaultRoute
    const quota = (route.provider === provisionalRoute.provider ? provisionalQuota : await this.fetchCodexQuota(route)) || {
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
      localUsage: local?.localUsage,
      updatedAt: new Date().toISOString(),
    }, defaultRoute)
    this.snapshot = next
    try { atomicWriteJson(this.snapshotFile, next) } catch {}
    this.emit('updated', next)
    return next
  }

  startWatching() {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(path.join(this.dshHome, 'sessions'), { recursive: true }, (_event, filename) => {
        if (!filename || !/session\.jsonl(?:\.zstd)?$/i.test(String(filename))) return
        clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => this.scheduleRefresh({ force: true }).catch(() => {}), 1_500)
      })
      this.watcher.on('error', () => this.stopWatching())
    } catch {}
  }

  stopWatching() {
    clearTimeout(this.watchTimer)
    this.watchTimer = null
    try { this.watcher?.close() } catch {}
    this.watcher = null
  }
}

module.exports = {
  ModelResourceService,
  REFRESH_TTL_MS,
  runSessionWorker,
}
