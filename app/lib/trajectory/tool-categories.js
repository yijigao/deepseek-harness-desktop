'use strict'

const TOOL_CATEGORIES = Object.freeze([
  'search', 'read_file', 'write_file', 'edit_file', 'shell', 'test', 'git', 'network', 'other',
])

function baseToolName(tool) {
  return String(tool ?? '').toLowerCase().split(/[./:]/).filter(Boolean).at(-1) || ''
}

function commandFromArguments(args = {}) {
  for (const key of ['command', 'cmd', 'script']) if (typeof args[key] === 'string') return args[key]
  return ''
}

function isTestCommand(args = {}) {
  return /(?:^|[\s"'=:])(?:npm\s+(?:run\s+)?test(?::[\w-]+)?|pnpm\s+(?:run\s+)?test(?::[\w-]+)?|yarn\s+test(?::[\w-]+)?|bun\s+test(?::[\w-]+)?|python(?:3(?:\.\d+)?)?\s+-m\s+(?:pytest|unittest)|pytest|vitest|jest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\w*\s+test)(?:\s|["';)]|$)/i.test(commandFromArguments(args))
}

function isGitCommand(args = {}) {
  return /(?:^|[\s"'=:])git(?:\.exe)?\s+/i.test(commandFromArguments(args))
}

function normalizeToolCategory(tool, args = {}) {
  const name = baseToolName(tool)
  if (isTestCommand(args)) return 'test'
  if (isGitCommand(args)) return 'git'
  if (['bash', 'pwsh', 'powershell', 'exec', 'exec_command', 'shell', 'command'].includes(name)) return 'shell'
  if (['read', 'read_file', 'read_image', 'view_image', 'open_file'].includes(name)) return 'read_file'
  if (['glob', 'grep', 'rg', 'search', 'find', 'find_files', 'list_files'].includes(name)) return 'search'
  if (['write', 'write_file', 'create_file'].includes(name)) return 'write_file'
  if (['edit', 'edit_file', 'apply_patch', 'patch'].includes(name)) return 'edit_file'
  if (name === 'str_replace_editor') {
    const operation = String(args.command ?? args.operation ?? args.action ?? '').toLowerCase()
    return ['view', 'read'].includes(operation) ? 'read_file' : 'edit_file'
  }
  if (['web_search', 'search_query', 'open_url', 'fetch', 'http', 'network'].includes(name)) return 'network'
  return 'other'
}

module.exports = { TOOL_CATEGORIES, commandFromArguments, isTestCommand, normalizeToolCategory }
