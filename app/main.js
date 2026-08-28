/**
 * DeepSeek Desktop — Electron shell around the DeepSeek Harness web GUI.
 *
 * The bundled runtime (resources/runtime) is the full production closure of
 * the `dsh` CLI; the bundled node.exe (resources/node.exe) boots
 * `dsh web` on a free loopback port, and this shell opens a frameless,
 * Claude Code-styled window on top of it. Closing the window tears the
 * server down; a crash shows the log path in a dialog.
 */
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, clipboard, nativeImage, net: electronNet } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const { HarnessLabSessionService } = require('./lib/harness-lab/session-service')
const { ModelResourceService } = require('./lib/model-resources/service')

const PRODUCT = 'DeepSeek'
const APP_ID = 'com.deepseek.desktop'
const WINDOW_BG = '#1f1e1d'
const LOG_PATH = path.join(os.tmpdir(), 'deepseek-desktop.log')
const MAX_PINNED_SESSIONS = 50

let mainWindow = null
let harnessLabWindow = null
let modelSettingsWindow = null
let harnessLabService = null
let modelResourceService = null
let serverChild = null
let stopping = false
let cachedPatchStatus = { ok: null, detail: '正在后台检测 OAuth 适配状态。' }

function normalizePinnedSessionIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, MAX_PINNED_SESSIONS)
}

function sessionPinsPath() {
  return path.join(app.getPath('userData'), 'session-pins.json')
}

function readSessionPins() {
  try { return normalizePinnedSessionIds(JSON.parse(fs.readFileSync(sessionPinsPath(), 'utf8'))) } catch { return [] }
}

