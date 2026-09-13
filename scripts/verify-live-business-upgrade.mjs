// Local, read-only post-upgrade check: no prompt, session creation or model selection.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Supply the freshly observed Desktop loopback port')
const log = await fs.readFile(path.join(os.tmpdir(), 'deepseek-desktop.log'), 'utf8')
const matches = [...log.matchAll(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=([A-Za-z0-9_-]+)`, 'g'))]
if (!matches.length) throw Error('No authenticated launch URL for observed port')
const origin = `http://127.0.0.1:${port}`
const auth = await fetch(`${origin}/?token=${matches.at(-1)[1]}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
if (!cookie) throw Error('Local authentication did not return a session cookie')
const results = []
for (const [endpoint, args] of [['session/list', { _request: {} }], ['session/modelCatalog', {}]]) {
  const started = performance.now()
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  const body = await response.json()
  if (!response.ok || body?.result?.ok !== true) throw Error(`Read-only ${endpoint} failed: HTTP ${response.status}`)
  const value = body.result.value
  const summary = endpoint === 'session/list'
    ? { sessions: Array.isArray(value?.items) ? value.items.length : null }
    : { groups: value?.groups?.length ?? null, models: value?.groups?.reduce((n, g) => n + (g.models?.length ?? 0), 0) ?? null, failures: value?.failures?.length ?? null }
  results.push({ endpoint, status: response.status, ms: Math.round(performance.now() - started), ...summary })
}
console.log(JSON.stringify({ ok: true, port, mutations: 0, results }))
