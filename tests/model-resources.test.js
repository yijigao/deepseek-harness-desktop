'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { normalizeCodexUsage, normalizeDeepSeekBalance, parseDefaultRoute, publicSnapshot } = require('../app/lib/model-resources/resource-utils')
const { runSessionWorker } = require('../app/lib/model-resources/service')
const { ModelResourceService } = require('../app/lib/model-resources/service')

test('session events do not force repeated provider probes; manual refresh can', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provider-ttl-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const service = new ModelResourceService({ dshHome: root, probeProviderResources: async () => { calls++; return {} } })
  await service.scheduleRefresh({ force: true })
  await service.scheduleRefresh({ force: true, localOnly: true })
  assert.equal(calls, 1)
  await service.scheduleRefresh({ force: true })
  assert.equal(calls, 2)
})

test('cross-day usage uses event time and unchanged histories use summary cache', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-dates-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'session')
  fs.mkdirSync(dir)
  const now = Date.now()
  const yesterday = now - 86400000
  const file = path.join(dir, 'session.jsonl')
  const rows = [
    { type: 'session', version: 0, id: 'dates', createdAt: yesterday },
    { type: 'assistant/message', seq: 1, time: yesterday, data: { usage: { inputTokens: 20, outputTokens: 5 } } },
    { type: 'assistant/message', seq: 2, time: now, data: { usage: { inputTokens: 100, outputTokens: 10 } } },
  ]
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'))
  const cache = path.join(root, 'summaries.json')
  const first = await runSessionWorker(root, undefined, cache)
  assert.equal(first.localUsage.today.totalTokens, 110)
  const second = await runSessionWorker(root, undefined, cache)
  assert.equal(second.localUsage.cachedSessions, 1)
  assert.equal(second.localUsage.today.totalTokens, 110)
  rows.push({ type: 'assistant/message', seq: 3, time: now, data: { usage: { inputTokens: 7, outputTokens: 3 } } })
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'))
  const third = await runSessionWorker(root, undefined, cache)
  assert.equal(third.localUsage.cachedSessions, 0)
  assert.equal(third.localUsage.today.totalTokens, 120)
})

test('unsupported session versions are reported as incomplete rather than zero-cost success', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-version-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'session.jsonl'), JSON.stringify({ type: 'session', version: 2 }))
  const result = await runSessionWorker(root)
  assert.equal(result.localUsage.incomplete, true)
  assert.equal(result.localUsage.skippedSessions, 1)
})

test('v2 selects only the highest generation and accounts for failed attempts without duplicate usage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-v2-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const now = Date.now()
  const rows = [
    { type: 'session', version: 2, id: 'v2' },
    { type: 'assistant/attempt', seq: 0, time: now, data: { turn: 1, step: 1,
      stream: [{ type: 'chunk', time: now, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } } }] } },
    { type: 'assistant/message', seq: 1, time: now, data: { turn: 1, step: 1,
      usage: { inputTokens: 10, outputTokens: 3 },
      stream: [{ type: 'chunk', time: now, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } } }] } },
    { type: 'assistant/message', seq: 2, time: now, data: { turn: 1, step: 2,
      usage: { inputTokens: 2, outputTokens: 1 }, stream: [] } },
  ]
  fs.writeFileSync(path.join(root, 'session.v2.jsonl'), rows.map(JSON.stringify).join('\n'))
  fs.writeFileSync(path.join(root, 'session.jsonl'), JSON.stringify({ type: 'session', version: 0 }))
  const result = await runSessionWorker(root)
  assert.equal(result.localUsage.scannedSessions, 1)
  assert.equal(result.localUsage.today.totalTokens, 23)
  assert.equal(result.localUsage.incomplete, false)
  fs.writeFileSync(path.join(root, 'session.v3.jsonl'), JSON.stringify({ type: 'session', version: 3 }))
  const future = await runSessionWorker(root)
  assert.equal(future.localUsage.scannedSessions, 0)
  assert.equal(future.localUsage.incomplete, true)
})

test('incomplete background accounting schedules a bounded retry and shutdown cancels it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-retry-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'sessions'))
  fs.writeFileSync(path.join(root, 'sessions', 'session.jsonl'), JSON.stringify({ type: 'session', version: 2 }))
  const service = new ModelResourceService({ dshHome: root })
  t.after(() => service.stopWatching())
  await service.scheduleRefresh({ force: true })
  assert.equal(service.getCachedSnapshot().localUsage.incomplete, true)
  assert.ok(service.retryTimer)
  service.stopWatching()
  assert.equal(service.retryTimer, null)
})

