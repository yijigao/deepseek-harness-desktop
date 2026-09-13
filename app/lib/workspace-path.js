'use strict'

const fs = require('node:fs')
const path = require('node:path')

function fail(message) { const error = new Error(message); error.code = 'DSH_WORKSPACE_INVALID'; throw error }
function contains(root, target) {
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

function validateResolvedLocation(target, { installRoot, credentialRoot, userData, temporary, testing }) {
  if (contains(installRoot, target)) fail('Workspace resolves into the installation directory')
  if (contains(credentialRoot, target) || contains(userData, target)) fail('Workspace resolves into credentials or application data')
  if (testing && !contains(temporary, target)) fail('Verification workspace resolves outside temporary storage')
}

/**
 * Select and create the engine's business cwd. It is deliberately separate
 * from DSH_HOME/userData and never defaults to the executable's directory.
 */
function resolveWorkspacePath({ app, env = process.env, argv = process.argv, tempDir, dshHome }) {
  const temporary = path.resolve(tempDir)
  const testing = env.DSH_TEST_MODE === '1' || argv.some((value) => value === '--verify' || /^--verify-/.test(value) || value.startsWith('--shot='))
  const installRoot = path.resolve(path.dirname(app.getPath('exe')))
  const userData = path.resolve(app.getPath('userData'))
  const credentialRoot = path.resolve(dshHome)
  const requested = env.DSH_WORKSPACE
  let target
  if (requested != null && requested !== '') {
    if (typeof requested !== 'string' || !path.isAbsolute(requested)) fail('DSH_WORKSPACE must be an absolute path')
    target = path.resolve(requested)
  } else if (testing) {
    target = path.join(temporary, 'deepseek-desktop-workspace')
  } else {
    // Electron may not be able to resolve a shell Documents folder in an
    // intentionally scrubbed diagnostic environment.  Isolated and explicit
    // workspace modes do not use Documents, so avoid touching that OS path.
    target = path.join(path.resolve(app.getPath('documents')), 'DeepSeek')
  }
  if (target === path.parse(target).root) fail('Workspace cannot be a filesystem root')
  if (contains(installRoot, target)) fail('Workspace cannot be inside the installation directory')
  if (contains(credentialRoot, target) || contains(userData, target)) fail('Workspace cannot be inside credentials or application data')
  if (testing && !contains(temporary, target)) fail('Verification workspace must be inside the temporary directory')
  const protectedRoots = {
    installRoot: existingRealPath(installRoot), credentialRoot: existingRealPath(credentialRoot),
    userData: existingRealPath(userData), temporary: existingRealPath(temporary), testing,
  }
  // Do this before mkdir: an existing junction/symlink must not cause an
  // otherwise rejected child directory to be created under a protected root.
  validateResolvedLocation(futureRealPath(target), protectedRoots)
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  let stat
  try { stat = fs.statSync(target) } catch { fail('Workspace cannot be created') }
  if (!stat.isDirectory()) fail('Workspace must be a directory')
  const resolved = existingRealPath(target)
  validateResolvedLocation(resolved, protectedRoots)
  return resolved
}

module.exports = { resolveWorkspacePath }