function writeSessionPins(value) {
  const pins = normalizePinnedSessionIds(value)
  const target = sessionPinsPath()
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(pins)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, target)
  return pins
}
const HARNESS_LAB_DEMO = process.env.HARNESS_LAB_DEMO === '1' || process.argv.includes('--demo-harness-lab')
const MODEL_SETTINGS_DEMO = process.argv.includes('--demo-model-settings') || process.argv.includes('--verify-model-settings')

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`
  try { fs.appendFileSync(LOG_PATH, text) } catch {}
  if (!app.isPackaged) process.stdout.write(text)
}

function screenshotTarget(shotArg) {
  const requested = shotArg.slice('--shot='.length)
  if (
    requested !== path.basename(requested)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.png$/i.test(requested)
  ) {
    throw new Error('Screenshot name must be a simple PNG filename')
  }
  return path.join(app.getPath('temp'), requested)
}

function writeScreenshot(target, image) {
  fs.writeFileSync(target, image.toPNG(), { flag: 'wx', mode: 0o600 })
}

function resolveRuntimeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.join(__dirname, '..', 'staging', 'payload', 'runtime')
}

function binJsPath(resources) {
  // The deploy layout puts the @deepseek-ai/dsh package at the runtime root.
  return path.join(resources, 'lib', 'bin.js')
}

function nodeExePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'node.exe')
    : path.join(__dirname, '..', 'staging', 'payload', 'node.exe')
}

function dshHomePath() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function toolPath(name) {
  const repositoryScript = new Set(['patch-pi-ai-oauth.mjs', 'model-resource-probe.mjs']).has(name)
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', name)
    : path.join(__dirname, '..', repositoryScript ? 'scripts' : 'config-example', name)
}

function probeCodexUsage() {
  return new Promise((resolve) => {
    const child = spawn(nodeExePath(), [toolPath('model-resource-probe.mjs'), resolveRuntimeRoot(), dshHomePath()], {
      windowsHide: true,
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', DSH_HOME: dshHomePath() },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-65_536) })
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ ok: false, code: 'TIMEOUT' })
    }, 10_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, code: 'PROBE_FAILED' })
    })
    child.once('exit', () => {
      clearTimeout(timer)
      try { resolve(JSON.parse(output.trim())) } catch { resolve({ ok: false, code: 'PROBE_FAILED' }) }
    })
  })
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'build', 'icon.ico')
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function waitForHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error(`server did not answer on port ${port} within ${timeoutMs}ms`))
        setTimeout(probe, 300)
      })
    }
    probe()
  })
}

function startServer(port) {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_SESSION_LOG']) {
    delete env[key]
  }
  env.DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

  const nodeExe = nodeExePath()
  if (!fs.existsSync(nodeExe)) {
    throw new Error(`bundled node runtime missing: ${nodeExe}`)
  }
  const resources = resolveRuntimeRoot()
  const binJs = binJsPath(resources)
  if (!fs.existsSync(binJs)) {
    throw new Error(`bundled dsh runtime missing: ${binJs}`)
  }

  // Junction targets are stored absolute on Windows; a freshly extracted tree
  // (portable exe → random temp dir) must be re-pointed to this run's root.
  // The fixer ships in extraResources because plain node.exe cannot read asar.
  const fixer = app.isPackaged
    ? path.join(process.resourcesPath, 'fix-junctions.js')
    : path.join(__dirname, 'fix-junctions.js')
  if (fs.existsSync(fixer)) {
    log(`repairing runtime junctions at ${resources}`)
    const fix = spawnSync(nodeExe, [fixer, resources], {
      windowsHide: true,
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (fix.stdout) log(`[fix] ${String(fix.stdout).trimEnd()}`)
    if (fix.stderr) log(`[fix!] ${String(fix.stderr).trimEnd()}`)
    if (fix.status !== 0) {
      throw new Error(`runtime junction repair failed (status ${fix.status})`)
    }
  }

  log(`spawning node ${binJs} web --port ${port} (DSH_HOME=${env.DSH_HOME})`)
  serverChild = spawn(nodeExe, [binJs, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: path.dirname(app.getPath('exe')),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverChild.stdout.on('data', (chunk) => log(`[dsh] ${String(chunk).trimEnd()}`))
  serverChild.stderr.on('data', (chunk) => log(`[dsh!] ${String(chunk).trimEnd()}`))
  serverChild.on('exit', (code, signal) => {
    log(`dsh server exited (code=${code}, signal=${signal})`)
    serverChild = null
    if (!stopping) {
      dialog.showErrorBox(
        PRODUCT,
        `The DeepSeek engine stopped unexpectedly (code ${code ?? signal}).\n\nLog: ${LOG_PATH}`,
      )
      app.quit()
    }
  })
}

function injectDesktopFrame(win) {
  const inject = () => {
    const themeCss = readInjected('claude-theme.css')
    const harnessLabButtonCss = readInjected('harness-lab-button.css')
    const titlebarJs = readInjected('titlebar.js')
      .replace('__DEEPSEEK_LOGO_DATA_URL__', nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 }).toDataURL())
    if (themeCss) win.webContents.insertCSS(themeCss, { cssOrigin: 'author' }).catch(() => {})
    if (harnessLabButtonCss) win.webContents.insertCSS(harnessLabButtonCss, { cssOrigin: 'author' }).catch(() => {})
    const forceDark = `(() => {
      const ensure = () => {
        if (document.body && !document.body.hasAttribute('data-ds-dark-theme')) {
          document.body.setAttribute('data-ds-dark-theme', '')
        }
      }
      ensure()
      try {
        new MutationObserver(ensure).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      } catch {}
    })()`
    win.webContents.executeJavaScript(forceDark).catch(() => {})
    if (titlebarJs) win.webContents.executeJavaScript(titlebarJs).catch(() => {})
  }
  win.webContents.on('dom-ready', inject)
  win.webContents.on('did-finish-load', inject)
}

function readInjected(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name), 'utf8')
  } catch {
    return ''
  }
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: WINDOW_BG,
    icon: iconPath(),
    title: PRODUCT,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show())
  mainWindow.on('maximize', () => mainWindow?.webContents.send('cc:max-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('cc:max-changed', false))
  mainWindow.on('closed', () => { mainWindow = null })

  const base = `http://127.0.0.1:${port}/`
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(base)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(base)) event.preventDefault()
  })

  injectDesktopFrame(mainWindow)
  await mainWindow.loadURL(base)
}

function isTrustedSender(event, win) {
  return Boolean(
    win
    && !win.isDestroyed()
    && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame
  )
}

async function createHarnessLabWindow() {
  if (harnessLabWindow && !harnessLabWindow.isDestroyed()) {
    if (harnessLabWindow.isMinimized()) harnessLabWindow.restore()
    harnessLabWindow.show()
    harnessLabWindow.focus()
    return harnessLabWindow
  }

  harnessLabWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 920,
    minHeight: 620,
    show: false,
    backgroundColor: '#111214',
    icon: iconPath(),
    title: 'Harness Lab',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      partition: 'harness-lab',
      preload: path.join(__dirname, 'harness-lab', 'preload.js'),
    },
  })

  const labHtml = path.join(__dirname, 'harness-lab', 'index.html')
  const labUrl = pathToFileURL(labHtml).href
  harnessLabWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  harnessLabWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== labUrl) event.preventDefault()
  })
  harnessLabWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  harnessLabWindow.webContents.session.setPermissionCheckHandler(() => false)
  harnessLabWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  harnessLabWindow.once('ready-to-show', () => harnessLabWindow?.show())
  harnessLabWindow.on('closed', () => { harnessLabWindow = null })
  await harnessLabWindow.loadFile(labHtml)
  return harnessLabWindow
}

