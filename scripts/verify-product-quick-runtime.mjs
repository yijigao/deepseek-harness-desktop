import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const [candidateArg, presetArg, evidenceArg] = process.argv.slice(2)
if (!candidateArg || !presetArg || !evidenceArg) {
  throw new Error('Usage: verify-product-quick-runtime.mjs <candidate> <preset-directory> <evidence-json>')
}

const candidate = path.resolve(candidateArg)
const presetSource = path.resolve(presetArg)
const evidencePath = path.resolve(evidenceArg)
const runtime = path.join(candidate, 'resources', 'runtime')
const nodeExe = path.join(candidate, 'resources', 'node.exe')
const bin = path.join(runtime, 'lib', 'bin.js')
const home = await mkdtemp(path.join(tmpdir(), 'r10-product-quick-'))
const workspace = path.join(home, 'workspace')
const userPreset = path.join(home, '.agent-presets', 'product-quick')
const output = []
let child

const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const redact = value => String(value).replace(/token=[^\s&]+/gu, 'token=[redacted]')

function isolatedEnvironment() {
  const keep = [
    'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT',
    'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR',
  ]
  const env = Object.fromEntries(keep.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    NO_PROXY: '127.0.0.1,localhost',
  }
}

function waitForLaunchUrl(timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`product-quick host did not become ready; output=${redact(output.join('')).slice(-2000)}`)), timeoutMs)
    const inspect = chunk => {
      output.push(String(chunk))
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/u.exec(output.join(''))
      if (!match) return
      clearTimeout(deadline)
      child.stdout.off('data', inspect)
      child.stderr.off('data', inspect)
      resolve(match[1])
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('exit', code => {
      clearTimeout(deadline)
      reject(new Error(`product-quick host exited before ready: ${code}; output=${redact(output.join('')).slice(-2000)}`))
    })
  })
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (response.status !== 303 || setCookie === null) {
    throw new Error(`product-quick host authentication returned HTTP ${response.status}`)
  }
  return { origin: new URL(launchUrl).origin, cookie: setCookie.split(';', 1)[0] }
}

async function remoteRpc(authenticated, endpoint, args) {
  const response = await fetch(`${authenticated.origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authenticated.cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `r10-product-quick-${endpoint}`,
      method: endpoint,
      payload: { args },
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}: ${redact(text).slice(-1000)}`)
  const body = JSON.parse(text)
  if (!body.result?.ok) {
    throw new Error(`${endpoint} failed: ${body.result?.error?.code ?? 'unknown'}: ${body.result?.error?.message ?? 'unknown'}`)
  }
  return body.result.value
}

async function stopChild() {
  if (!child || child.exitCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill()
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))])
  // Node leaves exitCode null when Windows reports a signal-owned exit; in
  // that case signalCode is the completion evidence.
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('product-quick host did not stop after isolated verification')
  }
}

let receipt
try {
  await mkdir(workspace, { recursive: true })
  await mkdir(path.dirname(userPreset), { recursive: true })
  await cp(presetSource, userPreset, { recursive: true, errorOnExist: true, force: false })
  child = spawn(nodeExe, [bin, 'web', '--port', '0', '--no-open'], {
    cwd: workspace,
    env: isolatedEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const launchUrl = await waitForLaunchUrl(120_000)
  const authenticated = await authenticate(launchUrl)
  const roster = await remoteRpc(authenticated, 'agentPresets/list', {})
  const preset = roster.presets?.find(row => row.id === 'product-quick')
  if (!preset || preset.trust !== 'user' || preset.broken !== undefined) {
    throw new Error(`product-quick was not discovered as a healthy user preset: ${JSON.stringify(preset)}`)
  }
  const created = await remoteRpc(authenticated, 'session/create', {
    request: { cwd: workspace, agentPreset: 'product-quick' },
  })
  if (!created?.sessionId || created.agentPreset !== 'product-quick') {
    throw new Error(`product-quick session did not report the mounted preset: ${JSON.stringify(created)}`)
  }
  receipt = {
    schema: 1,
    releaseId: 'desktop-2.2.0-alpha2-r10',
    candidate,
    presetSource,
    presetSha256: {
      'agent.cordis.yml': await sha256(path.join(presetSource, 'agent.cordis.yml')),
      'preset.yml': await sha256(path.join(presetSource, 'preset.yml')),
    },
    isolation: {
      temporaryHome: true,
      temporaryWorkspace: true,
      inheritedCredentialVariables: false,
      telemetryDisabled: true,
      loopbackOnly: true,
      modelRequests: 0,
    },
    checks: {
      hostBooted: true,
      authenticatedRpc: true,
      rosterHealthy: true,
      rosterTrust: preset.trust,
      fullPresetMount: true,
      createdAgentPreset: created.agentPreset,
    },
    ok: true,
  }
} finally {
  await stopChild()
  await rm(home, { recursive: true, force: true })
}

await mkdir(path.dirname(evidencePath), { recursive: true })
await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({ ok: true, evidence: evidencePath, ...receipt.checks }))
