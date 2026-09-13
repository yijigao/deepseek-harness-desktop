import { createRequire } from 'node:module'
const { extractArtifact } = createRequire(import.meta.url)('./lib/extract-artifact.cjs')
const [archive, sha256, size, manifestSha256, destination] = process.argv.slice(2)
if (!destination) throw Error('Usage: extract-release.mjs <ZIP> <trusted-archive-SHA256> <trusted-byte-size> <trusted-manifest-SHA256> <new-container-directory>')
console.log(JSON.stringify(await extractArtifact({ archive, sha256, size: Number(size), manifestSha256, destination })))
