import path from 'node:path'
import { spawnSync } from 'node:child_process'
const runtime = process.argv[2]
if (!runtime) throw Error('Usage: qualify-runtime.mjs <prepared-runtime>')
for (const [script, ...extra] of [['verify-clipboard-integration.mjs'], ['patch-session-pins.mjs', '--check'], ['test-runtime.mjs']]) {
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, script), path.resolve(runtime), ...extra], { stdio: 'inherit', windowsHide: true, timeout: 120000 })
  if (result.error || result.status !== 0) throw Error(`Runtime qualification failed: ${script}`)
}
