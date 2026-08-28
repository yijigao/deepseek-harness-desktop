/**
 * Read-only ChatGPT/Codex quota probe. Credentials remain in this short-lived
 * process; stdout contains only the normalized provider payload or an error.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const runtimeRoot = path.resolve(process.argv[2] || '')
const dshHome = path.resolve(process.argv[3] || process.env.DSH_HOME || '')
if (!runtimeRoot || !dshHome) process.exit(2)

const credentialPath = path.join(dshHome, 'oauth-credentials.json')

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

try {
  const document = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
  let credential = document['openai-codex']
  if (!credential || typeof credential.access !== 'string' || typeof credential.accountId !== 'string') {
    writeResult({ ok: false, code: 'NOT_LOGGED_IN' })
    process.exit(0)
  }

  if (Number(credential.expires) <= Date.now() + 60_000 && typeof credential.refresh === 'string') {
    const oauthModule = path.join(runtimeRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'auth', 'oauth', 'openai-codex.js')
    const { openaiCodexOAuth } = await import(pathToFileURL(oauthModule).href)
    credential = await openaiCodexOAuth.refresh(credential)
    document['openai-codex'] = credential
    atomicWrite(credentialPath, document)
  }

  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      Authorization: `Bearer ${credential.access}`,
      'chatgpt-account-id': credential.accountId,
      'User-Agent': 'DeepSeek-Harness-Desktop',
    },
    signal: AbortSignal.timeout(7_000),
  })
  if (!response.ok) {
    writeResult({ ok: false, code: response.status === 401 ? 'LOGIN_EXPIRED' : 'HTTP_ERROR', status: response.status })
    process.exit(0)
  }
  const payload = await response.json()
  writeResult({
    ok: true,
    payload: {
      plan_type: payload?.plan_type ?? null,
      rate_limit: payload?.rate_limit ?? null,
      credits: payload?.credits ?? null,
    },
  })
} catch (error) {
  const message = String(error?.message || '')
  writeResult({
    ok: false,
    code: error?.name === 'TimeoutError'
      ? 'TIMEOUT'
      : /refresh token|token refresh failed|refresh_token_reused|\(401\)/i.test(message) ? 'LOGIN_EXPIRED' : 'PROBE_FAILED',
  })
}
