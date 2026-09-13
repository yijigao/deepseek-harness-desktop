import path from 'node:path'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { run } = require('./lib/release-storage-maintenance.cjs')
const args = process.argv.slice(2)
function value(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = value('--mode', 'preview')
const approvedPlanPath = value('--approved-plan', '')
const writePlanPath = value('--write-plan', '')
if (writePlanPath && mode !== 'preview') throw Error('--write-plan is restricted to preview')
const approvedPlan = approvedPlanPath ? JSON.parse(await fs.readFile(path.resolve(approvedPlanPath), 'utf8')) : undefined
const result = await run({ mode, confirmExecute: args.includes('--confirm-execute'), keepBackups: Number(value('--keep-backups', '1')), includeTestTemps: args.includes('--include-test-temps'), programRoot: value('--program-root', path.join(process.env.LOCALAPPDATA || '', 'Programs')), desktopRoot: value('--desktop-root', repo), approvedPlan, auditPath: value('--audit-path', '') || undefined })
if (writePlanPath) await fs.writeFile(path.resolve(writePlanPath), JSON.stringify(result, null, 2), { flag: 'wx' })
console.log(JSON.stringify(result, null, 2))
