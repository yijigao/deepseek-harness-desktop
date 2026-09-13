'use strict'

const path = require('node:path')
const fs = require('node:fs')
// In source this is ../../app; in resources/tools/task-archive it is ./lib.
const shippedService = path.join(__dirname, 'lib', 'task-archive', 'service.js')
const service = require(fs.existsSync(shippedService) ? shippedService : path.join(__dirname, '..', '..', 'app', 'lib', 'task-archive', 'service.js'))
const args = process.argv.slice(2)
const command = args.shift()
const value = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] }
const home = process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh')
function usage() { throw new Error('Usage: bind --manifest PATH [--title T] [--adapter JSON] | list | show TASK | inspect TASK ITEM | checkpoint TASK --expected-revision N --meta JSON | update TASK --expected-manifest-sha256 HASH --manifest PATH | accept TASK ITEM --expected-source-sha256 HASH --expected-manifest-sha256 HASH --expected-artifact-sha256 HASH | retry-plan TASK') }
try {
  let result
  if (command === 'bind') { const manifest = value('--manifest'); if (!manifest) usage(); result = service.bind(home, path.resolve(manifest), { title: value('--title') || '', goal: value('--goal') || '', constraints: value('--constraints') || '', adapter: value('--adapter') ? JSON.parse(value('--adapter')) : undefined }) }
  else if (command === 'list') result = service.listArchives(home)
  else if (command === 'show' || command === 'read') { if (!args[0]) usage(); result = service.view(home, args[0]) }
  else if (command === 'inspect') { if (!args[0] || !args[1]) usage(); result = service.itemDetails(home, args[0], args[1]) }
  else if (command === 'checkpoint') { const meta = value('--meta'); if (!args[0] || !meta) usage(); result = service.checkpoint(home, args[0], Number(value('--expected-revision')), JSON.parse(meta)) }
  else if (command === 'update') { if (!args[0] || !value('--manifest') || !value('--expected-manifest-sha256')) usage(); result = service.update(home, args[0], value('--expected-manifest-sha256'), path.resolve(value('--manifest'))) }
  else if (command === 'accept') { if (!args[0] || !args[1] || !value('--expected-source-sha256') || !value('--expected-manifest-sha256') || !value('--expected-artifact-sha256')) usage(); result = service.accept(home, args[0], args[1], value('--expected-source-sha256'), value('--expected-manifest-sha256'), value('--expected-artifact-sha256')) }
  else if (command === 'retry-plan') { if (!args[0]) usage(); result = service.retryPlan(home, args[0]) }
  else usage()
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) { process.stderr.write(`${error.code || 'TASK_ARCHIVE_ERROR'}: ${error.message}\n`); process.exitCode = 1 }
