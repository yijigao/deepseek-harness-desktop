import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const recovery = require('./lib/install-workspace-recovery.cjs')

function usage() {
  throw new Error('Usage: recover-install-workspace.mjs plan --spec FILE --out FILE | snapshot --plan FILE --expected-plan-sha256 HASH | execute --plan FILE --expected-plan-sha256 HASH')
}

function value(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), 'utf8'))
}

async function writePlan(file, bundle) {
  const target = path.resolve(file)
  const bytes = Buffer.from(JSON.stringify(bundle, null, 2) + '\n', 'utf8')
  try {
    const handle = await fs.open(target, 'wx')
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await fs.readFile(target)
    if (!existing.equals(bytes)) throw new Error(`Refusing to overwrite a different recovery plan: ${target}`)
  }
  return target
}

const [command, ...args] = process.argv.slice(2)
try {
  let result
  if (command === 'plan') {
    const specPath = value(args, '--spec')
    const outPath = value(args, '--out')
    if (!specPath || !outPath) usage()
    const bundle = await recovery.buildPlan(await readJson(specPath))
    const planPath = await writePlan(outPath, bundle)
    result = { status: 'planned', planPath, planSha256: bundle.planSha256, staticFileCount: bundle.plan.policy.staticFileCount, extraCount: bundle.plan.extras.length }
  } else if (command === 'snapshot' || command === 'execute') {
    const planPath = value(args, '--plan')
    const expected = value(args, '--expected-plan-sha256')
    if (!planPath || !expected) usage()
    const bundle = await readJson(planPath)
    if (bundle?.planSha256 !== expected) throw new Error('Plan file summary does not match the supplied trusted digest')
    result = command === 'snapshot'
      ? await recovery.snapshot(bundle.plan, expected)
      : await recovery.execute(bundle.plan, expected)
  } else usage()
  process.stdout.write(JSON.stringify(result) + '\n')
} catch (error) {
  const safe = { status: 'failed', code: error.code || 'INSTALL_RECOVERY_ERROR', message: error.message }
  if (Array.isArray(error.blockers)) safe.blockers = error.blockers.map(row => ({ pid: row.pid, name: row.name, reasons: row.reasons }))
  process.stderr.write(JSON.stringify(safe) + '\n')
  process.exitCode = 1
}
