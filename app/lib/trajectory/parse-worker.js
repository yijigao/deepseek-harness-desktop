'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const { parseRun } = require('./parser')
try {
  parentPort.postMessage({ ok: true, run: parseRun(Buffer.from(workerData.contents), workerData.options) })
} catch (error) {
  parentPort.postMessage({ ok: false, error: { message: 'Session parsing failed', code: error.code } })
}
