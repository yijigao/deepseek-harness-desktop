const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

const runtime = process.env.DSH_TEST_RUNTIME
test('canonical quota credentials use the shared lock and preserve legacy data', { skip: !runtime }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-credential-test-'))
  const yaml = createRequire(path.join(path.resolve(runtime), 'package.json'))('yaml')
  const file = path.join(root, '.credentials.yaml')
  const legacy = path.join(root, 'oauth-credentials.json')
  const { loadCodexCredential } = await import('../scripts/model-resource-probe.mjs')
  const grant = { type: 'oauth', access: 'canonical-fixture', refresh: 'refresh-fixture', accountId: 'account-fixture', expires: Date.now() + 3600000 }
  const write = value => fs.writeFileSync(file, yaml.stringify({ version: 1, refs: { TEST: 'preserved' }, records: { 'llm-pi-ai/openai-codex': value } }))
  fs.writeFileSync(legacy, JSON.stringify({ 'openai-codex': { ...grant, access: 'legacy-fixture' } }))
  const legacyBefore = fs.readFileSync(legacy, 'utf8')
  try {
    write({ kind: 'grant', payload: grant })
    const before = fs.readFileSync(file, 'utf8')
    assert.equal((await loadCodexCredential(runtime, root)).access, 'canonical-fixture')
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    write({ kind: 'grant', payload: { ...grant, expires: 1 } })
    let refreshes = 0
    const refresh = async current => { refreshes++; return { ...current, access: 'renewed-fixture', expires: Date.now() + 3600000 } }
    const results = await Promise.all([loadCodexCredential(runtime, root, refresh), loadCodexCredential(runtime, root, refresh)])
    assert.equal(refreshes, 1)
    assert.deepEqual(results.map(value => value.access), ['renewed-fixture', 'renewed-fixture'])
    assert.equal(yaml.parse(fs.readFileSync(file, 'utf8')).refs.TEST, 'preserved')
    assert.equal(fs.readFileSync(legacy, 'utf8'), legacyBefore)
    write({ kind: 'api-key', key: 'not-an-oauth-account' })
    assert.equal(await loadCodexCredential(runtime, root), undefined)
    fs.unlinkSync(file)
    assert.equal((await loadCodexCredential(runtime, root)).access, 'legacy-fixture')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
