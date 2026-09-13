'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../app/task-archive')

test('task archive renderer has a restrictive CSP and renders manifest content as text', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
  assert.match(html, /default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'/)
  assert.match(html, /img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'/)
  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML/)
  assert.match(renderer, /textContent/)
  assert.doesNotMatch(preload, /require\(['"]node:fs|\.openExternal\(|\.showOpenDialog\(/)
  assert.match(preload, /task-archive:accept/)
  assert.match(preload, /task-archive:list/)
})
