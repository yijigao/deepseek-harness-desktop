/**
 * DeepSeek Desktop — Electron shell around the DeepSeek Harness web GUI.
 *
 * The bundled runtime (resources/runtime) is the full production closure of
 * the `dsh` CLI; the bundled node.exe (resources/node.exe) boots
 * `dsh web` on a free loopback port, and this shell opens a frameless,
 * Claude Code-styled window on top of it. Closing the window tears the
 * server down; a crash shows the log path in a dialog.
 */
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, net: electronNet } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const { HarnessLabSessionService } = require('./lib/harness-lab/session-service')

const PRODUCT = 'DeepSeek'
const APP_ID = 'com.deepseek.desktop'
const WINDOW_BG = '#1f1e1d'
const LOG_PATH = path.join(os.tmpdir(), 'deepseek-desktop.log')

let mainWindow = null
let harnessLabWindow = null
let modelSettingsWindow = null
let harnessLabService = null
let serverChild = null
let stopping = false
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
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', name)
    : path.join(__dirname, '..', name === 'patch-pi-ai-oauth.mjs' ? 'scripts' : 'config-example', name)
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

function patchStatus() {
  const result = spawnSync(nodeExePath(), [toolPath('patch-pi-ai-oauth.mjs'), resolveRuntimeRoot(), '--check'], {
    windowsHide: true,
    timeout: 30000,
    encoding: 'utf8',
  })
  return { ok: result.status === 0, detail: String(result.stdout || result.stderr || '').trim().slice(0, 300) }
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
    patch: patchStatus(),
  }
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
    title: 'Models & Health',
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
          selectRun(0, 'a')
          selectRun(1, 'b')
          document.getElementById('compare-selected')?.click()
        }
      })()`)
      const report = await waitForHarnessLab(win, (candidate) => (
        candidate.compareVisible && candidate.summaryCards === 6 && candidate.divergences >= 4
      ))
      const ok = report.title === 'Harness Lab'
        && report.runRows === 2
        && report.summaryCards === 6
        && report.divergences >= 4
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
      throw new Error('Harness Lab request failed')
    }
  }
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
  ipcMain.on('cc:open-harness-lab', (event) => {
    if (!isTrustedSender(event, mainWindow)) return
    createHarnessLabWindow().catch(() => {
      dialog.showErrorBox('Harness Lab', 'Could not open the local Harness Lab window.')
    })
  })
  ipcMain.on('cc:open-model-settings', (event) => {
    if (!isTrustedSender(event, mainWindow)) return
    createModelSettingsWindow().catch(() => dialog.showErrorBox(PRODUCT, 'Could not open Models & Health.'))
  })
  ipcMain.handle('model-settings:health', trustedSettingsHandler(() => modelHealth()))
  ipcMain.handle('model-settings:login', trustedSettingsHandler(() => runOAuthLogin()))
  ipcMain.handle('model-settings:open-home', trustedSettingsHandler(() => {
    fs.mkdirSync(dshHomePath(), { recursive: true })
    return shell.openPath(dshHomePath())
  }))

  ipcMain.handle('harness-lab:list-runs', harnessLabHandler((service) => service.listRuns()))
  ipcMain.handle('harness-lab:get-run', harnessLabHandler((service, runId) => service.getRun(runId)))
  ipcMain.handle('harness-lab:compare-runs', harnessLabHandler((service, runAId, runBId) => service.compare(runAId, runBId)))

  // ---- lifecycle -------------------------------------------------------------

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    Menu.setApplicationMenu(null)
    harnessLabService = new HarnessLabSessionService({
      demoMode: HARNESS_LAB_DEMO,
      demoDir: harnessLabDemoDir(),
    })
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
            cards: document.querySelectorAll('#health .card').length,
            loginButton: Boolean(document.getElementById('login')),
            bodyBg: getComputedStyle(document.body).backgroundColor,
          }))()`)
          const ok = report.title === '模型与运行健康' && report.cards >= 7 && report.loginButton
          console.log(`MODEL-SETTINGS-VERIFY ${JSON.stringify(report)}`)
          process.exitCode = ok ? 0 : 1
          app.quit()
        }
      } catch (error) {
        log(`Models & Health demo failed: ${String(error && error.message ? error.message : error)}`)
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
    if (serverChild) {
      try { serverChild.kill() } catch {}
      serverChild = null
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
