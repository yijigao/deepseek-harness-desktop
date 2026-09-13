const PRODUCTION_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]

export function trustedPackageManifestRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\')) {
    throw new Error(`Invalid workspace package name: ${name}`)
  }
  return `resources/runtime/node_modules/${name}/package.json`
}

export function selectRuntimeWorkspaceRoster({
  records,
  trustedRootNames,
  cliName,
  explicitRootNames = [],
}) {
  const byName = records instanceof Map
    ? records
    : new Map(records.map(record => [record.manifest.name, record]))
  const reasons = new Map()
  const queue = []

  const addRoot = (name, reason) => {
    if (!byName.has(name)) throw new Error(`Runtime root is absent from the built workspace roster: ${name}`)
    if (!reasons.has(name)) queue.push(name)
    const existing = reasons.get(name) ?? []
    if (!existing.includes(reason)) existing.push(reason)
    reasons.set(name, existing)
  }

  addRoot(cliName, 'cli-root')
  for (const name of [...trustedRootNames].sort()) {
    if (name !== cliName) addRoot(name, 'trusted-release-root')
  }
  for (const name of [...explicitRootNames].sort()) addRoot(name, 'explicit-production-root')

  for (let index = 0; index < queue.length; index += 1) {
    const parentName = queue[index]
    const parent = byName.get(parentName)
    for (const field of PRODUCTION_DEPENDENCY_FIELDS) {
      for (const dependencyName of Object.keys(parent.manifest[field] ?? {}).sort()) {
        if (!byName.has(dependencyName)) continue
        const reason = `${field}:${parentName}`
        if (!reasons.has(dependencyName)) queue.push(dependencyName)
        const existing = reasons.get(dependencyName) ?? []
        if (!existing.includes(reason)) existing.push(reason)
        reasons.set(dependencyName, existing)
      }
    }
  }

  const selectedNames = [...reasons.keys()].sort()
  const selected = new Set(selectedNames)
  return {
    selectedNames,
    excludedNames: [...byName.keys()].filter(name => !selected.has(name)).sort(),
    reasons: Object.fromEntries(selectedNames.map(name => [name, reasons.get(name)])),
  }
}

