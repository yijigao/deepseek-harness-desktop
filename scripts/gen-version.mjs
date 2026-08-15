/**
 * gen-version.mjs — write the build identity into staging/payload/version.json:
 * the app version, the dsh checkout commit/branch it was built from, and the
 * build timestamp. The packaged app uses it for GitHub update checks.
 *
 * Usage: node gen-version.mjs <payloadDir> [appVersion]
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [payloadArg, appVersionArg] = process.argv.slice(2)
if (!payloadArg) {
  console.error('usage: node gen-version.mjs <payloadDir> [appVersion]')
  process.exit(2)
}
const payload = path.resolve(payloadArg)
const checkout = 'C:/Users/yi/deepseek-harness'
const REPO = 'deepseek-ai/deepseek-harness'
const BRANCH = 'master'

const git = (args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim()
const commit = git(['rev-parse', 'HEAD'])
const short = git(['rev-parse', '--short', 'HEAD'])
const date = git(['log', '-1', '--format=%ci'])

const { readFileSync } = await import('node:fs')
const dshVersion = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8')).version

const version = {
  appVersion: appVersionArg ?? '1.0.0',
  dshRepo: REPO,
  dshBranch: BRANCH,
  dshVersion,
  dshCommit: commit,
  dshCommitShort: short,
  dshCommitDate: date,
  builtAt: new Date().toISOString(),
}

mkdirSync(payload, { recursive: true })
writeFileSync(path.join(payload, 'version.json'), JSON.stringify(version, null, 2) + '\n')
console.log(`version.json: ${JSON.stringify(version)}`)