function readOAuthSummary() {
  const credentialPath = path.join(dshHomePath(), 'oauth-credentials.json')
  try {
    const data = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
    const credential = data['openai-codex']
    if (!credential || typeof credential !== 'object') return { present: false }
    return {
      present: true,
      accountId: typeof credential.accountId === 'string' ? credential.accountId : null,
      expires: Number.isFinite(Number(credential.expires)) ? Number(credential.expires) : null,
    }
  } catch {
    return { present: false }
  }
}

function refreshPatchStatus() {
  return new Promise((resolve) => {
    const child = spawn(nodeExePath(), [toolPath('patch-pi-ai-oauth.mjs'), resolveRuntimeRoot(), '--check'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const capture = (chunk) => { output = `${output}${String(chunk)}`.slice(-300) }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      cachedPatchStatus = { ok: null, detail: 'OAuth 适配检测超时，不影响窗口使用。' }
      resolve(cachedPatchStatus)
    }, 5000)
    child.once('error', () => {
      clearTimeout(timer)
      cachedPatchStatus = { ok: false, detail: '无法启动 OAuth 适配检测。' }
      resolve(cachedPatchStatus)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      cachedPatchStatus = { ok: code === 0, detail: output.trim() || (code === 0 ? '兼容' : '需要修复') }
      resolve(cachedPatchStatus)
    })
  })
}

function modelHealth() {
  const info = readBuildInfo()
  return {
    appVersion: app.getVersion(),
    dshVersion: info?.dshVersion ?? null,
    dshCommit: info?.dshCommitShort ?? null,
    runtimePresent: fs.existsSync(binJsPath(resolveRuntimeRoot())),
    serverRunning: Boolean(serverChild),
    dshHome: dshHomePath(),
    settingsPresent: fs.existsSync(path.join(dshHomePath(), 'settings.yaml')),
    oauth: readOAuthSummary(),
    patch: cachedPatchStatus,
    resources: modelResourceService?.getCachedSnapshot() ?? null,
  }
}

function publishModelResources(snapshot) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cc:model-resources-updated', snapshot)
  if (modelSettingsWindow && !modelSettingsWindow.isDestroyed()) modelSettingsWindow.webContents.send('model-settings:resources-updated', snapshot)
}

async function createModelSettingsWindow() {
  if (modelSettingsWindow && !modelSettingsWindow.isDestroyed()) {
    modelSettingsWindow.show()
    modelSettingsWindow.focus()
    return
  }
  modelSettingsWindow = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#171717',
    icon: iconPath(),
    title: 'Model Resources',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'model-settings', 'preload.js'),
    },
  })
  const settingsHtml = path.join(__dirname, 'model-settings', 'index.html')
  const settingsUrl = pathToFileURL(settingsHtml).href
  modelSettingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  modelSettingsWindow.webContents.on('will-navigate', (event, url) => { if (url !== settingsUrl) event.preventDefault() })
  modelSettingsWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  modelSettingsWindow.once('ready-to-show', () => modelSettingsWindow?.show())
  modelSettingsWindow.on('closed', () => { modelSettingsWindow = null })
  await modelSettingsWindow.loadFile(settingsHtml)
}

function trustedSettingsHandler(operation) {
  return async (event, ...args) => {
    if (!isTrustedSender(event, modelSettingsWindow)) throw new Error('Settings request denied')
    return operation(...args)
  }
}

