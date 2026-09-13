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
import fs from 'node:fs'
import os from 'node:os'

if (!process.argv[2]) {
  console.error('usage: node test-runtime.mjs <runtimeRoot>')
  process.exit(2)
}
const root = path.resolve(process.argv[2])
const binJs = path.join(root, 'lib', 'bin.js')
const nodeExe = process.execPath
const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-smoke-'))
process.on('exit', () => fs.rmSync(smokeHome, { recursive: true, force: true }))

function run(args, { timeoutMs = 60000, waitForPort = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, [binJs, ...args], {
      cwd: root,
      env: { ...process.env, DSH_HOME: smokeHome },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    let timeout
    let probing = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      resolve({ code, signal, out })
    }
    child.stdout.on('data', (c) => {
      out += String(c)
      if (waitForPort) {
        const m = out.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
        if (m && !probing) {
          probing = true
          pollHttp(new URL(m[1]), 30000).then(
            () => { child.kill(); finish(0, 'smoke-ok') },
            (err) => { child.kill(); finish(1, `http-fail: ${err}`) },
          )
        }
      }
    })
    child.stderr.on('data', (c) => { out += String(c) })
    child.on('error', (error) => finish(1, `spawn-fail: ${error.message}`))
    child.on('exit', (code, signal) => finish(code, signal))
    timeout = setTimeout(() => {
      if (!settled) {
        try { child.kill() } catch {}
        finish(1, `timeout: ${out.slice(-2000)}`)
      }
    }, timeoutMs)
  })
}

function pollHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const origin = url.origin
  const cookies = new Map()
  let redirects = 0
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, { timeout: 3000, headers: { Cookie: [...cookies.values()].join('; ') } }, (res) => {
        for (const cookie of res.headers['set-cookie'] || []) {
          const pair = cookie.split(';', 1)[0]
          cookies.set(pair.split('=', 1)[0], pair)
        }
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          if (!res.headers.location || ++redirects > 5) return reject('invalid or excessive authentication redirects')
          const next = new URL(res.headers.location, url)
          if (next.origin !== origin) return reject('refusing cross-origin authentication redirect')
          url = next
          return probe()
        }
        if (res.statusCode !== 200) { res.resume(); return reject(`unexpected HTTP ${res.statusCode}`) }
        if (!String(res.headers['content-type']).includes('text/html')) { res.resume(); return reject('frontend did not return HTML') }
        let html = ''
        res.on('data', chunk => { html += String(chunk) })
        res.on('error', reject)
        res.on('end', () => /<script\b[^>]*src=/i.test(html) ? resolve(res.statusCode) : reject('frontend entry script is missing'))
      })
      req.on('timeout', () => req.destroy(new Error('HTTP request timed out')))
      req.on('error', () => {
        if (Date.now() > deadline) return reject('no response')
        setTimeout(probe, 250)
      })
    }
    probe()
  })
}

const redact = value => String(value).replace(/token=[^\s&]+/g, 'token=[redacted]')
console.log('== 1/2 dump-default-config ==')
const dump = await run(['web', '--dump-default-config'], { timeoutMs: 90000 })
if (dump.code !== 0 || !dump.out.includes('web-server') && !dump.out.includes('webserver')) {
  console.error(redact(`dump-config FAILED (code=${dump.code} signal=${dump.signal})\n${dump.out.slice(-3000)}`))
  process.exit(1)
}
console.log(`dump-config OK (${dump.out.split('\n').length} lines)`)

console.log('== 2/2 full web boot ==')
const boot = await run(['web', '--port', '0', '--no-open'], { timeoutMs: 120000, waitForPort: true })
if (boot.code !== 0) {
  console.error(redact(`web boot FAILED (code=${boot.code} signal=${boot.signal})\n${boot.out.slice(-3000)}`))
  process.exit(1)
}
console.log('web boot OK — server answered HTTP, frontend served')
console.log('RUNTIME SMOKE TEST PASSED')
