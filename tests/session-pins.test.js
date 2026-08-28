const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const projectRoot = path.resolve(__dirname, '..')

test('pin ordering keeps the active blank first and preserves stable order', async () => {
  const module = await import(pathToFileURL(path.join(projectRoot, 'scripts', 'patch-session-pins.mjs')).href)
  const rows = [
    { id: 'blank', blank: true },
    { id: 'recent' },
    { id: 'pinned-a' },
    { id: 'older' },
    { id: 'pinned-b' },
  ]
  const result = module.pinFirstRows(rows, ['pinned-b', 'pinned-a'])
  assert.deepEqual(result.map((row) => row.id), ['blank', 'pinned-a', 'pinned-b', 'recent', 'older'])
  assert.equal(module.pinFirstRows(rows, []), rows)
  assert.equal(module.MAX_PINNED_SESSIONS, 50)
})

test('session pin implementation has no polling, observer, scan, or subprocess path', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'patch-session-pins.mjs'), 'utf8')
  for (const forbidden of ['new MutationObserver', 'setInterval(', 'setTimeout(', 'spawn(', 'exec(', 'readdir(', 'watch(']) {
    assert.equal(source.includes(forbidden), false, `unexpected hot-path primitive: ${forbidden}`)
  }
  assert.match(source, /pinnedSessionIds/)
  assert.match(source, /pinFirstRows/)
  assert.match(source, /slice\(0, 50\)/)
  assert.match(source, /getPinnedSessions/)
  assert.match(source, /setPinnedSessions/)
  assert.match(source, /DSH_DESKTOP_SESSION_PINS_PERSISTENCE/)
})

test('pin ordering stays below the 5 ms budget for 2000 visible sessions', async () => {
  const module = await import(pathToFileURL(path.join(projectRoot, 'scripts', 'patch-session-pins.mjs')).href)
  const rows = Array.from({ length: 2000 }, (_, index) => ({ id: `session-${index}`, blank: index === 0 }))
  const pins = rows.slice(1000, 1050).map((row) => row.id)
  for (let index = 0; index < 20; index += 1) module.pinFirstRows(rows, pins)
  const started = performance.now()
  const ordered = module.pinFirstRows(rows, pins)
  const elapsed = performance.now() - started
  assert.equal(ordered.length, rows.length)
  assert.ok(elapsed < 5, `2000-row pin ordering took ${elapsed.toFixed(3)} ms`)
})

test('session pin patch is idempotent against the staged upstream client when present', async (t) => {
  const staged = path.join(projectRoot, 'staging', 'payload', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js')
  if (!fs.existsSync(staged)) return t.skip('staged upstream runtime is not available')
  const module = await import(pathToFileURL(path.join(projectRoot, 'scripts', 'patch-session-pins.mjs')).href)
  const original = fs.readFileSync(staged, 'utf8')
  const once = module.patchWorkspaceClient(original)
  const twice = module.patchWorkspaceClient(once.source)
  assert.equal(once.changed || original.includes('DSH_DESKTOP_SESSION_PINS_START'), true)
  assert.equal(twice.changed, false)
  assert.equal(twice.source, once.source)
})
