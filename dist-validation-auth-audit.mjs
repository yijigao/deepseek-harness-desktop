import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('./dist-validation-alpha2-flat/package.json', import.meta.url))
const yaml = require('yaml')
const store = yaml.parse(fs.readFileSync('C:/Users/yi/.dsh/.credentials.yaml', 'utf8'))
const grant = store.records?.['llm-pi-ai/openai-codex']?.payload
async function check(name, url, headers) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    const data = response.ok ? await response.json() : null
    console.log(JSON.stringify({ name, status: response.status, ok: response.ok,
      expectedPayload: name === 'codex-canonical' ? !!data?.rate_limit : Array.isArray(data?.balance_infos) }))
  } catch (error) { console.log(JSON.stringify({ name, ok: false, error: error.name })) }
}
if (grant?.access && grant.expires > Date.now()) {
  await check('codex-canonical', 'https://chatgpt.com/backend-api/wham/usage', {
    Authorization: `Bearer ${grant.access}`, 'chatgpt-account-id': grant.accountId,
  })
} else console.log(JSON.stringify({ name: 'codex-canonical', ok: false, error: 'MissingOrExpired' }))
if (store.refs?.DEEPSEEK_API_KEY) await check('deepseek-balance', 'https://api.deepseek.com/user/balance', {
  Authorization: `Bearer ${store.refs.DEEPSEEK_API_KEY}`,
})
