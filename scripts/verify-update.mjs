import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { verifyPackage, classifyUpdate } = require('../app/lib/release-package.js')
const [candidate, digest, current, currentDigest] = process.argv.slice(2)
const prior = await verifyPackage(current, currentDigest)
const next = await verifyPackage(candidate, digest)
const classification = classifyUpdate(prior, next)
if (!['desktop', 'engine'].includes(classification.kind)) throw Error(classification.reason)
console.log(JSON.stringify({ ok: true, releaseId: next.releaseId, ...classification }))
