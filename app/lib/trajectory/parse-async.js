'use strict'
const path = require('node:path')
const { Worker } = require('node:worker_threads')

function parseRunOffThread(contents, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'parse-worker.js'), {
      workerData: { contents, options },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    })
    let settled = false
    const finish = (error, run) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      if (error) reject(error)
      else resolve(run)
    }
    const timer = setTimeout(() => finish(new Error('Session parsing timed out')), 30_000)
    worker.once('message', (message) => {
      if (message.ok) finish(null, message.run)
      else finish(Object.assign(new Error(message.error.message), { code: message.error.code }))
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', () => finish(new Error('Session parser exited without a result')))
  })
}

module.exports = { parseRunOffThread }
