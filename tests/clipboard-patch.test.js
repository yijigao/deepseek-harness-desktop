'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('clipboard bundle patch prefers the desktop bridge and keeps fallbacks', async () => {
  const module = await import('../scripts/patch-clipboard.mjs')
  const source = 'async function y1(n){var u;if((u=navigator.clipboard)!=null&&u.writeText)try{return await navigator.clipboard.writeText(n),!0}catch{return!1}const i=typeof document.execCommand==="function"?document.execCommand.bind(document):void 0;}function tf(){}'
  const result = module.patchClipboardBundle(source)
  assert.equal(result.changed, true)
  assert.match(result.source, /window\.ccDesktop\?\.writeClipboard/)
  assert.match(result.source, /catch\{\}const i=/)
  assert.equal(module.patchClipboardBundle(result.source).changed, false)
})

test('staged frontend contains native clipboard patch', () => {
  const file = path.join(__dirname, '..', 'staging', 'payload', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'index-qqF29hai.js')
  if (!fs.existsSync(file)) return
  const source = fs.readFileSync(file, 'utf8')
  assert.match(source, /DSH_DESKTOP_NATIVE_CLIPBOARD/)
  assert.match(source, /window\.ccDesktop\?\.writeClipboard/)
})

test('desktop clipboard bridge is trusted and bounded', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8')
  assert.match(main, /ipcMain\.handle\('cc:write-clipboard'/)
  assert.match(main, /isTrustedSender\(event, mainWindow\)/)
  assert.match(main, /typeof value !== 'string' \|\| value\.length > 2 \* 1024 \* 1024/)
  assert.match(preload, /writeClipboard: \(text\) => ipcRenderer\.invoke\('cc:write-clipboard', text\)/)
})

test('runtime builds verify source integration instead of patching generated bundles', () => {
  const sync = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sync-update.ps1'), 'utf8')
  assert.match(sync, /verify-clipboard-integration\.mjs/)
  assert.doesNotMatch(sync, /& \$node .*patch-clipboard\.mjs/)
})
