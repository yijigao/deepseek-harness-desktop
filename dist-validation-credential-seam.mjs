import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const runtime = path.resolve('dist-validation-alpha2-flat')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-credential-fixture-'))
const file = path.join(root, '.credentials.yaml')
await fs.writeFile(file, 'version: 1\nrefs: {}\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n      type: oauth\n      access: fixture\n      expires: 1\n')
const { Context } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/cordis/lib/index.js')))
const { default: Provider } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js')))
const ctx = new Context()
try {
  await ctx.plugin(Provider, { path: file, watch: false })
  const initial = await ctx.credentials.readRecord('llm-pi-ai/openai-codex')
  await ctx.credentials.modifyRecord('llm-pi-ai/openai-codex', old => ({ ...old, payload: { ...old.payload, expires: 2 } }))
  console.log(JSON.stringify({ read: initial?.payload?.access === 'fixture', write: (await ctx.credentials.readRecord('llm-pi-ai/openai-codex')).payload.expires === 2 }))
} finally { await ctx.dispose() }
