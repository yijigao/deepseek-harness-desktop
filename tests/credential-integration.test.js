'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { nativeCredentialIntegration } = require('../app/lib/credential-integration')
test('native credential components do not require a retired OAuth patch', () => {
  const checked = []
  const result = nativeCredentialIntegration('fixture', name => { checked.push(name); return true })
  assert.equal(result.mode, 'native')
  assert.equal(result.ok, true)
  assert.equal(checked.length, 2)
  assert.match(result.detail, /账号有效性以资源查询结果为准/)
})
test('incomplete native components do not claim supported integration', () => {
  assert.equal(nativeCredentialIntegration('fixture', () => false), null)
  assert.equal(nativeCredentialIntegration('fixture', name => name.includes('dsh-llm-pi-ai')), null)
})
test('native check precedes legacy checker launch and missing checker is not an account failure', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8')
  const start = main.indexOf('function refreshPatchStatus()')
  const check = main.indexOf('nativeCredentialIntegration(resolveRuntimeRoot())', start)
  const launch = main.indexOf("spawn(nodeExePath(), [toolPath('patch-pi-ai-oauth.mjs')", start)
  assert.ok(check > start && check < launch)
  assert.match(main.slice(check, launch), /return Promise.resolve\(native\)/)
  assert.match(main.slice(check, launch), /ok: null/)
})
