import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { downloadArtifact } = require('./lib/download-artifact.cjs')
const [url, sha256, size, destination] = process.argv.slice(2)
if (!destination) throw Error('Usage: download-release.mjs <trusted-GitHub-release-URL> <trusted-SHA256> <trusted-byte-size> <destination>')
console.log(JSON.stringify(await downloadArtifact({ url, sha256, size: Number(size), destination })))
