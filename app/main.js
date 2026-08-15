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

const PRODUCT = 'DeepSeek'
const APP_ID = 'com.deepseek.desktop'
const WINDOW_BG = '#1f1e1d'
const LOG_PATH = path.join(os.tmpdir(), 'deepseek-desktop.log')

let mainWindow = null
let serverChild = null
let stopping = false

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`
  try { fs.appendFileSync(LOG_PATH, text) } catch {}
  if (!app.isPackaged) process.stdout.write(text)
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
    const titlebarJs = readInjected('titlebar.js')
    if (themeCss) win.webContents.insertCSS(themeCss, { cssOrigin: 'author' }).catch(() => {})
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
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

  // ---- lifecycle -------------------------------------------------------------

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    Menu.setApplicationMenu(null)
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

    // --shot=<path>: capture a screenshot and exit (visual aid).
    const shotArg = process.argv.find((arg) => arg.startsWith('--shot='))
    if (shotArg) {
      const target = shotArg.slice('--shot='.length)
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage()
          fs.writeFileSync(target, image.toPNG())
          log(`screenshot written: ${target}`)
        } catch (error) {
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
