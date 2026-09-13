// Candidate-only r10 builder. It never reads or changes the active r9 descriptor.
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const root = __dirname
const base = require('./app/package.json').build
const evidence = path.join(root, 'release-artifacts', 'r10-final-source-evidence-20260913')
const baseline = require(path.join(evidence, 'baseline.json'))
const runtime = process.env.DSH_RELEASE_RUNTIME
const nodeExe = process.env.DSH_RELEASE_NODE
const output = path.join(root, 'release-artifacts', baseline.releaseId)
if (baseline.releaseId !== 'desktop-2.2.0-alpha2-r10') throw Error('Unexpected r10 release identity')
if (fs.existsSync(path.join(output, 'win-unpacked/desktop-release.json'))) throw Error('Release is already sealed; select a new releaseId instead of overwriting it')
if (!runtime || !nodeExe) throw Error('Set DSH_RELEASE_RUNTIME and DSH_RELEASE_NODE to verified build inputs')
if (!fs.existsSync(path.join(runtime, 'lib/bin.js')) || !fs.existsSync(nodeExe)) throw Error('Incomplete build inputs')
module.exports = {
  ...base,
  directories: { ...base.directories, output },
  beforePack: async () => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/qualify-runtime.mjs'), runtime], { stdio: 'inherit', windowsHide: true })
    if (result.error || result.status !== 0) throw Error('Runtime qualification failed before packaging')
  },
  extraResources: [
    { from: path.join(root, 'app/build/icon.ico'), to: 'icon.ico' },
    { from: path.join(root, 'app/build/icon-preview.png'), to: 'icon-preview.png' },
    { from: path.resolve(runtime), to: 'runtime' },
    { from: path.resolve(nodeExe), to: 'node.exe' },
    { from: path.join(evidence, 'version.json'), to: 'version.json' },
    { from: path.join(root, 'app/fix-junctions.js'), to: 'fix-junctions.js' },
    { from: path.join(root, 'scripts/sync-update.ps1'), to: 'sync-update.ps1' },
    { from: path.join(root, 'scripts/model-resource-probe.mjs'), to: 'tools/model-resource-probe.mjs' },
    { from: path.join(root, 'scripts/task-archive/cli.cjs'), to: 'tools/task-archive/cli.cjs' },
    { from: path.join(root, 'app/lib/task-archive/service.js'), to: 'tools/task-archive/lib/task-archive/service.js' },
    { from: path.join(root, 'config-example/oauth-login-openai-codex.mjs'), to: 'tools/oauth-login-openai-codex.mjs' },
    { from: path.join(root, 'config-example/test-openai-codex.mjs'), to: 'tools/test-openai-codex.mjs' },
  ],
  afterPack: async context => {
    const copied = spawnSync('robocopy.exe', [path.join(runtime, 'node_modules'), path.join(context.appOutDir, 'resources/runtime/node_modules'), '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS'], { windowsHide: true })
    if (copied.error || copied.status === null || copied.status >= 8) throw Error('Runtime dependency copy failed')
  },
}
