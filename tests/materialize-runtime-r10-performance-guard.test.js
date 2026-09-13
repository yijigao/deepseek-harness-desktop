'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MODULE = pathToFileURL(path.join(
  __dirname,
  '..',
  'scripts',
  'lib',
  'select-runtime-workspace-roster.mjs',
)).href

function record(name, manifest = {}) {
  return { manifest: { name, version: '1.0.0', ...manifest } }
}

test('retains trusted release roots and CLI while excluding unreachable test and private packages', async () => {
  const { selectRuntimeWorkspaceRoster } = await import(MODULE)
  const result = selectRuntimeWorkspaceRoster({
    records: [
      record('@example/cli'),
      record('@example/published'),
      record('@example/test-support'),
      record('@example/private-experiment'),
    ],
    trustedRootNames: new Set(['@example/published']),
    cliName: '@example/cli',
  })

  assert.deepEqual(result.selectedNames, ['@example/cli', '@example/published'])
  assert.deepEqual(result.excludedNames, ['@example/private-experiment', '@example/test-support'])
  assert.deepEqual(result.reasons['@example/cli'], ['cli-root'])
  assert.deepEqual(result.reasons['@example/published'], ['trusted-release-root'])
})

test('retains non-root workspace packages reachable through every production dependency field', async () => {
  const { selectRuntimeWorkspaceRoster } = await import(MODULE)
  const result = selectRuntimeWorkspaceRoster({
    records: [
      record('@example/cli'),
      record('@example/published', {
        dependencies: { '@example/dependency': 'workspace:*' },
        optionalDependencies: { '@example/optional': 'workspace:*' },
        peerDependencies: { '@example/peer': 'workspace:*' },
      }),
      record('@example/dependency', { dependencies: { '@example/transitive': 'workspace:*' } }),
      record('@example/optional'),
      record('@example/peer'),
      record('@example/transitive'),
      record('@example/unreachable'),
    ],
    trustedRootNames: new Set(['@example/published']),
    cliName: '@example/cli',
  })

  assert.deepEqual(result.selectedNames, [
    '@example/cli',
    '@example/dependency',
    '@example/optional',
    '@example/peer',
    '@example/published',
    '@example/transitive',
  ])
  assert.deepEqual(result.reasons['@example/dependency'], ['dependencies:@example/published'])
  assert.deepEqual(result.reasons['@example/optional'], ['optionalDependencies:@example/published'])
  assert.deepEqual(result.reasons['@example/peer'], ['peerDependencies:@example/published'])
  assert.deepEqual(result.reasons['@example/transitive'], ['dependencies:@example/dependency'])
  assert.deepEqual(result.excludedNames, ['@example/unreachable'])
})

test('uses the exact top-level trusted runtime manifest path and validates explicit roots', async () => {
  const {
    selectRuntimeWorkspaceRoster,
    trustedPackageManifestRelative,
  } = await import(MODULE)

  assert.equal(
    trustedPackageManifestRelative('@deepseek-ai/dsh-llm'),
    'resources/runtime/node_modules/@deepseek-ai/dsh-llm/package.json',
  )
  assert.throws(() => selectRuntimeWorkspaceRoster({
    records: [record('@example/cli')],
    trustedRootNames: new Set(),
    cliName: '@example/cli',
    explicitRootNames: ['@example/missing'],
  }), /absent from the built workspace roster/)
})

