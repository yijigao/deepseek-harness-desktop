import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const runtime = path.resolve('dist-validation-alpha2-desktop/win-unpacked/resources/runtime')
const sourceHome = 'C:/Users/yi/.dsh'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-alpha2-profile-'))
const require = createRequire(path.join(runtime, 'package.json'))
const yaml = require('yaml')
fs.copyFileSync(path.join(sourceHome, 'settings.yaml'), path.join(home, 'settings.yaml'))
for (const group of ['profiles', '.agent-presets']) {
  for (const entry of fs.readdirSync(path.join(sourceHome, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const src = path.join(sourceHome, group, entry.name)
    const dst = path.join(home, group, entry.name)
    fs.mkdirSync(dst, { recursive: true })
    for (const file of fs.readdirSync(src, { withFileTypes: true })) {
      if (file.isFile() && /(?:\.ya?ml|\.json)$/.test(file.name) && !/lock/.test(file.name)) fs.copyFileSync(path.join(src, file.name), path.join(dst, file.name))
    }
    if (fs.existsSync(path.join(src, 'node_modules'))) fs.symlinkSync(path.join(src, 'node_modules'), path.join(dst, 'node_modules'), 'junction')
  }
}
const redact = text => text.replace(/token=[^\s&]+/g, 'token=[redacted]')
const result = spawnSync(process.execPath, [path.join(runtime, 'lib/bin.js'), 'web', '--dump-config'], {
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 30000, windowsHide: true,
})
fs.writeFileSync(path.join(home, 'dump-private.yaml'), result.stdout || '', { mode: 0o600 })
console.log(JSON.stringify({ home, dumpExit: result.status, warnings: redact(result.stderr || '').slice(-2000) }))
const settings = yaml.parse(fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8'))
console.log(JSON.stringify({ defaultPreset: settings['agent-presets'], defaultModel: settings['agent-default-model'] }))
if (result.status !== 0) process.exitCode = 1