function runOAuthLogin() {
  const script = toolPath('oauth-login-openai-codex.mjs')
  const child = spawn(nodeExePath(), [script, resolveRuntimeRoot()], {
    env: { ...process.env, DSH_HOME: dshHomePath(), DSH_RUNTIME: resolveRuntimeRoot() },
    windowsHide: false,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return { started: true }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function harnessLabReport(win) {
  return win.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('h1')?.textContent,
    runRows: document.querySelectorAll('#runs-body tr').length,
    summaryCards: document.querySelectorAll('#summary-cards .summary-card').length,
    divergences: document.querySelectorAll('#divergence-list .divergence-card').length,
    diagnosis: document.getElementById('diagnosis-headline')?.textContent,
    healthVisible: !document.getElementById('run-health')?.hidden,
    businessGate: document.getElementById('business-gate')?.textContent,
    compareVisible: !document.getElementById('compare-content')?.hidden,
    feedback: document.getElementById('runs-feedback')?.textContent,
  }))()`)
}

function harnessLabDemoDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'demo')
    : path.join(__dirname, 'demo')
}

async function waitForHarnessLab(win, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let lastReport = null
  while (Date.now() <= deadline) {
    const report = await harnessLabReport(win)
    lastReport = report
    if (predicate(report)) return report
    await delay(100)
  }
  throw new Error(`Harness Lab did not reach the expected state: ${JSON.stringify(lastReport)}`)
}

function setupHarnessLabAutomation(win) {
  const verify = process.argv.includes('--verify-harness-lab')
  const shotArg = process.argv.find((arg) => arg.startsWith('--shot='))
  if (!verify && !shotArg) return

  void (async () => {
    try {
      await waitForHarnessLab(win, (report) => report.runRows >= 2)
      await win.webContents.executeJavaScript(`(() => {
        const selectRun = (rowIndex, side) => document
          .querySelectorAll('#runs-body tr')[rowIndex]
          ?.querySelector('[data-select-side="' + side + '"]')
          ?.click()
        if (document.querySelectorAll('#runs-body tr').length >= 2) {
          document.querySelectorAll('#runs-body tr')[0]?.querySelector('[data-action="inspect"]')?.click()
          selectRun(0, 'a')
          selectRun(1, 'b')
          document.getElementById('compare-selected')?.click()
        }
      })()`)
      const report = await waitForHarnessLab(win, (candidate) => (
        candidate.compareVisible && candidate.summaryCards === 6 && candidate.divergences >= 4 && candidate.healthVisible
      ))
      const ok = report.title === '执行实验室'
        && report.runRows === 2
        && report.summaryCards === 6
        && report.divergences >= 4
        && report.diagnosis === '运行 B 的执行轨迹整体更精简、稳定。'
        && report.businessGate === '尚未验收'
        && report.compareVisible
      if (verify) {
        console.log(`HARNESS-LAB-VERIFY ${JSON.stringify(report)}`)
        process.exitCode = ok ? 0 : 1
      }
      if (shotArg) {
        const target = screenshotTarget(shotArg)
        const image = await win.webContents.capturePage()
        writeScreenshot(target, image)
        log(`Harness Lab screenshot written to temporary file: ${path.basename(target)}`)
      }
    } catch (error) {
      process.exitCode = 1
      log(`Harness Lab automation failed: ${String(error && error.message ? error.message : error)}`)
    }
    app.quit()
  })()
}

function harnessLabHandler(operation) {
  return async (event, ...args) => {
    if (!isTrustedSender(event, harnessLabWindow) || !harnessLabService) {
      throw new Error('Harness Lab request denied')
    }
    try {
      return await operation(harnessLabService, ...args)
    } catch (error) {
      if (error?.code === 'HARNESS_LAB_ZSTD_UNAVAILABLE') {
        throw new Error('Harness Lab cannot read compressed sessions in this runtime')
      }
      if (error?.code === 'HARNESS_LAB_NOT_COMPARABLE') {
        throw new Error('只有同一任务谱系下的不同尝试才能进行受控对比')
      }
      throw new Error('Harness Lab request failed')
    }
  }
}

function comparisonMarkdown(comparison) {
  const diagnosis = comparison.diagnosis || {}
  const findings = Array.isArray(diagnosis.findings) ? diagnosis.findings : []
  const recommendations = Array.isArray(diagnosis.recommendations) ? diagnosis.recommendations : []
  return [
    '# Harness Lab 对比报告', '',
    `## 结论`, '', diagnosis.headline || '暂无明确结论。', '',
    '## 关键发现', '', ...findings.map((item) => `- ${item.text}`), '',
    '## 下一步动作', '', ...recommendations.map((item) => `- ${item}`), '',
    `> ${diagnosis.caveat || '结论只评价执行轨迹。'}`, '',
  ].join('\n')
}