test('usage covers more than forty sessions and files larger than eight MiB', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-coverage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (let i = 0; i < 42; i++) {
    const dir = path.join(root, String(i))
    fs.mkdirSync(dir)
    const rows = [JSON.stringify({ type: 'session', version: 0, id: `synthetic-${i}` }),
      JSON.stringify({ type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 1, outputTokens: 1 } } })]
    if (i === 0) rows.push(JSON.stringify({ type: 'tools/result', data: { text: 'x'.repeat(9 * 1024 * 1024) } }))
    fs.writeFileSync(path.join(dir, 'session.jsonl'), rows.join('\n'))
  }
  const result = await runSessionWorker(root)
  assert.equal(result.localUsage.scannedSessions, 42)
  assert.equal(result.localUsage.today.totalTokens, 84)
  assert.equal(result.localUsage.incomplete, false)
})

test('default route parser reads only the agent default model block', () => {
  assert.deepEqual(parseDefaultRoute(`
agent-default-model:
  provider: openai-codex
  model: gpt-5.6-sol
permission:
  provider: ignored
  model: ignored
`), { provider: 'openai-codex', model: 'gpt-5.6-sol', source: 'default-settings' })
})

test('Codex quota payload keeps multiple windows, credits, and reset times', () => {
  const quota = normalizeCodexUsage({
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 64, reset_at: 1_800_000_000, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 22, reset_after_seconds: 86_400, limit_window_seconds: 604_800 },
    },
    credits: { has_credits: true, unlimited: false, balance: 123.5 },
  }, '2026-08-28T00:00:00.000Z')
  assert.equal(quota.status, 'available')
  assert.equal(quota.windows.length, 2)
  assert.equal(quota.windows[0].label, '5 小时额度')
  assert.equal(quota.windows[0].remainingPercent, 36)
  assert.equal(quota.windows[1].label, '每周额度')
  assert.equal(quota.credits.balance, 123.5)
})

test('public resource snapshot excludes credentials and filesystem paths', () => {
  const snapshot = publicSnapshot({
    route: { provider: 'openai-codex', model: 'gpt-5.6-sol', source: 'active-session' },
    account: { connected: true, kind: 'chatgpt-subscription' },
    quota: { status: 'unavailable', source: 'provider-experimental', windows: [], message: 'offline' },
    access: 'secret-token',
    accountId: 'private-account',
    credentialPath: 'C:\\private\\oauth.json',
  })
  const serialized = JSON.stringify(snapshot)
  assert.doesNotMatch(serialized, /secret-token|private-account|oauth\.json|C:\\/)
  assert.equal(snapshot.route.model, 'gpt-5.6-sol')
})

test('DeepSeek balance preserves currency breakdown without credentials', () => {
  const resource = normalizeDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '18.25', granted_balance: '3.25', topped_up_balance: '15.00' }],
  }, '2026-09-03T00:00:00.000Z')
  assert.equal(resource.status, 'available')
  assert.deepEqual(resource.balances[0], { currency: 'CNY', total: 18.25, granted: 3.25, toppedUp: 15 })
  const snapshot = publicSnapshot({ resources: [{ ...resource, unsafeField: 'secret-value', credentialPath: 'C:\\private' }] })
  assert.equal(snapshot.resources[0].balances[0].total, 18.25)
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-value|private/)
})

test('session usage aggregation runs in a worker and reports local token totals', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-resources-'))
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))
  const sessionDirectory = path.join(temporaryRoot, 'project', 'session-synthetic')
  fs.mkdirSync(sessionDirectory, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(sessionDirectory, 'session.jsonl'), [
    JSON.stringify({ type: 'session', version: 0, id: 'synthetic-resource-session', createdAt: now, cwd: 'C:\\synthetic\\resource-test' }),
    JSON.stringify({ type: 'request/header', seq: 0, time: now + 10, data: { header: { config: { provider: 'openai-codex', model: 'gpt-5.6-sol' } } } }),
    JSON.stringify({ type: 'assistant/message', seq: 1, time: now + 20, data: { message: { role: 'assistant', content: 'Synthetic.', source: { provider: 'openai-codex', model: 'gpt-5.6-sol' } }, usage: { inputTokens: 120, outputTokens: 30 } } }),
  ].join('\n'))
  const result = await runSessionWorker(temporaryRoot, 5)
  assert.equal(result.localUsage.scannedSessions, 1)
  assert.equal(result.route.model, 'gpt-5.6-sol')
  assert.equal(result.localUsage.today.totalTokens, 150)
  assert.equal(result.localUsage.month.totalTokens, 150)
  assert.equal(result.localUsage.currentSession.totalTokens, 150)
})
