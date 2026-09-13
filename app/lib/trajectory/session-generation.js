'use strict'

function generation(name) {
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.exec(name)
  if (!match) return null
  const version = Number(match[1] || 0)
  return Number.isSafeInteger(version) ? version : null
}

// Select before checking file kind: a bad successor must never expose stale data.
function selectGeneration(entries) {
  let highest = -1
  let selected = []
  for (const entry of entries) {
    const version = generation(entry.name)
    if (version === null || version < highest) continue
    if (version > highest) { highest = version; selected = [] }
    selected.push(entry)
  }
  return { entry: selected.length === 1 ? selected[0] : null, ambiguous: selected.length > 1 }
}

module.exports = { generation, selectGeneration }