function optimizationBrief(comparison) {
  const diagnosis = comparison.diagnosis || {}
  const actions = Array.isArray(diagnosis.recommendations) ? diagnosis.recommendations : []
  return [
    '请基于上一轮执行复盘优化本次任务。',
    diagnosis.headline || '',
    ...actions.map((item, index) => `${index + 1}. ${item}`),
    '要求：保持最终业务目标不变，减少无效工具调用；关键修改后及时运行最小验证；完成后报告采取的优化和验证结果。',
  ].filter(Boolean).join('\n')
}

function runFixBrief(run) {
  const diagnosis = run.diagnosis || {}
  return [
    '请继续修复并完成上一轮任务。',
    diagnosis.headline || '',
    ...(diagnosis.issues || []).map((item) => `发现：${item}`),
    ...(diagnosis.actions || []).map((item, index) => `${index + 1}. ${item}`),
    '要求：保持原业务目标不变；完成后验证最终产物，并明确报告业务验收结果。',
  ].filter(Boolean).join('\n')
}

function baselinePath() {
  return path.join(app.getPath('userData'), 'harness-lab-baseline.json')
}

function readBaselineId() {
  try { return JSON.parse(fs.readFileSync(baselinePath(), 'utf8')).runId || null } catch { return null }
}

// ---- GitHub version check (major-version updates only) ---------------------

const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000 // at most one upstream check per day

function versionFilePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'version.json')
    : path.join(__dirname, '..', 'staging', 'payload', 'version.json')
}

function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(versionFilePath(), 'utf8'))
  } catch {
    return null
  }
}

function updateCachePath() {
  return path.join(app.getPath('userData'), 'update-cache.json')
}

function readUpdateCache() {
  try { return JSON.parse(fs.readFileSync(updateCachePath(), 'utf8')) } catch { return {} }
}

function writeUpdateCache(cache) {
  try { fs.writeFileSync(updateCachePath(), JSON.stringify(cache, null, 2)) } catch {}
}

/** major.minor of a semver-ish string; e.g. "0.1.0-rc.5" -> [0, 1]. */
function majorMinor(version) {
  const m = String(version).trim().match(/^v?(\d+)\.(\d+)/)
  if (!m) return [0, 0]
  return [Number(m[1]), Number(m[2])]
}

/**
 * Ask GitHub what version upstream master carries, and decide whether it is a
 * "major" release relative to this build: only a higher major OR minor number
 * counts. Patch/prerelease churn never prompts, per user preference.
 */
async function checkForUpdates({ force = false } = {}) {
  const info = readBuildInfo()
  if (!info || !info.dshRepo || !info.dshBranch || !info.dshVersion) {
    return { error: 'no build info' }
  }
  const cache = readUpdateCache()
  if (!force && cache.lastCheckedAt && Date.now() - cache.lastCheckedAt < UPDATE_CHECK_MS) {
    const [curMajor, curMinor] = majorMinor(info.dshVersion)
    const [seenMajor, seenMinor] = majorMinor(cache.latestVersion ?? '0.0.0')
    return {
      updateAvailable: seenMajor > curMajor || (seenMajor === curMajor && seenMinor > curMinor),
      cached: true,
      latestVersion: cache.latestVersion,
      build: info,
    }
  }
  const url = `https://raw.githubusercontent.com/${info.dshRepo}/${encodeURIComponent(info.dshBranch)}/package.json`
  try {
    // net.fetch rides the Chromium network stack, so the system proxy
    // (e.g. 127.0.0.1:10808) applies — plain node fetch bypasses it.
    const res = await electronNet.fetch(url, { headers: { 'User-Agent': 'DeepSeek-Desktop' } })
    if (!res.ok) return { error: `github ${res.status}` }
    const manifest = await res.json()
    const latestVersion = typeof manifest.version === 'string' ? manifest.version : null
    if (!latestVersion) return { error: 'no version upstream' }
    writeUpdateCache({ lastCheckedAt: Date.now(), latestVersion })
    const [curMajor, curMinor] = majorMinor(info.dshVersion)
    const [upMajor, upMinor] = majorMinor(latestVersion)
    const updateAvailable = upMajor > curMajor || (upMajor === curMajor && upMinor > curMinor)
    return { updateAvailable, latestVersion, build: info }
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) }
  }
}

function updaterScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sync-update.ps1')
    : path.join(__dirname, '..', 'scripts', 'sync-update.ps1')
}

/** The exe to relaunch after an update (portable runs from a temp extraction). */
function relaunchTarget() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return process.env.PORTABLE_EXECUTABLE_FILE
  return app.getPath('exe')
}

