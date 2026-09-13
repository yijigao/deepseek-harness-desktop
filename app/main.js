/**
 * DeepSeek Desktop — Electron shell around the DeepSeek Harness web GUI.
 *
 * The bundled runtime (resources/runtime) is the full production closure of
 * the `dsh` CLI; the bundled node.exe (resources/node.exe) boots
 * `dsh web` on a free loopback port, and this shell opens a frameless,
 * Claude Code-styled window on top of it. Closing the window tears the
 * server down; a crash shows the log path in a dialog.
 */
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, clipboard, nativeImage, net: electronNet, crashReporter } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const { ModelResourceService } = require('./lib/model-resources/service')
const { EngineRecovery } = require('./lib/engine-recovery')
const { nativeCredentialIntegration } = require('./lib/credential-integration')
const { titlebarLogoDataUrl } = require('./lib/titlebar-logo')
const { attachRpcLifecycleLogging } = require('./lib/rpc-lifecycle')
const taskArchive = require('./lib/task-archive/service')
const { resolveWorkspacePath } = require('./lib/workspace-path')
const { isStrictlyWithin, requireTemporaryExitDiagnostics } = require('./lib/exit-diagnostics')
const { JUNCTION_REPAIR_TIMEOUT_MS, ENGINE_READY_TIMEOUT_MS, VERIFY_RENDER_DELAY_MS, SCREENSHOT_RENDER_DELAY_MS, RECOVERY_PRE_KILL_DELAY_MS, RECOVERY_POST_RESTART_DELAY_MS } = require('./lib/verification-contract')

const PRODUCT = 'DeepSeek'
const APP_ID = 'com.deepseek.desktop'
const WINDOW_BG = '#050a12'
const LOG_PATH = path.join(os.tmpdir(), 'deepseek-desktop.log')
const MAX_PINNED_SESSIONS = 50
const EXIT_DIAGNOSTICS = process.argv.includes('--diagnose-verify-exit')

