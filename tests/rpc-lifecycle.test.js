const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { attachRpcLifecycleLogging } = require('../app/lib/rpc-lifecycle')

class FakeWebRequest extends EventEmitter {
  onBeforeRequest(listener) {
    if (listener === null) this.removeAllListeners('before-request')
    else this.on('before-request', listener)
  }
  onCompleted(listener) {
    if (listener === null) this.removeAllListeners('completed')
    else this.on('completed', listener)
  }
  onErrorOccurred(listener) {
    if (listener === null) this.removeAllListeners('error-occurred')
    else this.on('error-occurred', listener)
  }
}

function request(id, url, method = 'POST') {
  return { id, url, method }
}

function linesFor(logs, stage) {
  return logs.filter(line => line.includes(`stage=${stage}`))
}

test('tracks only current-engine model/session mutation endpoints without URL or body data', async () => {
  const webRequest = new FakeWebRequest()
  const logs = []
  let clock = 1000
  const lifecycle = attachRpcLifecycleLogging({
    webRequest,
    engineOrigin: 'http://127.0.0.1:59764/?token=secret-token',
    log: line => logs.push(line),
    now: () => clock,
  })

  const before = (details) => new Promise(resolve => {
    webRequest.emit('before-request', details, resolve)
  })
  await before(request(1, 'http://127.0.0.1:59764/api/session/selectModel?token=secret-token&sessionId=private-session'))
  assert.equal(lifecycle.pendingCount(), 1)
  assert.match(logs[0], /requestId=1 endpoint=session\/selectModel status=- durationMs=- netError=-/)
  assert.doesNotMatch(logs[0], /secret-token|private-session|api\/session\/selectModel\?/)

  clock = 1042
  webRequest.emit('completed', { id: 1, statusCode: 200 })
  assert.equal(lifecycle.pendingCount(), 0)
  assert.match(linesFor(logs, 'complete')[0], /requestId=1 endpoint=session\/selectModel status=200 durationMs=42 netError=-/)

  await before(request(2, 'http://127.0.0.1:59764/api/session/create?token=other'))
  assert.equal(lifecycle.pendingCount(), 1)
  clock = 1050
  webRequest.emit('error-occurred', { id: 2, error: 'net::ERR_CONNECTION_RESET' })
  assert.equal(lifecycle.pendingCount(), 0)
  assert.match(linesFor(logs, 'error')[0], /requestId=2 endpoint=session\/create status=- durationMs=8 netError=net::ERR_CONNECTION_RESET/)

  await before(request(4, 'http://127.0.0.1:59765/api/session/selectModel'))
  await before(request(5, 'http://127.0.0.1:59764/api/session/list'))
  await before(request(6, 'http://127.0.0.1:59764/api/session/create', 'GET'))
  assert.equal(lifecycle.pendingCount(), 0)
  lifecycle.dispose()
})

test('keeps pending diagnostics bounded and clears them on disposal', async () => {
  const webRequest = new FakeWebRequest()
  const logs = []
  const lifecycle = attachRpcLifecycleLogging({
    webRequest,
    engineOrigin: 'http://127.0.0.1:59764',
    log: line => logs.push(line),
    maxPending: 2,
  })

  const before = (details) => new Promise(resolve => {
    webRequest.emit('before-request', details, resolve)
  })
  await before(request(1, 'http://127.0.0.1:59764/api/session/create'))
  await before(request(2, 'http://127.0.0.1:59764/api/session/selectModel'))
  await before(request(3, 'http://127.0.0.1:59764/api/session/create'))
  assert.equal(lifecycle.pendingCount(), 2)
  assert.equal(linesFor(logs, 'start').length, 2)

  lifecycle.dispose()
  assert.equal(lifecycle.pendingCount(), 0)
  webRequest.emit('completed', { id: 1, statusCode: 200 })
  assert.equal(linesFor(logs, 'complete').length, 0)
  assert.equal(webRequest.listenerCount('before-request'), 0)
  assert.equal(webRequest.listenerCount('completed'), 0)
  assert.equal(webRequest.listenerCount('error-occurred'), 0)
})

test('always releases an Electron before-request callback when the logger throws', async () => {
  const webRequest = new FakeWebRequest()
  const lifecycle = attachRpcLifecycleLogging({
    webRequest,
    engineOrigin: 'http://127.0.0.1:59764',
    log: () => { throw new Error('diagnostic sink unavailable') },
  })
  let callbackCount = 0
  let callbackResponse
  webRequest.emit(
    'before-request',
    request(1, 'http://127.0.0.1:59764/api/session/selectModel'),
    response => { callbackCount += 1; callbackResponse = response },
  )
  assert.equal(callbackCount, 1)
  assert.deepEqual(callbackResponse, {})
  assert.equal(lifecycle.pendingCount(), 1)
  lifecycle.dispose()
})