/** Stage the updater to a stable temp path, run it visibly, then quit. */
function launchUpdater() {
  const src = updaterScriptPath()
  if (!fs.existsSync(src)) {
    dialog.showErrorBox(PRODUCT, `Updater script missing: ${src}`)
    return
  }
  const staged = path.join(os.tmpdir(), 'deepseek-update.ps1')
  try {
    fs.copyFileSync(src, staged)
  } catch (error) {
    dialog.showErrorBox(PRODUCT, `Cannot stage updater: ${String(error && error.message ? error.message : error)}`)
    return
  }
  log(`launching updater (relaunch=${relaunchTarget()})`)
  const child = spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass', '-File', staged,
    '-Relaunch', relaunchTarget(),
  ], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  setTimeout(() => app.quit(), 1500)
}

async function offerUpdate(result) {
  if (!result.updateAvailable || !mainWindow) return
  const info = result.build
  const detail = [
    `当前版本: ${info.dshVersion} (${info.dshCommitShort ?? ''})`,
    `最新版本: ${result.latestVersion}`,
    '',
    '更新会退出应用，拉取最新代码并重新打包（约 10–15 分钟），完成后自动重启。',
  ].join('\n')
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'DeepSeek 有新版本',
    message: `发现新的大版本 ${result.latestVersion}`,
    detail,
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) launchUpdater()
}

