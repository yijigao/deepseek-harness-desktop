'use strict'
// Run with Electron, not Node. Uses the real production window, preload and IPC
// handlers; suppresses only application boot/engine startup and the native picker.
const electron = require('electron')
const { app, BrowserWindow } = electron
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Module, createRequire } = require('node:module')

const appRoot = path.resolve(process.argv[2] || path.join(__dirname, '../app'))
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-task-window-'))
const taskHome = path.join(evidence, 'home')
fs.mkdirSync(taskHome)
const previousTestMode = process.env.DSH_TEST_MODE
process.env.DSH_HOME = taskHome
process.env.DSH_TEST_MODE = '1'
app.setPath('userData', path.join(evidence, 'userdata'))
// Retain this disposable verifier between closing and reopening the task window.
app.on('window-all-closed', () => {})
const manifest = path.join(evidence, 'manifest.json')
const artifact = path.join(evidence, 'image.png')
const service = require(path.join(appRoot, 'lib/task-archive/service.js'))
// Reuse a local, non-business raster fixture; no model/image generation call.
const fixtureImage = path.join(evidence, 'synthetic-main-image.png')
fs.writeFileSync(fixtureImage, electron.nativeImage.createFromPath(path.resolve(__dirname, '../app/build/icon-preview.png')).resize({ width: 1200, height: 1200 }).toPNG())
fs.copyFileSync(fixtureImage, artifact)
fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, items: [
  { itemId: 'SYNTHETIC-DONE', status: 'succeeded', artifactPath: 'image.png', evidence: [{ note: 'Synthetic UI test only' }], diff: { before: 'fixture', after: 'fixture' } },
  { itemId: 'SYNTHETIC-FAILED', status: 'failed', error: 'Synthetic retry case', nextAction: 'Review fixture' },
] }))

