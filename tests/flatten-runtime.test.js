'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'flatten-runtime.mjs')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-flatten-runtime-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const dependencyRoot = path.join(root, 'dependencies')
  await fs.mkdir(path.join(src, 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(src, 'package.json'), JSON.stringify({
    name: 'fixture-runtime',
    version: '1.0.0',
  }))
  return { root, src, dst, dependencyRoot }
}

async function writePackage(dir, name, version, marker, dependencies) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    ...(dependencies === undefined ? {} : { dependencies }),
  }))
  await fs.writeFile(path.join(dir, 'marker.txt'), marker)
}

async function writeSourcePackage(src, name, version, marker, dependencies) {
  await writePackage(path.join(src, 'node_modules', ...name.split('/')), name, version, marker, dependencies)
}

async function writeStorePackage(dependencyRoot, key, name, version, marker, dependencies, installName = name) {
  await writePackage(
    path.join(dependencyRoot, 'node_modules', '.pnpm', key, 'node_modules', ...installName.split('/')),
    name,
    version,
    marker,
    dependencies,
  )
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
}

async function readPackageJson(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
}

test('keeps the original two-position-argument layout and rejects malformed argument lists', async t => {
  const f = await fixture(t)
  await writeStorePackage(f.src, 'fixture-dep@1.0.0', 'fixture-dep', '1.0.0', 'legacy-store')

  const result = run([f.src, f.dst])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(
    await fs.readFile(path.join(f.dst, 'node_modules', 'fixture-dep', 'marker.txt'), 'utf8'),
    'legacy-store',
  )

  for (const args of [[], [f.src, f.dst, '--unknown', f.root]]) {
    const rejected = run(args)
    assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr)
    assert.match(rejected.stderr, /usage: node flatten-runtime\.mjs/)
  }
})

test('reads the virtual store from --dependency-root while retaining real source packages', async t => {
  const f = await fixture(t)
  await writeSourcePackage(
    f.src,
    '@deepseek-ai/workspace-fixture',
    '1.0.0',
    'source-workspace',
    { 'external-fixture': '^2.0.0' },
  )
  await writeStorePackage(f.dependencyRoot, 'external-fixture@2.0.0', 'external-fixture', '2.0.0', 'dependency-store')

  const result = run([f.src, f.dst, '--dependency-root', f.dependencyRoot])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(
    await fs.readFile(path.join(f.dst, 'node_modules', '@deepseek-ai', 'workspace-fixture', 'marker.txt'), 'utf8'),
    'source-workspace',
  )
  assert.equal(
    await fs.readFile(path.join(f.dst, 'node_modules', 'external-fixture', 'marker.txt'), 'utf8'),
    'dependency-store',
  )
})

test('excludes unreachable checkout-store packages and preserves dependency alias install names', async t => {
  const f = await fixture(t)
  await writeSourcePackage(
    f.src,
    '@deepseek-ai/alias-consumer',
    '1.0.0',
    'consumer',
    { 'string-width-cjs': 'npm:string-width@^4.2.0' },
  )
  await writeSourcePackage(
    f.src,
    '@deepseek-ai/alias-consumer-next',
    '1.0.0',
    'consumer-next',
    { 'string-width-cjs': 'npm:string-width@^5.0.0' },
  )
  await writeStorePackage(
    f.dependencyRoot,
    'string-width@4.2.3',
    'string-width',
    '4.2.3',
    'aliased-dependency',
  )
  await writeStorePackage(f.dependencyRoot, 'build-only@9.0.0', 'build-only', '9.0.0', 'unreachable')
  await writeStorePackage(
    f.dependencyRoot,
    'string-width@5.1.0',
    'string-width',
    '5.1.0',
    'aliased-dependency-next',
  )

  const result = run([f.src, f.dst, '--dependency-root', f.dependencyRoot])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(
    await fs.readFile(path.join(f.dst, 'node_modules', 'string-width-cjs', 'marker.txt'), 'utf8'),
    'aliased-dependency-next',
  )
  assert.equal(
    await fs.readFile(path.join(
      f.dst,
      'node_modules',
      '@deepseek-ai',
      'alias-consumer',
      'node_modules',
      'string-width-cjs',
      'marker.txt',
    ), 'utf8'),
    'aliased-dependency',
  )
  await assert.rejects(fs.stat(path.join(f.dst, 'node_modules', 'build-only')), { code: 'ENOENT' })
})

test('prefers source content when source and store carry the same package identity', async t => {
  const f = await fixture(t)
  await writeSourcePackage(f.src, '@deepseek-ai/same-fixture', '1.2.3', 'source-copy')
  await writeStorePackage(
    f.dependencyRoot,
    '@deepseek-ai+same-fixture@1.2.3',
    '@deepseek-ai/same-fixture',
    '1.2.3',
    'store-copy',
  )

  const result = run([f.src, f.dst, '--dependency-root', f.dependencyRoot])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(
    await fs.readFile(path.join(f.dst, 'node_modules', '@deepseek-ai', 'same-fixture', 'marker.txt'), 'utf8'),
    'source-copy',
  )
})

test('rejects a missing dependency store before touching the destination', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.dst, { recursive: true })
  const sentinel = path.join(f.dst, 'keep.txt')
  await fs.writeFile(sentinel, 'untouched')

  const result = run([f.src, f.dst, '--dependency-root', f.dependencyRoot])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /pnpm dependency store missing/)
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'untouched')
})

test('honors the runtime root range at top level and nests a higher alternate for its consumer', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.src, 'package.json'), JSON.stringify({
    name: 'fixture-runtime',
    version: '1.0.0',
    dependencies: { 'versioned-fixture': '^1.0.0' },
  }))
  await writeSourcePackage(
    f.src,
    'high-consumer',
    '1.0.0',
    'consumer',
    { 'versioned-fixture': '^2.0.0' },
  )
  await writeStorePackage(f.dependencyRoot, 'versioned-fixture@1.5.0', 'versioned-fixture', '1.5.0', 'low')
  await writeStorePackage(f.dependencyRoot, 'versioned-fixture@2.1.0', 'versioned-fixture', '2.1.0', 'high')

  const result = run([f.src, f.dst, '--dependency-root', f.dependencyRoot])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal((await readPackageJson(path.join(f.dst, 'node_modules', 'versioned-fixture'))).version, '1.5.0')
  assert.equal(
    (await readPackageJson(path.join(
      f.dst,
      'node_modules',
      'high-consumer',
      'node_modules',
      'versioned-fixture',
    ))).version,
    '2.1.0',
  )
})