// ---- single instance -------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const targetWindow = HARNESS_LAB_DEMO ? harnessLabWindow : MODEL_SETTINGS_DEMO ? modelSettingsWindow : mainWindow
    if (targetWindow) {
      if (targetWindow.isMinimized()) targetWindow.restore()
      targetWindow.focus()
    }
  })

  // ---- window control IPC ----------------------------------------------------

  ipcMain.on('cc:min', () => mainWindow?.minimize())
  ipcMain.on('cc:max', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('cc:close', () => mainWindow?.close())
  ipcMain.handle('cc:isMax', () => mainWindow?.isMaximized() ?? false)
  ipcMain.handle('cc:get-session-pins', (event) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Session pin request denied')
    return readSessionPins()
  })
  ipcMain.handle('cc:set-session-pins', (event, value) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Session pin update denied')
    return writeSessionPins(value)
  })
  ipcMain.handle('cc:model-resources', (event) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Resource request denied')
    modelResourceService?.scheduleRefresh().catch(() => {})
    return modelResourceService?.getCachedSnapshot() ?? null
  })
  ipcMain.on('cc:open-harness-lab', (event) => {
    if (!isTrustedSender(event, mainWindow)) return
    createHarnessLabWindow().catch(() => {
      dialog.showErrorBox('Harness Lab', 'Could not open the local Harness Lab window.')
    })
  })
  ipcMain.on('cc:open-model-settings', (event) => {
    if (!isTrustedSender(event, mainWindow)) return
    createModelSettingsWindow().catch(() => dialog.showErrorBox(PRODUCT, '无法打开模型资源中心。'))
  })
  ipcMain.handle('model-settings:health', trustedSettingsHandler(() => modelHealth()))
  ipcMain.handle('model-settings:resources', trustedSettingsHandler(() => {
    modelResourceService?.scheduleRefresh().catch(() => {})
    return modelResourceService?.getCachedSnapshot() ?? null
  }))
  ipcMain.handle('model-settings:refresh-resources', trustedSettingsHandler(() => modelResourceService?.scheduleRefresh({ force: true })))
  ipcMain.handle('model-settings:login', trustedSettingsHandler(() => runOAuthLogin()))
  ipcMain.handle('model-settings:open-usage', trustedSettingsHandler(() => shell.openExternal('https://chatgpt.com/codex/settings/usage')))
  ipcMain.handle('model-settings:open-home', trustedSettingsHandler(() => {
    fs.mkdirSync(dshHomePath(), { recursive: true })
    return shell.openPath(dshHomePath())
  }))

  ipcMain.handle('harness-lab:list-runs', harnessLabHandler(async (service) => {
    const baselineId = readBaselineId()
    return (await service.listRuns()).map((run) => ({ ...run, isBaseline: run.runId === baselineId }))
  }))
  ipcMain.handle('harness-lab:get-run', harnessLabHandler((service, runId) => service.getRun(runId)))
  ipcMain.handle('harness-lab:compare-runs', harnessLabHandler((service, runAId, runBId) => service.compare(runAId, runBId)))
  ipcMain.handle('harness-lab:copy-brief', harnessLabHandler(async (service, runAId, runBId) => {
    clipboard.writeText(optimizationBrief(await service.compare(runAId, runBId)))
    return { copied: true }
  }))
  ipcMain.handle('harness-lab:export-report', harnessLabHandler(async (service, runAId, runBId) => {
    const comparison = await service.compare(runAId, runBId)
    const result = await dialog.showSaveDialog(harnessLabWindow, {
      title: '导出 Harness Lab 对比报告',
      defaultPath: `harness-lab-${new Date().toISOString().slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return { exported: false }
    fs.writeFileSync(result.filePath, comparisonMarkdown(comparison), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return { exported: true }
  }))
  ipcMain.handle('harness-lab:set-baseline', harnessLabHandler(async (service, runId) => {
    await service.requireRun(runId)
    fs.writeFileSync(baselinePath(), JSON.stringify({ runId, savedAt: new Date().toISOString() }), { mode: 0o600 })
    return { saved: true }
  }))
  ipcMain.handle('harness-lab:copy-run-fix', harnessLabHandler(async (service, runId) => {
    clipboard.writeText(runFixBrief(await service.getRun(runId)))
    return { copied: true }
  }))
  ipcMain.handle('harness-lab:open-original', harnessLabHandler(async (service, runId) => {
    const sessionId = await service.sourceSessionId(runId)
    if (!sessionId || !mainWindow || mainWindow.isDestroyed()) return { opened: false }
    const located = await mainWindow.webContents.executeJavaScript(`(() => {
      const id = ${JSON.stringify(sessionId)}
      const nodes = [...document.querySelectorAll('[href], [data-session-id], [data-session]')]
      const target = nodes.find((node) => [node.getAttribute('href'), node.getAttribute('data-session-id'), node.getAttribute('data-session')]
        .filter(Boolean).some((value) => value === id || value.includes(encodeURIComponent(id)) || value.includes(id)))
      if (!target) return false
      target.click()
      return true
    })()`)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    if (located) harnessLabWindow?.hide()
    return { opened: Boolean(located) }
  }))

  // ---- lifecycle -------------------------------------------------------------

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    Menu.setApplicationMenu(null)
    harnessLabService = new HarnessLabSessionService({
      demoMode: HARNESS_LAB_DEMO,
      demoDir: harnessLabDemoDir(),
      summaryCachePath: path.join(app.getPath('userData'), 'harness-lab-summary-cache.json'),
    })
    modelResourceService = new ModelResourceService({
      dshHome: dshHomePath(),
      probeCodexUsage: MODEL_SETTINGS_DEMO && process.env.MODEL_RESOURCES_LIVE !== '1' ? null : probeCodexUsage,
    })
    modelResourceService.on('updated', publishModelResources)
    modelResourceService.startWatching()
    setTimeout(() => modelResourceService?.scheduleRefresh({ force: true }).catch(() => {}), 250)
    setTimeout(() => refreshPatchStatus().catch(() => {}), 500)
    if (!app.isPackaged) {
      // Dev convenience: F12 toggles DevTools.
      app.on('web-contents-created', (_event, contents) => {
        contents.on('before-input-event', (event, input) => {
          if (input.type === 'keyDown' && input.key === 'F12') {
            contents.toggleDevTools()
            event.preventDefault()
          }
        })
      })
    }

    if (HARNESS_LAB_DEMO) {
      try {
        const win = await createHarnessLabWindow()
        setupHarnessLabAutomation(win)
        log('Harness Lab demo ready')
      } catch (error) {
        log(`Harness Lab demo startup failed: ${String(error && error.message ? error.message : error)}`)
        dialog.showErrorBox('Harness Lab', 'Could not start Harness Lab demo mode.')
        app.quit()
      }
      return
    }

    if (MODEL_SETTINGS_DEMO) {
      try {
        await createModelSettingsWindow()
        if (process.argv.includes('--verify-model-settings')) {
          await delay(800)
          const report = await modelSettingsWindow.webContents.executeJavaScript(`(() => ({
            title: document.querySelector('h1')?.textContent,
            quotaCards: document.querySelectorAll('#quota-grid .quota-card').length,
            usageCards: document.querySelectorAll('#local-usage .usage-card').length,
            route: document.getElementById('route-name')?.textContent,
            firstRenderMs: Number(document.body.dataset.resourceRenderMs || NaN),
            loginButton: Boolean(document.getElementById('login')),
            bodyBg: getComputedStyle(document.body).backgroundColor,
          }))()`)
          const ok = report.title === '模型资源中心' && report.quotaCards >= 1 && report.usageCards === 3
            && report.loginButton && Number.isFinite(report.firstRenderMs) && report.firstRenderMs < 1000
          console.log(`MODEL-SETTINGS-VERIFY ${JSON.stringify(report)}`)
          const modelSettingsShot = process.argv.find((arg) => arg.startsWith('--shot='))
          if (modelSettingsShot) {
            const target = screenshotTarget(modelSettingsShot)
            writeScreenshot(target, await modelSettingsWindow.webContents.capturePage())
            console.log(`MODEL-SETTINGS-SHOT ${target}`)
          }
          process.exitCode = ok ? 0 : 1
          app.quit()
        }
      } catch (error) {
        log(`Model Resources demo failed: ${String(error && error.message ? error.message : error)}`)
        process.exitCode = 1
        app.quit()
      }
      return
    }

    let port
    try {
      port = await findFreePort()
      startServer(port)
      await waitForHttp(port, 90000)
      await createWindow(port)
      log('window ready')
    } catch (error) {
      log(`startup failed: ${error && error.stack ? error.stack : String(error)}`)
      dialog.showErrorBox(
        PRODUCT,
        `Could not start the DeepSeek engine.\n\n${String(error && error.message ? error.message : error)}\n\nLog: ${LOG_PATH}`,
      )
      app.quit()
      return
    }

    // --check-update: force a GitHub version check, print JSON, exit.
    if (process.argv.includes('--check-update')) {
      const result = await checkForUpdates({ force: true })
      console.log(`CHECK-UPDATE ${JSON.stringify(result)}`)
      log(`check-update: ${JSON.stringify(result)}`)
      app.quit()
      return
    }

    // Non-blocking version check shortly after launch; only "major" releases prompt.
    setTimeout(async () => {
      const result = await checkForUpdates()
      log(`update check: ${JSON.stringify(result)}`)
      if (result.updateAvailable) await offerUpdate(result)
    }, 12000)

    // --shot=<filename.png>: capture into the OS temporary directory without
    // following or replacing an existing destination.
    const shotArg = process.argv.find((arg) => arg.startsWith('--shot='))
    if (shotArg) {
      setTimeout(async () => {
        try {
          const target = screenshotTarget(shotArg)
          const image = await mainWindow.webContents.capturePage()
          writeScreenshot(target, image)
          log(`screenshot written to temporary file: ${path.basename(target)}`)
        } catch (error) {
          process.exitCode = 1
          log(`screenshot failed: ${error}`)
        }
        app.quit()
      }, 8000)
    }

    // --verify: programmatic UI check — sample computed styles and print JSON,
    // exit 0 when the Claude Code theme + title bar are applied.
    if (process.argv.includes('--verify')) {
      setTimeout(async () => {
        try {
          const report = await mainWindow.webContents.executeJavaScript(`(() => {
            const bar = document.getElementById('cc-titlebar')
            const bodyStyle = getComputedStyle(document.body)
            const accent = bodyStyle.getPropertyValue('--dsw-alias-brand-primary').trim()
            return {
              titlebarPresent: Boolean(bar),
              darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
              bodyBg: bodyStyle.backgroundColor,
              bodyPaddingTop: bodyStyle.paddingTop,
              accent,
              titlebarBg: bar ? getComputedStyle(bar).backgroundColor : null,
              mark: bar && bar.querySelector('.cc-mark') ? bar.querySelector('.cc-mark').textContent : null,
            }
          })()`)
          const ok = report.titlebarPresent && report.darkAttr
            && report.titlebarBg === 'rgb(31, 30, 29)'
            && (String(report.accent) === '#d97757' || String(report.accent).includes('217, 119, 87'))
          console.log(`VERIFY ${JSON.stringify(report)}`)
          process.exitCode = ok ? 0 : 1
          log(`verify: ${ok ? 'OK' : 'FAILED'} ${JSON.stringify(report)}`)
        } catch (error) {
          log(`verify failed: ${error}`)
          process.exitCode = 1
        }
        app.quit()
      }, 12000)
    }
  })

  app.on('before-quit', () => {
    stopping = true
    modelResourceService?.stopWatching()
    if (serverChild) {
      try { serverChild.kill() } catch {}
      serverChild = null
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
