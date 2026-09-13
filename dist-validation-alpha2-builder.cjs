const path = require('node:path')
const root = __dirname
const base = require('./app/package.json').build
module.exports = {
  ...base,
  directories: { ...base.directories, output: path.join(root, 'dist-validation-alpha2-desktop') },
  extraResources: [
    { from: path.join(root, 'staging/payload'), to: '.', filter: ['**/*', '!runtime{,/**/*}', '!version.json'] },
    { from: path.join(root, 'dist-validation-alpha2-flat'), to: 'runtime' },
    { from: path.join(root, 'dist-validation-alpha2-metadata/version.json'), to: 'version.json' },
    ...base.extraResources.slice(1),
  ],
  afterPack: async context => {
    // extraResources' default filters omit node_modules; copy the isolated
    // closure explicitly, using robocopy for Windows paths longer than 260.
    const { spawnSync } = require('node:child_process')
    const result = spawnSync('robocopy.exe', [
      path.join(root, 'dist-validation-alpha2-flat/node_modules'),
      path.join(context.appOutDir, 'resources/runtime/node_modules'),
      '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS',
    ], { windowsHide: true, encoding: 'utf8' })
    if (result.error || result.status === null || result.status >= 8) throw new Error('Isolated runtime dependency copy failed')
  },
}
