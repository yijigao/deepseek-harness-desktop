'use strict'

const crypto = require('node:crypto')
const fsConstants = require('node:fs').constants
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { parseRun } = require('../trajectory/parser')
const { compareRuns } = require('../trajectory/compare')

const DSH_SESSION_FILES = new Set(['session.jsonl', 'session.jsonl.zstd'])
const CODEX_SESSION_FILE = /^rollout-[A-Za-z0-9T:._+\-]+\.jsonl$/
const PUBLIC_METRICS = Object.freeze([
  'total_steps',
  'user_messages',
  'assistant_messages',
  'tool_calls',
  'tool_results',
  'failed_tool_calls',
  'unique_tools',
  'repeated_tool_calls',
  'duration_ms',
  'files_read',
  'files_written',
  'shell_commands',
  'failed_shell_commands',
  'retry_count',
  'error_count',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'tool_category_counts',
])

function opaqueId(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 24)
}

function resolveDshHome(configured) {
  const selected = typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : path.join(os.homedir(), '.dsh')
  if (selected === '~') return os.homedir()
  if (selected.startsWith('~/') || selected.startsWith('~\\')) {
    return path.resolve(path.join(os.homedir(), selected.slice(2)))
  }
  return path.resolve(selected)
}

function resolveCodexSessionsRoot(homeDirectory = os.homedir()) {
  return path.resolve(path.join(homeDirectory, '.codex', 'sessions'))
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function sameIdentity(left, right) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino) return false
  if (Number.isFinite(left.birthtimeMs) && Number.isFinite(right.birthtimeMs)) {
    return left.birthtimeMs === right.birthtimeMs
  }
  return true
}

async function safeDirectoryRoot(directory) {
  try {
    const before = await fs.lstat(directory)
    if (before.isSymbolicLink() || !before.isDirectory()) return null
    const realPath = await fs.realpath(directory)
    const [after, realStat] = await Promise.all([fs.lstat(directory), fs.lstat(realPath)])
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || realStat.isSymbolicLink()
      || !realStat.isDirectory()
      || !sameIdentity(before, after)
      || !sameIdentity(after, realStat)
    ) return null
    return { birthtimeMs: after.birthtimeMs, dev: after.dev, ino: after.ino, realPath }
  } catch (error) {
    if (error && ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return null
    throw error
  }
}

function pickMetrics(metrics) {
  return Object.fromEntries(PUBLIC_METRICS.map((key) => [key, metrics[key] ?? null]))
}

function publicStep(step) {
  const metadata = {}
  for (const key of ['toolCategory', 'pathBasenames', 'testCommand', 'lifecycle', 'retry', 'usage', 'unknownData']) {
    if (Object.hasOwn(step.metadata, key)) metadata[key] = step.metadata[key]
  }
  return {
    index: step.index,
    timestamp: step.timestamp,
    type: step.type,
    tool: step.tool,
    summary: step.summary,
    rawType: step.rawType,
    durationMs: step.durationMs,
    success: step.success,
    metadata,
  }
}

function publicRun(run, includeSteps = true) {
  return {
    runId: run.runId,
    source: run.source,
    sourceVersion: run.sourceVersion,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    model: run.model,
    workspace: run.workspace,
    status: run.status,
    steps: includeSteps ? run.steps.map(publicStep) : undefined,
    metrics: pickMetrics(run.metrics),
  }
}

class HarnessLabSessionService {
  constructor(options = {}) {
    const dshHome = resolveDshHome(options.dshHome ?? process.env.DSH_HOME)
    this.sessionsRoots = [
      { format: 'dsh-jsonl', root: path.join(dshHome, 'sessions'), accepts: (name) => DSH_SESSION_FILES.has(name) },
      { format: 'codex-jsonl', root: options.codexSessionsRoot ?? resolveCodexSessionsRoot(), accepts: (name) => CODEX_SESSION_FILE.test(name) },
    ]
    this.demoMode = Boolean(options.demoMode)
    this.demoDir = options.demoDir || path.join(__dirname, '..', '..', 'demo')
    this.maxFiles = options.maxFiles ?? 100
    this.maxDepth = options.maxDepth ?? 5
    this.maxFileBytes = options.maxFileBytes ?? 256 * 1024 * 1024
    this.registry = new Map()
    this.cache = new Map()
  }

  async collectSessionFiles(directory, rootInfo, accepts, depth = 0, output = []) {
    if (depth > this.maxDepth || output.length >= this.maxFiles * 4) return output
    let entries
    try {
      const directoryInfo = await safeDirectoryRoot(directory)
      if (!directoryInfo || !isWithinRoot(directoryInfo.realPath, rootInfo.realPath)) return output
      if (depth === 0 && !sameIdentity(directoryInfo, rootInfo)) return output
      entries = await fs.readdir(directoryInfo.realPath, { withFileTypes: true })
      const verified = await safeDirectoryRoot(directoryInfo.realPath)
      if (!verified || !sameIdentity(directoryInfo, verified)) return output
      directory = directoryInfo.realPath
    } catch (error) {
      if (error && ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return output
      throw error
    }
    for (const entry of entries) {
      if (output.length >= this.maxFiles * 4) break
      if (entry.isSymbolicLink()) continue
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await this.collectSessionFiles(candidate, rootInfo, accepts, depth + 1, output)
      } else if (entry.isFile() && accepts(entry.name)) {
        output.push(candidate)
      }
    }
    return output
  }

