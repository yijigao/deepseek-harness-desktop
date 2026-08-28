'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repositoryRoot = path.join(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
}

test('both Electron windows retain isolation, sandboxing, and disabled Node integration', () => {
  const main = read('app/main.js')
  assert.ok((main.match(/contextIsolation:\s*true/g) || []).length >= 2)
  assert.ok((main.match(/nodeIntegration:\s*false/g) || []).length >= 2)
  assert.ok((main.match(/sandbox:\s*true/g) || []).length >= 2)
  assert.doesNotMatch(main, /nodeIntegration:\s*true/)
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
  assert.match(main, /setPermissionRequestHandler/)
  assert.match(main, /event\.sender === win\.webContents/)
  assert.match(main, /cannot read compressed sessions in this runtime/)
})

test('Harness Lab preload exposes only the approved query and action methods', () => {
  const preload = read('app/harness-lab/preload.js')
  assert.match(preload, /listRuns:/)
  assert.match(preload, /getRun:/)
  assert.match(preload, /compareRuns:/)
  assert.doesNotMatch(preload, /require\(['"]node:(?:fs|path|child_process)/)
  assert.doesNotMatch(preload, /(?:exec|spawn|shell)\s*:/)
  const exposedMethods = [...preload.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((match) => match[1]).sort()
  assert.deepEqual(exposedMethods, ['compareRuns', 'copyOptimizationBrief', 'copyRunFix', 'exportReport', 'getRun', 'listRuns', 'openOriginal', 'setBaseline'])
})

test('Model Resources remains a sandboxed local control surface', () => {
  const main = read('app/main.js')
  const preload = read('app/model-settings/preload.js')
  const html = read('app/model-settings/index.html')
  const renderer = read('app/model-settings/renderer.js')
  assert.match(main, /title: 'Model Resources'/)
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /isTrustedSender\(event, modelSettingsWindow\)/)
  assert.deepEqual(
    [...preload.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((match) => match[1]).sort(),
    ['getHealth', 'getResources', 'loginChatGPT', 'onResources', 'openDshHome', 'openUsageDashboard', 'refreshResources'],
  )
  assert.match(html, /connect-src 'none'/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(renderer, /\b(?:require|process|Buffer|fetch|XMLHttpRequest|WebSocket|eval)\b/)
  assert.doesNotMatch(renderer, /\.innerHTML\s*=/)
  assert.doesNotMatch(main, /accessToken|refreshToken/)
  assert.match(main, /ModelResourceService/)
  assert.match(read('app/lib/model-resources/service.js'), /new Worker\(/)
  assert.doesNotMatch(main, /function modelHealth\(\)[\s\S]{0,800}spawnSync/)
})

test('Harness Lab renderer is static, local, and has no Node or arbitrary network access', () => {
  const html = read('app/harness-lab/index.html')
  const renderer = read('app/harness-lab/renderer.js')
  assert.match(html, /不只看答案，更要看任务是怎么完成的。/)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /connect-src 'none'/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(renderer, /\b(?:require|process|Buffer)\b/)
  assert.doesNotMatch(renderer, /\b(?:fetch|XMLHttpRequest|WebSocket|eval)\s*\(/)
  assert.doesNotMatch(renderer, /\.innerHTML\s*=/)
  assert.match(renderer, /compactString\(run\.workspace \|\| run\.model/)
  assert.match(renderer, /const PATH_RE =/)
  assert.match(html, /复制优化任务/)
})

test('session service uses opaque registry IDs rather than renderer-provided paths', () => {
  const service = read('app/lib/harness-lab/session-service.js')
  assert.match(service, /\^\[a-f0-9\]\{24\}\$/)
  assert.match(service, /this\.registry\.get\(runId\)/)
  assert.doesNotMatch(service, /readFile\(runId/)
  assert.doesNotMatch(service, /resolve\(runId/)
  assert.match(service, /entry\.isSymbolicLink\(\)/)
  assert.match(service, /safeDirectoryRoot\(selectedRoot\)/)
  assert.match(service, /sameIdentity\(before, after\)/)
  assert.match(service, /sameIdentity\(rootAfter, expectedRoot\)/)
  assert.match(service, /O_NOFOLLOW/)
  assert.match(service, /handle\.readFile\(\)/)
  assert.match(service, /this\.maxFiles = options\.maxFiles \?\? 20/)
  assert.match(service, /harness-lab-summary-cache|summaryCachePath/)
  assert.match(service, /isWithinRoot\(currentReal, resolvedRoot\)/)
})

test('screenshot automation accepts only a new PNG basename in the temporary directory', () => {
  const main = read('app/main.js')
  assert.match(main, /requested !== path\.basename\(requested\)/)
  assert.match(main, /app\.getPath\('temp'\)/)
  assert.match(main, /flag: 'wx'/)
  assert.doesNotMatch(main, /writeFileSync\(target, image\.toPNG\(\)\)/)
})

test('Harness Lab automation re-queries rows after each state-changing selection', () => {
  const main = read('app/main.js')
  assert.match(main, /const selectRun = \(rowIndex, side\) => document\s*\.querySelectorAll\('#runs-body tr'\)\[rowIndex\]/)
  assert.match(main, /selectRun\(0, 'a'\)\s*selectRun\(1, 'b'\)\s*document\.getElementById\('compare-selected'\)\?\.click\(\)/)
  assert.match(main, /report\.diagnosis === '运行 B 的执行轨迹整体更精简、稳定。'/)
})

test('all committed JSONL fixtures are explicitly synthetic', () => {
  const fixturePaths = [
    'tests/fixtures/run-a.jsonl',
    'tests/fixtures/run-b.jsonl',
    'tests/fixtures/run-unknown-events.jsonl',
    'tests/fixtures/run-secret-redaction.jsonl',
    'app/demo/run-a.jsonl',
    'app/demo/run-b.jsonl',
  ]
  for (const fixturePath of fixturePaths) {
    const header = JSON.parse(read(fixturePath).split(/\r?\n/, 1)[0])
    assert.match(header.id, /^synthetic-/)
    assert.match(header.cwd, /synthetic/i)
  }
})

test('smoke-validated compatibility claim is stated in audit and README', () => {
  const claim = 'Schema-derived, synthetic-tested, and smoke-validated against a locally generated minimal DeepSeek Harness session.'
  for (const file of ['docs/session-format-audit.md', 'README.md']) {
    assert.ok(read(file).replace(/^>\s?/gm, '').replace(/\s+/g, ' ').includes(claim))
  }
})

test('packaging includes trajectory, DeepSea theme, local UI, preload, and synthetic demo assets', () => {
  const manifest = JSON.parse(read('app/package.json'))
  for (const entry of ['harness-lab/**/*', 'lib/**/*', 'demo/**/*', 'themes/**/*']) {
    assert.ok(manifest.build.files.includes(entry), entry)
  }
  assert.ok(manifest.build.asarUnpack.includes('demo/**/*'))
  assert.match(read('app/main.js'), /app\.asar\.unpacked', 'demo'/)
  assert.ok(manifest.build.files.includes('model-settings/**/*'))
  const resourceTargets = manifest.build.extraResources.map((entry) => entry.to)
  assert.ok(resourceTargets.includes('tools/oauth-login-openai-codex.mjs'))
  assert.ok(resourceTargets.includes('tools/patch-pi-ai-oauth.mjs'))
})

test('DeepSea theme is token-driven and does not force upstream theme state', () => {
  const main = read('app/main.js')
  const palette = read('app/themes/deepsea-palette.css')
  const adapter = read('app/themes/deepsea-adapter.css')
  assert.match(palette, /--dss-brand:\s*#4d8dff/)
  assert.match(adapter, /body\[data-ds-dark-theme\]/)
  assert.match(adapter, /--dsw-alias-brand-primary:\s*var\(--dss-brand\)/)
  assert.doesNotMatch(main, /MutationObserver|data-ds-dark-theme',\s*''/)
  assert.doesNotMatch(read('app/titlebar.js'), /setInterval/)
})
