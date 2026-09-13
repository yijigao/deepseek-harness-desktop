'use strict'

const fs = require('node:fs')
const path = require('node:path')

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function existingRealPath(target) { try { return fs.realpathSync(target) } catch { return path.resolve(target) } }

function futureRealPath(target) {
  let ancestor = path.resolve(target)
  const remainder = []
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return ancestor
    remainder.unshift(path.basename(ancestor))
    ancestor = parent
  }
  return path.resolve(existingRealPath(ancestor), ...remainder)
}

function isStrictlyWithin(root, target) {
  const realRoot = existingRealPath(root)
  const realTarget = futureRealPath(target)
  return path.resolve(realRoot) !== path.resolve(realTarget) && isWithin(realRoot, realTarget)
}

function requireFreshTemporaryPath(temporary, name) {
  const target = path.join(temporary, name)
  if (fs.existsSync(target) || !isStrictlyWithin(temporary, target)) {
    throw new Error(`Exit diagnostics requires a new ${name} inside TEMP`)
  }
  return target
}

function requireTemporaryExitDiagnostics({ app, env, tempDir, dshHome }) {
  if (env.DSH_TEST_MODE !== '1') throw new Error('Exit diagnostics requires DSH_TEST_MODE=1')
  const temporary = path.resolve(tempDir)
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DSH_HOME']) {
    if (!env[key] || !path.isAbsolute(env[key]) || !isStrictlyWithin(temporary, env[key])) {
      throw new Error(`Exit diagnostics requires ${key} inside TEMP`)
    }
  }
  if (!isStrictlyWithin(temporary, dshHome)) throw new Error('Exit diagnostics requires DSH_HOME inside TEMP')
  if (!isStrictlyWithin(temporary, app.getPath('userData'))) throw new Error('Exit diagnostics requires userData inside TEMP')
  if (!isWithin(existingRealPath(temporary), futureRealPath(app.getPath('temp')))) throw new Error('Exit diagnostics requires Electron temp inside TEMP')
  // A diagnostic root is fresh. Rejecting existing destinations prevents
  // pre-planted junctions from redirecting local-only artifacts outside TEMP.
  return {
    temporary,
    crashDumps: requireFreshTemporaryPath(temporary, 'deepseek-exit-dumps'),
    timelinePath: requireFreshTemporaryPath(temporary, 'deepseek-exit-timeline.jsonl'),
  }
}

module.exports = { isWithin, isStrictlyWithin, requireFreshTemporaryPath, requireTemporaryExitDiagnostics }