  async discoverFiles() {
    if (this.demoMode) {
      const rootInfo = await safeDirectoryRoot(this.demoDir)
      if (!rootInfo) return []
      const rootReal = rootInfo.realPath
      return ['run-a.jsonl', 'run-b.jsonl'].map((name) => ({
        filePath: path.join(rootReal, name),
        format: 'dsh-jsonl',
        rootBirthtimeMs: rootInfo.birthtimeMs,
        rootDev: rootInfo.dev,
        rootIno: rootInfo.ino,
        rootReal: rootInfo.realPath,
      }))
    }
    const stats = []
    for (const source of this.sessionsRoots) {
      const rootInfo = await safeDirectoryRoot(source.root)
      if (!rootInfo) continue
      const rootReal = rootInfo.realPath
      const files = await this.collectSessionFiles(rootReal, rootInfo, source.accepts)
      for (const filePath of files) {
        try {
          const stat = await fs.lstat(filePath)
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size > this.maxFileBytes) continue
          const fileReal = await fs.realpath(filePath)
          if (isWithinRoot(fileReal, rootReal)) stats.push({ filePath: fileReal, format: source.format, rootInfo, stat })
        } catch {}
      }
    }
    stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    return stats.slice(0, this.maxFiles).map(({ filePath, format, rootInfo: safeRoot }) => ({
      filePath,
      format,
      rootBirthtimeMs: safeRoot.birthtimeMs,
      rootDev: safeRoot.dev,
      rootIno: safeRoot.ino,
      rootReal: safeRoot.realPath,
    }))
  }

  async loadFile(entry) {
    const { filePath, format, rootBirthtimeMs, rootDev, rootIno, rootReal } = entry
    const resolvedFile = path.resolve(filePath)
    const resolvedRoot = path.resolve(rootReal)
    if (!isWithinRoot(resolvedFile, resolvedRoot)) throw new Error('Session file is not readable')
    const expectedRoot = { birthtimeMs: rootBirthtimeMs, dev: rootDev, ino: rootIno }
    const rootBefore = await safeDirectoryRoot(resolvedRoot)
    if (!rootBefore || !sameIdentity(rootBefore, expectedRoot)) throw new Error('Session file is not readable')

    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    const handle = await fs.open(resolvedFile, flags)
    try {
      const stat = await handle.stat()
      const [pathStat, currentReal] = await Promise.all([fs.lstat(resolvedFile), fs.realpath(resolvedFile)])
      const rootAfter = await safeDirectoryRoot(resolvedRoot)
      const sameFile = pathStat.dev === stat.dev && pathStat.ino === stat.ino
      if (
        pathStat.isSymbolicLink()
        || !stat.isFile()
        || !sameFile
        || stat.size > this.maxFileBytes
        || !isWithinRoot(currentReal, resolvedRoot)
        || !rootAfter
        || !sameIdentity(rootAfter, expectedRoot)
      ) {
        throw new Error('Session file is not readable')
      }
      const runId = opaqueId(currentReal)
      const cached = this.cache.get(runId)
      if (
        cached
        && cached.mtimeMs === stat.mtimeMs
        && cached.size === stat.size
        && cached.dev === stat.dev
        && cached.ino === stat.ino
      ) return cached.run
      const contents = await handle.readFile()
      const run = parseRun(contents, {
        format,
        fileName: path.basename(currentReal),
        identitySeed: runId,
        runId,
      })
      this.cache.set(runId, { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, run })
      return run
    } finally {
      await handle.close()
    }
  }

  async refresh() {
    const files = await this.discoverFiles()
    const nextRegistry = new Map()
    const runs = []
    let unsupportedCompression = false
    for (const entry of files) {
      const { filePath } = entry
      const runId = opaqueId(filePath)
      try {
        const run = await this.loadFile(entry)
        nextRegistry.set(runId, entry)
        runs.push(run)
      } catch (error) {
        if (error?.code === 'HARNESS_LAB_ZSTD_UNAVAILABLE') unsupportedCompression = true
        // A corrupt or concurrently-mutated artifact does not block other runs.
        // Missing runtime compression support is surfaced after the scan.
      }
    }
    if (unsupportedCompression) {
      const error = new Error('Harness Lab runtime lacks required session compression support')
      error.code = 'HARNESS_LAB_ZSTD_UNAVAILABLE'
      throw error
    }
    runs.sort((a, b) => Date.parse(b.startedAt ?? 0) - Date.parse(a.startedAt ?? 0))
    this.registry = nextRegistry
    return runs
  }

  async listRuns() {
    const runs = await this.refresh()
    return runs.map((run) => publicRun(run, false))
  }

  async requireRun(runId) {
    if (typeof runId !== 'string' || !/^[a-f0-9]{24}$/.test(runId)) throw new Error('Unknown run')
    if (!this.registry.has(runId)) await this.refresh()
    const entry = this.registry.get(runId)
    if (!entry) throw new Error('Unknown run')
    return this.loadFile(entry)
  }

  async getRun(runId) {
    return publicRun(await this.requireRun(runId), true)
  }

  async compare(runAId, runBId) {
    if (runAId === runBId) throw new Error('Select two different runs')
    const [runA, runB] = await Promise.all([this.requireRun(runAId), this.requireRun(runBId)])
    return compareRuns(runA, runB)
  }
}

module.exports = {
  HarnessLabSessionService,
  PUBLIC_METRICS,
  isWithinRoot,
  opaqueId,
  publicRun,
  resolveDshHome,
  resolveCodexSessionsRoot,
  safeDirectoryRoot,
  sameIdentity,
}
