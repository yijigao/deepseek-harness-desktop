'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { sha256 } = require('../app/lib/release-package')
const { downloadArtifact, allowedUrl } = require('../scripts/lib/download-artifact.cjs')
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-download-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const body = Buffer.from('synthetic-release-content')
  return { body, args: { url: 'https://github.com/example/test/releases/download/v1/test.zip', sha256: sha256(body), size: body.length, destination: path.join(root, 'artifact.zip') } }
}
test('verified download is cached and never executes or extracts its contents', async t => {
  const { body, args } = await fixture(t)
  assert.equal((await downloadArtifact(args, { fetchImpl: async () => new Response(body) })).status, 'downloaded')
  assert.equal((await downloadArtifact(args, { fetchImpl: () => { throw Error('must not fetch') } })).cached, true)
  assert.deepEqual(await fs.readFile(args.destination), body)
})
test('short transfer resumes only an exact validated Range response', async t => {
  const { body, args } = await fixture(t)
  await assert.rejects(downloadArtifact(args, { fetchImpl: async () => new Response(body.subarray(0, 5)) }), /incomplete/)
  const result = await downloadArtifact(args, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=5-')
    return new Response(body.subarray(5), { status: 206, headers: { 'content-range': `bytes 5-${body.length - 1}/${body.length}` } })
  } })
  assert.equal(result.resumedBytes, 5)
})
test('hash mismatch and oversized data never publish an artifact', async t => {
  const { body, args } = await fixture(t)
  await assert.rejects(downloadArtifact(args, { fetchImpl: async () => new Response(Buffer.alloc(body.length)) }), /SHA-256/)
  await assert.rejects(fs.access(args.destination))
  const other = { ...args, destination: args.destination + '-oversize' }
  await assert.rejects(downloadArtifact(other, { fetchImpl: async () => new Response(Buffer.alloc(body.length + 1)) }), /exceeds/)
  await assert.rejects(fs.access(other.destination))
})
test('HTTPS downgrade, local hosts and unapproved redirects are rejected', async t => {
  for (const url of ['http://github.com/a', 'https://localhost/a', 'https://evil.example/a']) assert.throws(() => allowedUrl(url))
  const credentialUrl = new URL('https://github.com/a')
  credentialUrl.username = 'synthetic'
  credentialUrl.password = 'fixture'
  assert.throws(() => allowedUrl(credentialUrl))
  const { args } = await fixture(t)
  await assert.rejects(downloadArtifact(args, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://localhost/private' } }) }), /approved HTTPS/)
})
test('ignored Range cannot append a whole response to partial bytes', async t => {
  const { body, args } = await fixture(t)
  await assert.rejects(downloadArtifact(args, { fetchImpl: async () => new Response(body.subarray(0, 4)) }), /incomplete/)
  await assert.rejects(downloadArtifact(args, { fetchImpl: async () => new Response(body) }), /resume range/)
  assert.equal((await fs.stat(args.destination + '.partial')).size, 4)
})
