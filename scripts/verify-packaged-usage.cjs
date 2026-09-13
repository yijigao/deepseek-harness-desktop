'use strict'
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-packaged-usage-'))
  try {
    fs.writeFileSync(path.join(root, 'session.jsonl'), [
      { type: 'session', version: 0, id: 'synthetic-packaged-usage', createdAt: Date.now() },
      { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 120, outputTokens: 30 } } },
    ].map(JSON.stringify).join('\n'))
    const { runSessionWorker } = require(path.join(path.resolve(process.argv[2]), 'resources', 'app.asar', 'lib', 'model-resources', 'service.js'))
    const sessions = process.argv[3] ? path.resolve(process.argv[3]) : root
    const summary = process.argv[4] ? path.resolve(process.argv[4]) : undefined
    const started = Date.now()
    let result
    if (process.argv.includes('--diagnose')) {
      const { Worker } = require('node:worker_threads')
      const target = path.join(path.resolve(process.argv[2]), 'resources', 'app.asar', 'lib', 'model-resources', 'session-usage-worker.js')
      result = await new Promise((resolve, reject) => {
        const worker = new Worker(target, { workerData: { sessionsRoot: sessions, summaryFile: summary }, stdout: true, stderr: true })
        worker.stdout.pipe(process.stdout)
        worker.stderr.pipe(process.stderr)
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Diagnostic worker exceeded 60 seconds')) }, 60_000)
        worker.once('message', (message) => { clearTimeout(timer); resolve(message.value) })
        worker.once('error', (error) => { clearTimeout(timer); reject(error) })
        worker.once('exit', () => clearTimeout(timer))
      })
    } else result = await runSessionWorker(sessions, undefined, summary)
    const ok = process.argv[3] ? Boolean(result && !result.localUsage.incomplete) : result?.localUsage?.today?.totalTokens === 150
    console.log(JSON.stringify({ ok, ms: Date.now() - started, scanned: result?.localUsage?.scannedSessions,
      cached: result?.localUsage?.cachedSessions, incomplete: result?.localUsage?.incomplete }))
    process.exitCode = ok ? 0 : 1
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