const source = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8')
const requireApp = createRequire(path.join(appRoot, 'main.js'))
const moduleUnderTest = new Module(path.join(appRoot, 'main.js'), module)
moduleUnderTest.filename = path.join(appRoot, 'main.js')
const appFacade = new Proxy(app, {
  get(target, key) {
    if (key === 'requestSingleInstanceLock') return () => true
    if (key === 'whenReady') return () => ({ then: () => {} })
    if (key === 'on') return (event, fn) => { if (event !== 'window-all-closed') target.on(event, fn) }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
const windows = []
class HiddenWindow extends BrowserWindow {
  constructor(options) {
    super(options)
    windows.push(this)
    this.show = () => {}
    this.focus = () => {}
  }
}
const testElectron = { ...electron, app: appFacade, BrowserWindow: HiddenWindow, dialog: { ...electron.dialog, showOpenDialog: async () => ({ canceled: false, filePaths: [manifest] }) } }
moduleUnderTest.require = name => name === 'electron' ? testElectron : requireApp(name)
// Native Electron handles must remain in their original V8 realm; a vm context
// would create WebFrameMain wrappers without Electron's internal prototype.
moduleUnderTest._compile(source + '\nmodule.exports = { createTaskArchiveWindow, getWindow: () => taskArchiveWindow };', path.join(appRoot, 'main.js'))
const production = moduleUnderTest.exports
const report = { checkedAt: new Date().toISOString(), appRoot, evidence, realEngineStarted: false, nativePickerStubbed: true, checks: {} }
let window
const evaluate = code => window.webContents.executeJavaScript(code)
async function waitFor(code, label) {
  const deadline = Date.now() + 7000
  do {
    if (await evaluate(code)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}; feedback=${await evaluate("document.getElementById('feedback')?.textContent")}`)
}
const selectItem = () => evaluate("[...document.querySelectorAll('#items .item')].find(x => x.firstElementChild.textContent === 'SYNTHETIC-DONE').click()")
async function main() {
  await app.whenReady()
  await production.createTaskArchiveWindow()
  window = production.getWindow()
  const preferences = window.webContents.getLastWebPreferences()
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  report.checks.sandbox = true
  await waitFor("Boolean(window.taskArchive?.list) && document.querySelector('#archives option')?.textContent !== '加载中…'", 'preload/list')
  await evaluate("document.getElementById('title').value = '合成批次 · 非真实商品'; document.getElementById('goal').value = '核验恢复、图片预览、验收与失败计划'; document.getElementById('bind').click()")
  await waitFor("document.querySelectorAll('#items .item').length === 2", 'bind and render')
  const tasks = service.listArchives(taskHome)
  assert.equal(tasks.length, 1)
  const taskId = tasks[0].taskId
  report.checks.realIpcBind = true
  await selectItem()
  await waitFor("!document.getElementById('artifact-image').hidden && document.getElementById('artifact-image').complete && document.getElementById('artifact-image').naturalWidth > 0", 'decoded raster preview')
  report.checks.rasterDecoded = true
  const inspected = service.itemDetails(taskHome, taskId, 'SYNTHETIC-DONE')
  const before = service.view(taskHome, taskId)
  fs.appendFileSync(artifact, Buffer.from('\nsynthetic-artifact-only-change'))
  const staleRejected = await evaluate(`window.taskArchive.accept(${JSON.stringify(taskId)}, 'SYNTHETIC-DONE', ${JSON.stringify(inspected.item.sourceSha256)}, ${JSON.stringify(before.manifest.sha256)}, ${JSON.stringify(inspected.artifact.sha256)}).then(() => false, error => /changed|conflict/i.test(error.message))`)
  assert.equal(staleRejected, true)
  assert.equal(service.view(taskHome, taskId).items[0].acceptance.valid, false)
  report.checks.staleArtifactRejected = true
  fs.copyFileSync(fixtureImage, artifact)
  await selectItem()
  await waitFor("!document.getElementById('accept').disabled", 'accept enabled after fresh preview')
  await evaluate("document.getElementById('accept').click()")
  await waitFor("document.getElementById('feedback').textContent.includes('验收已锁定')", 'accept through renderer')
  assert.equal(service.view(taskHome, taskId).items[0].acceptance.valid, true)
  report.checks.realIpcAcceptance = true
  await new Promise(resolve => { window.once('closed', resolve); window.close() })
  await production.createTaskArchiveWindow()
  window = production.getWindow()
  await waitFor("document.querySelectorAll('#archives option').length === 2", 'existing archive after reopen')
  await evaluate(`document.getElementById('archives').value = ${JSON.stringify(taskId)}; document.getElementById('open').click()`)
  await waitFor("document.getElementById('stats').textContent.includes('已锁定 1')", 'retained acceptance after reopen')
  assert.equal(service.listArchives(taskHome).length, 1)
  report.checks.reopenPreservesTaskAndAcceptance = true
  await evaluate("document.getElementById('retry').click()")
  await waitFor("document.getElementById('feedback').textContent.includes('1 个失败项')", 'retry plan')
  const requestFiles = fs.readdirSync(path.join(taskHome, 'task-archives')).filter(name => /^retry-.*\.json$/.test(name))
  assert.equal(requestFiles.length, 1)
  const request = JSON.parse(fs.readFileSync(path.join(taskHome, 'task-archives', requestFiles[0]), 'utf8'))
  assert.deepEqual(request.itemIds, ['SYNTHETIC-FAILED'])
  assert.equal(request.manifestSha256, before.manifest.sha256)
  report.checks.failedOnlyPlan = true
  // A separate renderer using the same preload must still be denied by the
  // production trusted-sender guard; merely knowing taskId is insufficient.
  const outsider = new HiddenWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(appRoot, 'task-archive/preload.js') } })
  await outsider.loadFile(path.join(appRoot, 'task-archive/index.html'))
  assert.equal(await outsider.webContents.executeJavaScript(`window.taskArchive.read(${JSON.stringify(taskId)}).then(() => false, error => /denied/i.test(error.message))`), true)
  outsider.close()
  report.checks.untrustedRendererDenied = true
  await selectItem()
  await waitFor("document.getElementById('artifact-image').complete && document.getElementById('artifact-image').naturalWidth > 0", 'final preview')
  // Hidden renderers may retain an earlier compositor frame despite live DOM
  // updates. Paint offscreen without activating any user-facing window.
  window.setPosition(-20000, -20000)
  window.showInactive()
  await evaluate("document.getElementById('detail-section').scrollIntoView()")
  await new Promise(resolve => setTimeout(resolve, 250))
  report.previewLayout = await evaluate("({ documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth, imageWidth: document.getElementById('artifact-image').getBoundingClientRect().width, imageNaturalWidth: document.getElementById('artifact-image').naturalWidth })")
  await fs.promises.writeFile(path.join(evidence, 'task-window.png'), (await window.webContents.capturePage()).toPNG())
  assert.ok(report.previewLayout.documentWidth <= report.previewLayout.viewportWidth, 'Raster preview must not create horizontal overflow')
  report.checks.noHorizontalOverflow = true
  report.ok = true
}
main().catch(error => { report.ok = false; report.error = error.stack || error.message; process.exitCode = 1 }).finally(async () => {
  fs.writeFileSync(path.join(evidence, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('TASK-WINDOW-VERIFY ' + JSON.stringify(report))
  for (const win of windows) if (!win.isDestroyed()) win.destroy()
  if (previousTestMode == null) delete process.env.DSH_TEST_MODE
  else process.env.DSH_TEST_MODE = previousTestMode
  app.exit(report.ok ? 0 : 1)
})
