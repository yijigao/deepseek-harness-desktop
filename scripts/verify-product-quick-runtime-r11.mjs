import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const [candidateArg, presetArg, evidenceArg] = process.argv.slice(2)
if (!candidateArg || !presetArg || !evidenceArg) {
  throw new Error('Usage: verify-product-quick-runtime-r11.mjs <candidate> <preset-directory> <evidence-json>')
}

const candidate = path.resolve(candidateArg)
const output = path.resolve(evidenceArg)
const version = JSON.parse(await readFile(path.join(candidate, 'resources', 'version.json'), 'utf8'))
if (version.desktopReleaseId !== 'desktop-2.2.0-alpha2-r11') {
  throw new Error(`Unexpected candidate release: ${String(version.desktopReleaseId)}`)
}

const scratch = await mkdtemp(path.join(tmpdir(), 'r11-product-quick-adapter-'))
const intermediate = path.join(scratch, 'receipt.json')
try {
  const base = spawnSync(process.execPath, [
    path.join(import.meta.dirname, 'verify-product-quick-runtime.mjs'),
    candidate,
    path.resolve(presetArg),
    intermediate,
  ], { stdio: 'inherit', windowsHide: true })
  if (base.error || base.status !== 0) throw new Error('Base product-quick verification failed')
  const receipt = JSON.parse(await readFile(intermediate, 'utf8'))
  if (receipt.releaseId !== 'desktop-2.2.0-alpha2-r10') {
    throw new Error('Base verifier identity changed; review the r11 adapter')
  }
  receipt.releaseId = version.desktopReleaseId
  receipt.baseVerifierReleaseIdentity = 'desktop-2.2.0-alpha2-r10'
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ ok: true, releaseId: receipt.releaseId, evidence: output, ...receipt.checks }))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
