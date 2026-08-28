'use strict'

const path = require('node:path')

const MAX_LABEL = 80

function safeText(value, fallback = null, maxLength = MAX_LABEL) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return fallback
  return trimmed.slice(0, maxLength)
}

function finiteNumber(value, fallback = null) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function clampPercent(value) {
  const numeric = finiteNumber(value)
  return numeric == null ? null : Math.min(100, Math.max(0, numeric))
}

function parseDefaultRoute(settingsText) {
  const lines = String(settingsText || '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^agent-default-model\s*:\s*(?:#.*)?$/.test(line))
  if (start < 0) return { provider: null, model: null, source: 'unavailable' }
  let provider = null
  let model = null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) break
    const providerMatch = line.match(/^\s+provider\s*:\s*([^#]+?)(?:\s+#.*)?$/)
    const modelMatch = line.match(/^\s+model\s*:\s*([^#]+?)(?:\s+#.*)?$/)
    if (providerMatch) provider = safeText(providerMatch[1])
    if (modelMatch) model = safeText(modelMatch[1])
  }
  return { provider, model, source: provider && model ? 'default-settings' : 'unavailable' }
}

function labelForWindow(window, index) {
  const seconds = finiteNumber(window?.limit_window_seconds ?? window?.window_seconds)
  if (seconds === 18_000) return '5 小时额度'
  if (seconds === 604_800) return '每周额度'
  if (seconds && seconds % 86_400 === 0) return `${seconds / 86_400} 天额度`
  if (seconds && seconds % 3_600 === 0) return `${seconds / 3_600} 小时额度`
  return index === 0 ? '短周期额度' : index === 1 ? '长周期额度' : `额度窗口 ${index + 1}`
}

function normalizeWindow(window, index) {
  if (!window || typeof window !== 'object') return null
  const usedPercent = clampPercent(window.used_percent ?? window.usedPercent)
  const resetAtSeconds = finiteNumber(window.reset_at ?? window.resetAt)
  const resetAfterSeconds = finiteNumber(window.reset_after_seconds ?? window.resetAfterSeconds)
  const windowSeconds = finiteNumber(window.limit_window_seconds ?? window.window_seconds)
  if (usedPercent == null && resetAtSeconds == null && resetAfterSeconds == null) return null
  return {
    id: index === 0 ? 'primary' : index === 1 ? 'secondary' : `window-${index + 1}`,
    label: labelForWindow(window, index),
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
    resetAt: resetAtSeconds == null ? null : new Date(resetAtSeconds * 1000).toISOString(),
    resetAfterSeconds,
    windowSeconds,
  }
}

function normalizeCodexUsage(payload, fetchedAt = new Date().toISOString()) {
  if (!payload || typeof payload !== 'object') return null
  const rateLimit = payload.rate_limit && typeof payload.rate_limit === 'object' ? payload.rate_limit : {}
  const rawWindows = [rateLimit.primary_window, rateLimit.secondary_window]
    .filter(Boolean)
  if (Array.isArray(rateLimit.windows)) rawWindows.push(...rateLimit.windows)
  const windows = rawWindows.map(normalizeWindow).filter(Boolean)
  const credits = payload.credits && typeof payload.credits === 'object' ? payload.credits : null
  const balance = finiteNumber(credits?.balance)
  return {
    status: windows.length || credits ? 'available' : 'unavailable',
    source: 'provider-experimental',
    plan: safeText(payload.plan_type ?? payload.planType, null, 40),
    windows,
    credits: credits ? {
      hasCredits: Boolean(credits.has_credits ?? credits.hasCredits),
      unlimited: Boolean(credits.unlimited),
      balance,
    } : null,
    fetchedAt,
    message: windows.length || credits ? null : '提供商没有返回可识别的额度字段。',
  }
}

function emptyUsageBucket() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function sanitizeLocalUsage(value) {
  const bucket = emptyUsageBucket()
  if (!value || typeof value !== 'object') return bucket
  for (const key of Object.keys(bucket)) bucket[key] = Math.max(0, finiteNumber(value[key], 0))
  return bucket
}

function publicSnapshot(value, fallbackRoute = {}) {
  const route = value?.route && typeof value.route === 'object' ? value.route : fallbackRoute
  const quota = value?.quota && typeof value.quota === 'object' ? value.quota : {}
  return {
    route: {
      provider: safeText(route.provider),
      model: safeText(route.model),
      source: ['active-session', 'default-settings'].includes(route.source) ? route.source : 'unavailable',
    },
    account: {
      connected: Boolean(value?.account?.connected),
      kind: safeText(value?.account?.kind, 'unknown', 40),
      plan: safeText(quota.plan ?? value?.account?.plan, null, 40),
    },
    quota: {
      status: ['available', 'refreshing', 'stale', 'unavailable'].includes(quota.status) ? quota.status : 'unavailable',
      source: safeText(quota.source, 'unavailable', 40),
      windows: Array.isArray(quota.windows) ? quota.windows.slice(0, 4).map((window, index) => normalizeWindow({
        usedPercent: window.usedPercent,
        resetAt: window.resetAt ? Date.parse(window.resetAt) / 1000 : null,
        resetAfterSeconds: window.resetAfterSeconds,
        window_seconds: window.windowSeconds,
      }, index)).filter(Boolean).map((window, index) => ({ ...window, label: safeText(quota.windows[index]?.label, window.label, 40) })) : [],
      credits: quota.credits ? {
        hasCredits: Boolean(quota.credits.hasCredits),
        unlimited: Boolean(quota.credits.unlimited),
        balance: finiteNumber(quota.credits.balance),
      } : null,
      fetchedAt: safeText(quota.fetchedAt, null, 40),
      message: safeText(quota.message, null, 160),
    },
    localUsage: {
      today: sanitizeLocalUsage(value?.localUsage?.today),
      month: sanitizeLocalUsage(value?.localUsage?.month),
      currentSession: sanitizeLocalUsage(value?.localUsage?.currentSession),
      scannedSessions: Math.max(0, finiteNumber(value?.localUsage?.scannedSessions, 0)),
      scope: 'this-device',
    },
    updatedAt: safeText(value?.updatedAt, null, 40),
  }
}

function cachePath(dshHome) {
  return path.join(dshHome, 'model-resource-cache.json')
}

module.exports = {
  cachePath,
  clampPercent,
  emptyUsageBucket,
  normalizeCodexUsage,
  parseDefaultRoute,
  publicSnapshot,
  safeText,
}
