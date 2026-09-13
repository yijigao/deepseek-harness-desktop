const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { attachRpcLifecycleLogging } = require('../app/lib/rpc-lifecycle')

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function listen() {
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/api/session/selectModel')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>rpc lifecycle smoke</title>')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('smoke server did not bind')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function main() {
  const { server, origin } = await listen()
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rpc-lifecycle-smoke-')))
  let window
  let lifecycle
  try {
    await app.whenReady()
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const logs = []
    lifecycle = attachRpcLifecycleLogging({
      webRequest: window.webContents.session.webRequest,
      engineOrigin: `${origin}/?token=synthetic-token`,
      log: line => logs.push(line),
    })
    await window.loadURL(`${origin}/?token=synthetic-token`)
    const status = await window.webContents.executeJavaScript(
      "fetch('/api/session/selectModel?token=synthetic-token&sessionId=synthetic-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'synthetic-body' }).then(response => response.status)",
    )
    const deadline = Date.now() + 5_000
    while (logs.filter(line => line.includes('stage=complete')).length === 0 && Date.now() < deadline) {
      await delay(10)
    }
    const complete = logs.find(line => line.includes('stage=complete'))
    if (status !== 200 || complete === undefined) {
      throw new Error(`Electron lifecycle smoke did not observe completion: status=${String(status)}`)
    }
    lifecycle.dispose()
    const pendingAfterDispose = lifecycle.pendingCount()
    window.destroy()
    lifecycle = null
    console.log(JSON.stringify({ status, observed: logs.map(line => line.replace(/requestId=[^ ]+/u, 'requestId=<numeric>')), pendingAfterDispose }))
  } finally {
    lifecycle?.dispose()
    window?.destroy()
    await new Promise(resolve => server.close(resolve))
    app.quit()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  app.exit(1)
})