let mainWindow = null
let modelSettingsWindow = null
let taskArchiveWindow = null
let modelResourceService = null
let serverChild = null
let stopping = false
let serverPort = null
let serverReadyUrl = null
let mainRpcLifecycle = null
let recoveryPrompt = false
let exitDiagnostics = null
let providerProbeState = 'not-started'
const engineRecovery = new EngineRecovery({
  publish: (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cc:engine-state', state)
  },
  restart: async () => {
    if (stopping || !mainWindow || mainWindow.isDestroyed()) return false
    if (serverChild && !serverReadyUrl) return false
    const previous = new URL(mainWindow.webContents.getURL())
    const authenticated = new URL(serverChild ? serverReadyUrl : await startServer(serverPort))
    if (stopping || !mainWindow || mainWindow.isDestroyed()) return false
    // Keep the selected conversation, but use only the new server's authentication.
    authenticated.pathname = previous.pathname
    authenticated.hash = previous.hash
    for (const [key, value] of previous.searchParams) {
      if (key !== 'token' && !authenticated.searchParams.has(key)) authenticated.searchParams.append(key, value)
    }
    attachMainRpcLifecycle(authenticated.href)
    await mainWindow.loadURL(authenticated.href)
    return true
  },
})
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
const MODEL_SETTINGS_DEMO = process.argv.includes('--demo-model-settings') || process.argv.includes('--verify-model-settings')

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`
  try { fs.appendFileSync(LOG_PATH, text) } catch {}
  if (!app.isPackaged) process.stdout.write(text)
}

function recordExitDiagnostic(phase, detail = {}) {
  if (!exitDiagnostics) return
  const entry = {
    phase, at: new Date().toISOString(), pid: process.pid,
    serverChild: Boolean(serverChild), providerProbe: providerProbeState,
    resources: modelResourceService?.getLifecycleState?.() ?? null,
    ...detail,
  }
  exitDiagnostics.events.push(entry)
  try { fs.appendFileSync(exitDiagnostics.timelinePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 }) } catch {}
  console.log(`EXIT-DIAGNOSTIC ${JSON.stringify(entry)}`)
}

function configureExitDiagnostics() {
  if (!process.argv.includes('--verify')) throw new Error('Exit diagnostics requires --verify')
  const isolated = requireTemporaryExitDiagnostics({ app, env: process.env, tempDir: os.tmpdir(), dshHome: dshHomePath() })
  fs.mkdirSync(isolated.crashDumps, { recursive: true, mode: 0o700 })
  app.setPath('crashDumps', isolated.crashDumps)
  // No submit URL plus uploadToServer=false keeps the diagnostic strictly local.
  crashReporter.start({ productName: 'DeepSeek Exit Diagnostics', companyName: 'DeepSeek Harness Desktop', submitURL: '', uploadToServer: false, compress: false })
  return { ...isolated, events: [] }
}

if (EXIT_DIAGNOSTICS) {
  exitDiagnostics = configureExitDiagnostics()
  recordExitDiagnostic('diagnostics-configured', { uploadsDisabled: true, crashDumpsLocal: true })
  process.on('exit', () => recordExitDiagnostic('process-exit', { exitCode: process.exitCode ?? 0 }))
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

function probeProviderResources() {
  if (EXIT_DIAGNOSTICS) {
    providerProbeState = 'running'
    recordExitDiagnostic('provider-probe-started')
  }
  return new Promise((resolve) => {
    const child = spawn(nodeExePath(), ['--use-env-proxy', toolPath('model-resource-probe.mjs'), resolveRuntimeRoot(), dshHomePath()], {
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
      if (EXIT_DIAGNOSTICS) { providerProbeState = 'error'; recordExitDiagnostic('provider-probe-error') }
      clearTimeout(timer)
      resolve({ ok: false, code: 'PROBE_FAILED' })
    })
    child.once('exit', () => {
      if (EXIT_DIAGNOSTICS) { providerProbeState = 'exited'; recordExitDiagnostic('provider-probe-exit') }
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
  const workspace = resolveWorkspacePath({
    app, env, argv: process.argv, tempDir: os.tmpdir(), dshHome: env.DSH_HOME,
  })
  env.DSH_WORKSPACE = workspace
  if (EXIT_DIAGNOSTICS) {
    if (!isStrictlyWithin(exitDiagnostics.temporary, workspace)) throw new Error('Exit diagnostics workspace escaped TEMP')
    recordExitDiagnostic('workspace-resolved', { workspaceTemporary: true })
  }

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
      timeout: JUNCTION_REPAIR_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (fix.stdout) log(`[fix] ${String(fix.stdout).trimEnd()}`)
    if (fix.stderr) log(`[fix!] ${String(fix.stderr).trimEnd()}`)
    if (fix.status !== 0) {
      throw new Error(`runtime junction repair failed (status ${fix.status})`)
    }
  }

  log(`spawning node ${binJs} web --port ${port} (workspace=${workspace})`)
  serverChild = spawn(nodeExe, ['--use-env-proxy', binJs, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const child = serverChild
  serverReadyUrl = null
  let stdout = ''
  let resolveReadyUrl
  let rejectReadyUrl
  const readyUrl = new Promise((resolve, reject) => {
    resolveReadyUrl = resolve
    rejectReadyUrl = reject
  })
  const readyTimer = setTimeout(() => {
    rejectReadyUrl(new Error(`server did not report its authenticated URL within ${ENGINE_READY_TIMEOUT_MS}ms`))
    try { child.kill() } catch {}
  }, ENGINE_READY_TIMEOUT_MS)
  child.once('error', (error) => {
    clearTimeout(readyTimer)
    rejectReadyUrl(error)
    if (serverChild === child) serverChild = null
    if (!stopping) engineRecovery.failed()
  })
  serverChild.stdout.on('data', (chunk) => {
    const text = String(chunk)
    stdout = `${stdout}${text}`.slice(-8192)
    log(`[dsh] ${text.trimEnd()}`)
    const match = /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)
    if (!match) return
    try {
      const parsed = new URL(match[1])
      if (parsed.hostname !== '127.0.0.1' || parsed.port !== String(port)) return
      clearTimeout(readyTimer)
      serverReadyUrl = parsed.href
      resolveReadyUrl(parsed.href)
    } catch {}
  })
  serverChild.stderr.on('data', (chunk) => log(`[dsh!] ${String(chunk).trimEnd()}`))
  serverChild.on('exit', (code, signal) => {
    recordExitDiagnostic('server-child-exit', { code: code ?? null, signal: signal ?? null })
    clearTimeout(readyTimer)
    rejectReadyUrl(new Error('server exited before reporting its authenticated URL'))
    log(`dsh server exited (code=${code}, signal=${signal})`)
    if (serverChild !== child) return
    serverChild = null
    serverReadyUrl = null
    if (!stopping) {
      engineRecovery.failed()
    }
  })
  return readyUrl
}

function injectDesktopFrame(win) {
  const inject = () => {
    const themeCss = [
      readInjected(path.join('themes', 'deepsea-palette.css')),
      readInjected(path.join('themes', 'deepsea-adapter.css')),
    ].filter(Boolean).join('\n')
    const titlebarJs = readInjected('titlebar.js')
      .replace('__DEEPSEEK_LOGO_DATA_URL__', titlebarLogoDataUrl(__dirname, process.resourcesPath, app.isPackaged))
    if (themeCss) win.webContents.insertCSS(themeCss, { cssOrigin: 'author' }).catch(() => {})
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

function attachMainRpcLifecycle(engineUrl) {
  mainRpcLifecycle?.dispose()
  mainRpcLifecycle = null
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainRpcLifecycle = attachRpcLifecycleLogging({
      webRequest: mainWindow.webContents.session.webRequest,
      engineOrigin: engineUrl,
      log,
    })
  } catch {
    // Request diagnostics are optional and must never block the UI or engine.
  }
}

async function createWindow(authenticatedUrl) {
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
  mainWindow.on('closed', () => {
    recordExitDiagnostic('main-window-closed')
    mainRpcLifecycle?.dispose()
    mainRpcLifecycle = null
    mainWindow = null
  })

  const base = new URL('/', authenticatedUrl).href
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(base)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(base)) event.preventDefault()
  })

  injectDesktopFrame(mainWindow)
  attachMainRpcLifecycle(authenticatedUrl)
  await mainWindow.loadURL(authenticatedUrl)
  // A hidden Windows launch can finish navigation without a first-paint
  // ready-to-show notification. Successful navigation must still reveal it.
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
}

function isTrustedSender(event, win) {
  return Boolean(
    win
    && !win.isDestroyed()
    && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame
  )
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
  const native = nativeCredentialIntegration(resolveRuntimeRoot())
  if (native) {
    cachedPatchStatus = native
    return Promise.resolve(native)
  }
  if (!fs.existsSync(toolPath('patch-pi-ai-oauth.mjs'))) {
    cachedPatchStatus = { ok: null, detail: '当前版本未提供旧补丁检查器；不据此判断账号失效。' }
    return Promise.resolve(cachedPatchStatus)
  }
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
    backgroundColor: '#050a12',
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

async function createTaskArchiveWindow() {
  if (taskArchiveWindow && !taskArchiveWindow.isDestroyed()) {
    taskArchiveWindow.show()
    taskArchiveWindow.focus()
    return
  }
  taskArchiveWindow = new BrowserWindow({
    width: 980, height: 780, minWidth: 760, minHeight: 580, show: false,
    backgroundColor: WINDOW_BG, icon: iconPath(), title: '任务档案与批次验收', autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      preload: path.join(__dirname, 'task-archive', 'preload.js'),
    },
  })
  const archiveHtml = path.join(__dirname, 'task-archive', 'index.html')
  const archiveUrl = pathToFileURL(archiveHtml).href
  taskArchiveWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  taskArchiveWindow.webContents.on('will-navigate', (event, url) => { if (url !== archiveUrl) event.preventDefault() })
  taskArchiveWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  taskArchiveWindow.once('ready-to-show', () => taskArchiveWindow?.show())
  taskArchiveWindow.on('closed', () => { taskArchiveWindow = null })
  await taskArchiveWindow.loadFile(archiveHtml)
}

function trustedSettingsHandler(operation) {
  return async (event, ...args) => {
    if (!isTrustedSender(event, modelSettingsWindow)) throw new Error('Settings request denied')
    return operation(...args)
  }
}

function trustedTaskArchiveHandler(operation) {
  return async (event, ...args) => {
    if (!isTrustedSender(event, taskArchiveWindow)) throw new Error('Task archive request denied')
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

/** Only qualified Desktop artifacts may authorize an update, not upstream tags. */
async function checkForUpdates() {
  // A remote channel must be explicitly provisioned with a trust policy first.
  return { updateAvailable: false, channel: 'qualified-artifacts', status: 'channel-not-configured', build: readBuildInfo() }
}

// ---- single instance -------------------------------------------------------

// The disposable, TEMP-guarded exit diagnostic needs to coexist with the
// user's running Desktop instance. Normal launches retain the single lock.
const gotLock = EXIT_DIAGNOSTICS ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const targetWindow = MODEL_SETTINGS_DEMO ? modelSettingsWindow : mainWindow
    if (targetWindow) {
      if (targetWindow.isMinimized()) targetWindow.restore()
      targetWindow.show()
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
  ipcMain.handle('cc:engine-state', (event) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Untrusted sender')
    return { state: engineRecovery.state }
  })
  ipcMain.handle('cc:recover-engine', async (event) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Untrusted sender')
    if (recoveryPrompt || engineRecovery.pending || engineRecovery.state === 'online') return false
    recoveryPrompt = true
    try {
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: PRODUCT,
        message: '重新连接引擎将刷新当前页面。请先复制未发送的草稿。',
        detail: '保留当前会话入口，不会自动重发消息或重新执行任务。连接后请核对任务进度再继续。',
        buttons: ['暂不恢复', '重新连接'], defaultId: 0, cancelId: 0,
      })
      return answer.response === 1 && !stopping ? engineRecovery.recover() : false
    } finally { recoveryPrompt = false }
  })
  ipcMain.handle('cc:get-session-pins', (event) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Session pin request denied')
    return readSessionPins()
  })
  ipcMain.handle('cc:set-session-pins', (event, value) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Session pin update denied')
    return writeSessionPins(value)
  })
  ipcMain.handle('cc:write-clipboard', (event, value) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Clipboard request denied')
    if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) return false
    clipboard.writeText(value)
    return true
  })
  ipcMain.handle('cc:model-resources', (event) => {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Resource request denied')
    modelResourceService?.scheduleRefresh().catch(() => {})
    return modelResourceService?.getCachedSnapshot() ?? null
  })
  ipcMain.on('cc:open-model-settings', (event) => {
    if (!isTrustedSender(event, mainWindow)) return
    createModelSettingsWindow().catch(() => dialog.showErrorBox(PRODUCT, '无法打开模型资源中心。'))
  })
  ipcMain.on('cc:open-task-archive', (event) => {
    if (!isTrustedSender(event, mainWindow)) return
    createTaskArchiveWindow().catch(() => dialog.showErrorBox(PRODUCT, '无法打开任务档案。'))
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
  ipcMain.handle('task-archive:bind', trustedTaskArchiveHandler(async (metadata) => {
    const picked = await dialog.showOpenDialog(taskArchiveWindow, {
      title: '选择原始任务清单', properties: ['openFile'],
      filters: [{ name: 'Task manifests', extensions: ['json', 'csv'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return taskArchive.bind(dshHomePath(), picked.filePaths[0], metadata && typeof metadata === 'object' ? metadata : {})
  }))
  ipcMain.handle('task-archive:list', trustedTaskArchiveHandler(() => taskArchive.listArchives(dshHomePath())))
  ipcMain.handle('task-archive:read', trustedTaskArchiveHandler((taskId) => taskArchive.view(dshHomePath(), taskId)))
  ipcMain.handle('task-archive:checkpoint', trustedTaskArchiveHandler((taskId, revision, metadata) => taskArchive.checkpoint(dshHomePath(), taskId, revision, metadata)))
  ipcMain.handle('task-archive:inspect', trustedTaskArchiveHandler((taskId, itemId) => taskArchive.itemDetails(dshHomePath(), taskId, itemId)))
  ipcMain.handle('task-archive:accept', trustedTaskArchiveHandler((taskId, itemId, sourceSha256, manifestSha256, artifactSha256) => taskArchive.accept(dshHomePath(), taskId, itemId, sourceSha256, manifestSha256, artifactSha256)))
  ipcMain.handle('task-archive:retry-plan', trustedTaskArchiveHandler((taskId) => taskArchive.retryPlan(dshHomePath(), taskId)))

  // ---- lifecycle -------------------------------------------------------------

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    Menu.setApplicationMenu(null)
    modelResourceService = new ModelResourceService({
      dshHome: dshHomePath(),
      probeProviderResources: MODEL_SETTINGS_DEMO && process.env.MODEL_RESOURCES_LIVE !== '1' ? null : probeProviderResources,
    })
    modelResourceService.on('updated', publishModelResources)
    if (MODEL_SETTINGS_DEMO) {
      modelResourceService.startWatching()
      setTimeout(() => modelResourceService?.scheduleRefresh({ force: true }).catch(() => {}), 250)
    }
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
      serverPort = port
      const readyUrl = startServer(port)
      await waitForHttp(port, ENGINE_READY_TIMEOUT_MS)
      await createWindow(await readyUrl)
      log('window ready')
      modelResourceService.startWatching()
      setTimeout(() => {
        if (!stopping) modelResourceService?.scheduleRefresh().catch(() => {})
      }, 5_000)
    } catch (error) {
      log(`startup failed: ${error && error.stack ? error.stack : String(error)}`)
      dialog.showErrorBox(
        PRODUCT,
        `Could not start the DeepSeek engine.\n\n${String(error && error.message ? error.message : error)}\n\nLog: ${LOG_PATH}`,
      )
      app.quit()
      return
    }

    // Destructive failure injection is restricted to an isolated temporary home.
    if (process.argv.includes('--verify-engine-recovery')) {
      try {
        const home = path.resolve(dshHomePath())
        if (!home.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error('Recovery verification requires a temporary DSH_HOME')
        const win = mainWindow
        await delay(RECOVERY_PRE_KILL_DELAY_MS)
        await win.webContents.executeJavaScript("document.body.dataset.recoveryDraft = 'synthetic-unsent-draft'")
        const child = serverChild
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill()
        await exited
        const retained = win === mainWindow && !win.isDestroyed()
          && await win.webContents.executeJavaScript("document.body.dataset.recoveryDraft === 'synthetic-unsent-draft'")
        const offline = engineRecovery.state === 'offline'
        const recovered = await engineRecovery.recover()
        await delay(RECOVERY_POST_RESTART_DELAY_MS)
        const frame = await win.webContents.executeJavaScript("Boolean(document.getElementById('cc-titlebar'))")
        const report = { retained, offline, recovered, frame, sameWindow: win === mainWindow }
        console.log(`ENGINE-RECOVERY-VERIFY ${JSON.stringify(report)}`)
        process.exitCode = Object.values(report).every(Boolean) ? 0 : 1
      } catch (error) {
        process.exitCode = 1
        console.log(`ENGINE-RECOVERY-VERIFY failed: ${error.message}`)
      }
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

    // Keep isolated verification free of update network traffic and prompts.
    // Normal launches still check for major releases shortly after startup.
    const verificationRun = process.argv.some(arg => arg === '--verify' || arg.startsWith('--verify-') || arg.startsWith('--shot='))
    if (!verificationRun) setTimeout(async () => {
      const result = await checkForUpdates()
      log(`update check: ${JSON.stringify(result)}`)
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
      }, SCREENSHOT_RENDER_DELAY_MS)
    }

    // --verify: programmatic UI check — sample computed styles and print JSON,
    // Exit 0 when the DeepSea Signal theme + title bar are applied.
    if (process.argv.includes('--verify')) {
      setTimeout(async () => {
        try {
          const report = await mainWindow.webContents.executeJavaScript(`(() => {
            const bar = document.getElementById('cc-titlebar')
            const bodyStyle = getComputedStyle(document.body)
            const accent = bodyStyle.getPropertyValue('--dsw-alias-brand-primary').trim()
            return {
              titlebarPresent: Boolean(bar),
              desktopActions: Array.from(bar?.querySelectorAll('[data-act]') || [], (button) => button.dataset.act),
              logoLoaded: Boolean(bar?.querySelector('.cc-mark')?.complete && bar.querySelector('.cc-mark').naturalWidth > 0),
              appContentPresent: Boolean(document.body.innerText.replace(bar?.innerText || '', '').trim()),
              viewportOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
              darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
              bodyBg: bodyStyle.backgroundColor,
              bodyPaddingTop: bodyStyle.paddingTop,
              accent,
              titlebarBg: bar ? getComputedStyle(bar).backgroundColor : null,
              mark: bar && bar.querySelector('.cc-mark') ? bar.querySelector('.cc-mark').textContent : null,
            }
          })()`)
          const themeOk = !report.darkAttr
            || String(report.accent) === '#4d8dff'
            || String(report.accent).includes('77, 141, 255')
          const ok = report.titlebarPresent
            && JSON.stringify(report.desktopActions) === JSON.stringify(['tasks', 'settings', 'resources', 'recover', 'min', 'max', 'close'])
            && report.logoLoaded
            && report.appContentPresent
            && !report.viewportOverflow
            && report.titlebarBg === 'rgb(5, 10, 18)'
            && themeOk
          console.log(`VERIFY ${JSON.stringify(report)}`)
          recordExitDiagnostic('verify-emitted', { ok })
          process.exitCode = ok ? 0 : 1
          log(`verify: ${ok ? 'OK' : 'FAILED'} ${JSON.stringify(report)}`)
        } catch (error) {
          log(`verify failed: ${error}`)
          process.exitCode = 1
        }
        app.quit()
      }, VERIFY_RENDER_DELAY_MS)
    }
  })

  app.on('before-quit', () => {
    recordExitDiagnostic('before-quit')
    stopping = true
    engineRecovery.close()
    modelResourceService?.stopWatching()
    if (serverChild) {
      try { serverChild.kill() } catch {}
      serverChild = null
    }
  })

  app.on('window-all-closed', () => {
    recordExitDiagnostic('window-all-closed')
    app.quit()
  })
  app.on('will-quit', () => recordExitDiagnostic('will-quit'))
  app.on('quit', () => recordExitDiagnostic('quit'))
}
