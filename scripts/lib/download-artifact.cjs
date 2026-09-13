'use strict'
const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const hosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
function allowedUrl(input) {
  const url = new URL(input)
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw Error('Artifact URL is not an approved HTTPS release host')
  return url
}
async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function fileSize(file) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Artifact path must be a regular file')
    return stat.size
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function downloadArtifact({ url, sha256, size, destination }, { fetchImpl = fetch } = {}) {
  let requestUrl = allowedUrl(url)
  if (!/^[a-f0-9]{64}$/.test(sha256 || '') || !Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3) throw Error('Trusted SHA-256 and artifact size (up to 2 GiB) are required')
  const target = path.resolve(destination)
  await fs.mkdir(path.dirname(target), { recursive: true })
  if (await fileSize(target) !== null) {
    if (await fileSize(target) !== size || await hashFile(target) !== sha256) throw Error('Existing artifact differs; it will not be overwritten')
    return { status: 'downloaded', destination: target, cached: true, bytes: size }
  }
  const partial = target + '.partial'
  const metadata = partial + '.json'
  const identity = JSON.stringify({ schema: 1, url: requestUrl.href, sha256, size })
  if (await fileSize(metadata) !== null) {
    if (await fs.readFile(metadata, 'utf8') !== identity) throw Error('Partial artifact belongs to a different release')
  } else {
    if (await fileSize(partial) !== null) throw Error('Unidentified partial artifact will not be reused')
    await fs.writeFile(metadata, identity, { flag: 'wx', mode: 0o600 })
  }
  let offset = await fileSize(partial) ?? 0
  if (offset > size) throw Error('Partial artifact exceeds declared size')
  const resumedBytes = offset
  if (offset < size) {
    let response
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetchImpl(requestUrl.href, { redirect: 'manual', headers: { 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-` } : {}) }, signal: AbortSignal.timeout(120000) })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || redirects === 5) throw Error('Invalid or excessive artifact redirects')
      requestUrl = allowedUrl(new URL(location, requestUrl).href)
    }
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw Error('Encoded artifact transfer is not supported')
    if (offset) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '')
      if (response.status !== 206 || !range || Number(range[1]) !== offset || Number(range[2]) !== size - 1 || Number(range[3]) !== size) throw Error('Server did not honor the exact resume range; partial artifact retained')
    } else if (response.status !== 200) throw Error(`Artifact download refused: HTTP ${response.status}`)
    if (!response.body) throw Error('Artifact response has no body')
    const file = await fs.open(partial, 'a', 0o600)
    try {
      for await (const chunk of response.body) {
        if (offset + chunk.length > size) throw Error('Artifact response exceeds trusted size')
        await file.writeFile(chunk)
        offset += chunk.length
      }
      await file.sync()
    } finally { await file.close() }
  }
  if (offset !== size) throw Error('Artifact transfer incomplete; partial bytes retained for resume')
  if (await hashFile(partial) !== sha256) throw Error('Artifact SHA-256 mismatch; nothing published')
  // Hard-link publication fails if target exists; it does not replace a file.
  // Keep the partial as a completed cache until a separate cleanup is requested.
  await fs.link(partial, target)
  return { status: 'downloaded', destination: target, cached: false, resumedBytes, bytes: size }
}
module.exports = { allowedUrl, downloadArtifact }
