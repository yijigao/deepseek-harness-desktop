'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { normalizeCodexUsage, parseDefaultRoute, publicSnapshot } = require('../app/lib/model-resources/resource-utils')
const { runSessionWorker } = require('../app/lib/model-resources/service')

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
