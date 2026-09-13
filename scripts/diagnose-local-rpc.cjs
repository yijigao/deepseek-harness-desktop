// Isolated renderer diagnostic. Never submits prompts or valid mutations.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rpc-diagnostic-')))
app.whenReady().then(async () => {
  const text = fs.readFileSync(path.join(os.tmpdir(), 'deepseek-desktop.log'), 'utf8')
  const urls = [...text.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/g)]
  const url = urls.at(-1)[0]
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  try {
    await win.loadURL(url)
    console.log('RPC_DIAG', JSON.stringify(await win.webContents.executeJavaScript(`(async () => {
      const start = performance.now();
      try {
        const res = await fetch('/api/session/selectModel', {method:'POST',headers:{'content-type':'application/json'}, body: JSON.stringify({type:'client-request',rpcId:'diagnostic-invalid-selection',method:'session/selectModel',payload:{}}),signal:AbortSignal.timeout(8000)});
        return {status:res.status,ms:Math.round(performance.now()-start),body:await res.text()};
      } catch(e) { return {error:e.message,ms:Math.round(performance.now()-start)} }
    })()`)))
  } finally { win.destroy(); app.quit() }
}).catch(e => { console.error(e.message); app.exit(1) })
setTimeout(() => app.exit(2), 30000).unref()
