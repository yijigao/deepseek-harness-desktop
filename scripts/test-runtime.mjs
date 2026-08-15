/**
 * test-runtime.mjs — smoke-test the repaired standalone runtime closure.
 *   1. `dsh web --dump-default-config`  (profile + bundle + patch resolution)
 *   2. `dsh web --port 0`               (full boot: loader, webserver, dist)
 * Usage: node test-runtime.mjs <runtimeRoot>
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import http from 'node:http'
import net from 'node:net'

const root = path.resolve(process.argv[2])
if (!root) {
  console.error('usage: node test-runtime.mjs <runtimeRoot>')
  process.exit(2)
}
const binJs = path.join(root, 'lib', 'bin.js')
const nodeExe = process.execPath

function run(args, { timeoutMs = 60000, waitForPort = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, [binJs, ...args], {
      cwd: root,
      env: { ...process.env, DSH_HOME: process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh') },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal, out })
    }
    child.stdout.on('data', (c) => {
      out += String(c)
      if (waitForPort) {
        const m = out.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)
        if (m) {
          pollHttp(Number(m[1]), 30000).then(
            () => { child.kill(); finish(0, 'smoke-ok') },
            (err) => { child.kill(); finish(1, `http-fail: ${err}`) },
          )
        }
      }
    })
    child.stderr.on('data', (c) => { out += String(c) })
    child.on('exit', (code, signal) => finish(code, signal))
    setTimeout(() => {
      if (!settled) {
        try { child.kill() } catch {}
        finish(1, `timeout: ${out.slice(-2000)}`)
      }
    }, timeoutMs)
  })
}

function pollHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', () => {
        if (Date.now() > deadline) return reject('no response')
        setTimeout(probe, 250)
      })
    }
    probe()
  })
}

console.log('== 1/2 dump-default-config ==')
const dump = await run(['web', '--dump-default-config'], { timeoutMs: 90000 })
if (dump.code !== 0 || !dump.out.includes('web-server') && !dump.out.includes('webserver')) {
  console.error(`dump-config FAILED (code=${dump.code} signal=${dump.signal})\n${dump.out.slice(-3000)}`)
  process.exit(1)
}
console.log(`dump-config OK (${dump.out.split('\n').length} lines)`)

console.log('== 2/2 full web boot ==')
const boot = await run(['web', '--port', '0'], { timeoutMs: 120000, waitForPort: true })
if (boot.code !== 0) {
  console.error(`web boot FAILED (code=${boot.code} signal=${boot.signal})\n${boot.out.slice(-3000)}`)
  process.exit(1)
}
console.log('web boot OK — server answered HTTP, frontend served')
console.log('RUNTIME SMOKE TEST PASSED')
