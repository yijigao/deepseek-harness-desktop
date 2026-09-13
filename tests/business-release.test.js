'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')

test('release ships the same archive service outside ASAR for the standalone Node CLI', t => {
  const module = { exports: {} }
  const sandbox = {
    module, __dirname: root,
    process: { env: { DSH_RELEASE_RUNTIME: path.join(root, 'synthetic-runtime'), DSH_RELEASE_NODE: process.execPath } },
    require(name) {
      if (name === 'node:fs') return { existsSync: target => !target.endsWith('desktop-release.json') }
      if (name.startsWith('./')) return require(path.join(root, name))
      return require(name)
    },
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron-builder.release.cjs'), 'utf8'), sandbox)
  const resources = module.exports.extraResources
  const cli = resources.find(item => item.to === 'tools/task-archive/cli.cjs')
  const service = resources.find(item => item.to === 'tools/task-archive/lib/task-archive/service.js')
  assert.equal(cli.from, path.join(root, 'scripts/task-archive/cli.cjs'))
  assert.equal(service.from, path.join(root, 'app/lib/task-archive/service.js'))
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-business-release-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  for (const resource of [cli, service]) {
    const target = path.join(temp, 'resources', resource.to)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(resource.from, target)
  }
  const manifest = path.join(temp, 'manifest.json')
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, items: [{ itemId: 'SYNTHETIC-001', status: 'pending' }] }))
  const run = args => {
    const result = spawnSync(process.execPath, [path.join(temp, 'resources/tools/task-archive/cli.cjs'), ...args], { env: { ...process.env, DSH_HOME: path.join(temp, 'home') }, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const bound = run(['bind', '--manifest', manifest, '--title', 'Synthetic packaged CLI'])
  const viewed = run(['show', bound.archive.taskId])
  assert.equal(viewed.manifest.sha256, bound.manifest.sha256)
  assert.equal(viewed.items[0].itemId, 'SYNTHETIC-001')
  assert.equal(fs.existsSync(path.join(temp, 'app')), false, 'CLI must not depend on the development source tree')
})
