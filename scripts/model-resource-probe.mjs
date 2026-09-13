/**
 * ChatGPT/Codex quota probe. Expiring canonical grants refresh through the
 * Harness credential writer lock. Secrets never enter the normalized output.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const runtimeRoot = path.resolve(process.argv[2] || '')
const dshHome = path.resolve(process.argv[3] || process.env.DSH_HOME || '')
if (!runtimeRoot || !dshHome) process.exit(2)

const apiCredentialPath = path.join(dshHome, '.credentials.yaml')

/** Prefer the Harness account record; refresh it under the shared writer lock. */
export async function loadCodexCredential(runtime, home, refreshGrant) {
  const localFile = path.join(home, '.credentials.yaml')
  const providerFile = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js')
  const refresh = refreshGrant || (async grant => {
    const oauthModule = path.join(runtime, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'auth', 'oauth', 'openai-codex.js')
    const { openaiCodexOAuth } = await import(pathToFileURL(oauthModule).href)
    return openaiCodexOAuth.refresh(grant)
  })
  const needsRefresh = grant => Number(grant?.expires) <= Date.now() + 60_000 && typeof grant?.refresh === 'string'
  if (fs.existsSync(localFile) && fs.existsSync(providerFile)) {
    const { Context } = await import(pathToFileURL(path.join(runtime, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
    const { default: Provider } = await import(pathToFileURL(providerFile).href)
    const ctx = new Context()
    try {
      await ctx.plugin(Provider, { path: localFile, watch: false })
      const key = 'llm-pi-ai/openai-codex'
      let record = await ctx.credentials.readRecord(key)
      if (record !== undefined) {
        // A configured canonical record owns this account; never fall back to
        // a stale legacy account when its grant is missing or invalid.
        if (record.kind !== 'grant') return undefined
        if (needsRefresh(record.payload)) {
          record = await ctx.credentials.modifyRecord(key, async current => {
            if (current?.kind !== 'grant' || !needsRefresh(current.payload)) return undefined
            return { ...current, payload: await refresh(current.payload) }
          })
        }
        return record?.kind === 'grant' ? record.payload : undefined
      }
    } finally { await ctx.fiber.dispose() }
  }
  const legacyFile = path.join(home, 'oauth-credentials.json')
  if (!fs.existsSync(legacyFile)) return undefined
  const document = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
  let grant = document['openai-codex']
  if (needsRefresh(grant)) {
    grant = await refresh(grant)
    document['openai-codex'] = grant
    atomicWrite(legacyFile, document)
  }
  return grant
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

function readRef(name) {
  const fromEnvironment = process.env[name]
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim()) return fromEnvironment.trim()
  try {
    const lines = fs.readFileSync(apiCredentialPath, 'utf8').split(/\r?\n/)
    const refsIndex = lines.findIndex((line) => /^refs:\s*(?:#.*)?$/.test(line))
    if (refsIndex < 0) return null
    for (let index = refsIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) break
      const match = line.match(new RegExp(`^\\s{2}${name}:\\s*(.*?)\\s*$`))
      if (!match) continue
      const raw = match[1].replace(/\s+#.*$/, '').trim()
      if (!raw) return null
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1)
      return raw
    }
  } catch {}
  return null
}

async function probeDeepSeek() {
  const key = readRef('DEEPSEEK_API_KEY')
  if (!key) return { ok: false, code: 'NOT_CONFIGURED' }
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'DeepSeek-Harness-Desktop' },
      signal: AbortSignal.timeout(7_000),
    })
    if (!response.ok) return { ok: false, code: response.status === 401 ? 'INVALID_CREDENTIAL' : 'HTTP_ERROR', status: response.status }
    const payload = await response.json()
    return { ok: true, payload: { is_available: payload?.is_available, balance_infos: payload?.balance_infos } }
  } catch (error) {
    return { ok: false, code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'PROBE_FAILED' }
  }
}

async function probeCodex() {
  try {
    const credential = await loadCodexCredential(runtimeRoot, dshHome)
    if (!credential || typeof credential.access !== 'string' || typeof credential.accountId !== 'string') return { ok: false, code: 'NOT_LOGGED_IN' }

    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': credential.accountId, 'User-Agent': 'DeepSeek-Harness-Desktop' },
      signal: AbortSignal.timeout(7_000),
    })
    if (!response.ok) return { ok: false, code: response.status === 401 ? 'LOGIN_EXPIRED' : 'HTTP_ERROR', status: response.status }
    const payload = await response.json()
    return { ok: true, payload: { plan_type: payload?.plan_type ?? null, rate_limit: payload?.rate_limit ?? null, credits: payload?.credits ?? null } }
  } catch (error) {
    const message = String(error?.message || '')
    return { ok: false, code: error?.name === 'TimeoutError' ? 'TIMEOUT' : /refresh token|token refresh failed|refresh_token_reused|\(401\)/i.test(message) ? 'LOGIN_EXPIRED' : 'PROBE_FAILED' }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [codex, deepseek] = await Promise.all([probeCodex(), probeDeepSeek()])
  writeResult({ ok: true, codex, deepseek })
}
