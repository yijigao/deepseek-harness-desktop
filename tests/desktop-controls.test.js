'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const appRoot = path.resolve(__dirname, '../app')

test('desktop preload retains working resources, window, clipboard and pin bridges without Lab', async () => {
  const bridges = {}
  const calls = []
  const ipcRenderer = {
    send: (...args) => { calls.push(args) },
    invoke: async (...args) => { calls.push(args); return true },
    on: () => {},
  }
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, 'preload.js'), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron')
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, api) => { bridges[name] = api } } }
    },
  })
  assert.ok(!Object.hasOwn(bridges.ccDesktop, 'openHarnessLab'))
  bridges.ccDesktop.openModelSettings()
  bridges.ccDesktop.openTaskArchive()
  bridges.ccDesktop.minimize()
  bridges.ccDesktop.toggleMaximize()
  bridges.ccDesktop.close()
  await bridges.ccDesktop.getModelResources()
  await bridges.ccDesktop.recoverEngine()
  await bridges.ccDesktop.setPinnedSessions(['synthetic-session'])
  await bridges.dshHost.clipboard.writeText('synthetic-text')
  assert.deepEqual(calls, [
    ['cc:open-model-settings'], ['cc:open-task-archive'], ['cc:min'], ['cc:max'], ['cc:close'],
    ['cc:model-resources'], ['cc:recover-engine'],
    ['cc:set-session-pins', ['synthetic-session']], ['cc:write-clipboard', 'synthetic-text'],
  ])
})

test('main process registers the active desktop surfaces without loading or exposing Lab', async () => {
  const channels = []
  const handlers = new Map()
  const imports = []
  const mainPath = path.join(appRoot, 'main.js')
  const requireApp = createRequire(mainPath)
  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      on: () => {},
      whenReady: () => ({ then: () => {} }),
    },
    ipcMain: {
      on: (channel) => channels.push(channel),
      handle: (channel, handler) => { channels.push(channel); handlers.set(channel, handler) },
    },
  }
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
    __dirname: appRoot,
    process: { env: {}, argv: [] },
    require: (name) => {
      imports.push(name)
      return name === 'electron' ? electron : requireApp(name)
    },
  })
  assert.ok(!imports.some((name) => name.includes('harness-lab')))
  assert.ok(!channels.some((name) => name.includes('harness-lab')))
  for (const channel of ['cc:open-model-settings', 'cc:open-task-archive', 'cc:model-resources', 'cc:recover-engine', 'cc:write-clipboard', 'cc:set-session-pins', 'task-archive:bind', 'task-archive:list', 'task-archive:accept']) {
    assert.ok(channels.includes(channel), channel)
  }
  await assert.rejects(handlers.get('task-archive:read')({ sender: {}, senderFrame: {} }, 'not-a-task'), /Task archive request denied/)
})
