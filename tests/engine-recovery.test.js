'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { EngineRecovery } = require('../app/lib/engine-recovery')

test('offline engine stays idle until recovery is requested; requests are single-flight', async () => {
  let calls = 0
  let finish
  const states = []
  const recovery = new EngineRecovery({ publish: (value) => states.push(value.state),
    restart: () => { calls++; return new Promise((resolve) => { finish = resolve }) } })
  recovery.failed()
  assert.equal(calls, 0)
  const first = recovery.recover()
  assert.equal(recovery.recover(), first)
  await Promise.resolve()
  assert.equal(calls, 1)
  finish(true)
  assert.equal(await first, true)
  assert.deepEqual(states, ['offline', 'recovering', 'online'])
})

test('failed recovery permits an explicit retry without an automatic loop', async () => {
  let calls = 0
  const recovery = new EngineRecovery({ publish: () => {}, restart: () => {
    if (++calls === 1) throw new Error('startup failed')
    return true
  } })
  recovery.failed()
  assert.equal(await recovery.recover(), false)
  assert.equal(recovery.state, 'offline')
  assert.equal(calls, 1)
  assert.equal(await recovery.recover(), true)
})

test('closing prevents queued recovery from starting', async () => {
  let calls = 0
  const recovery = new EngineRecovery({ publish: () => {}, restart: () => { calls++ } })
  recovery.failed()
  const pending = recovery.recover()
  recovery.close()
  assert.equal(await pending, false)
  assert.equal(calls, 0)
})

test('a late startup completion cannot overwrite a newer engine failure', async () => {
  let finish
  const recovery = new EngineRecovery({ publish: () => {}, restart: () => new Promise((resolve) => { finish = resolve }) })
  recovery.failed()
  const pending = recovery.recover()
  await Promise.resolve()
  recovery.failed()
  finish(true)
  assert.equal(await pending, false)
  assert.equal(recovery.state, 'offline')
})
