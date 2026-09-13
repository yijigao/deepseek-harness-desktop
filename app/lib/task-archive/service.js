'use strict'

// Intentionally dependency-free. Desktop IPC and the shipped CLI use this same service.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MAX_BYTES = 5 * 1024 * 1024
const MAX_ITEMS = 10_000
const MAX_PREVIEW_BYTES = 64 * 1024
const VALID_STATUS = new Set(['pending', 'running', 'needs_review', 'failed', 'succeeded'])
const LEGACY_STATUS = 'legacy_succeeded'
const ALLOWED_ARTIFACT_EXTENSIONS = new Set(['.txt', '.log', '.md', '.json', '.csv', '.tsv', '.diff', '.patch', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.xlsx', '.docx'])
const STANDARD_FIELDS = Object.freeze({ itemId: 'itemId', status: 'status', artifactPath: 'artifactPath', evidence: 'evidence', diff: 'diff', error: 'error', nextAction: 'nextAction' })

function fail(message, code = 'TASK_ARCHIVE_INVALID') { const error = new Error(message); error.code = code; throw error }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function fileHash(target) { return sha256(fs.readFileSync(target)) }
function asText(value, max = 4_000) { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function json(value) { return JSON.stringify(value, null, 2) + '\n' }
function isInside(root, target) { const relative = path.relative(root, target); return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) }
function ensureFile(target, label = 'File') {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail(`${label} path must be absolute`)
  const lexical = path.resolve(target)
  let stat
  try { stat = fs.statSync(lexical) } catch { fail(`${label} does not exist`, 'TASK_ARCHIVE_NOT_FOUND') }
  if (!stat.isFile() || stat.size > MAX_BYTES) fail(`${label} is not an allowed regular file`)
  try { return fs.realpathSync(lexical) } catch { fail(`${label} cannot be resolved safely`) }
}
function atomicWrite(target, data) {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try { fs.renameSync(temporary, target) } catch (error) { try { fs.unlinkSync(temporary) } catch {}; throw error }
}
function csvRows(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1 } else if (char === '"') quoted = false; else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += char
  }
  if (quoted) fail('CSV has an unclosed quoted field')
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row) }
  return rows.filter((candidate) => candidate.some((value) => value !== ''))
}
function detectFields(keys) {
  const find = (...names) => names.find((name) => keys.includes(name)) || null
  return { itemId: find('itemId', 'id', 'item_id', 'sku', 'spu', 'barcode'), status: find('status', 'state', 'result'), artifactPath: find('artifactPath', 'artifact', 'outputPath', 'path'), evidence: find('evidence', 'proof'), diff: find('diff'), error: find('error', 'message'), nextAction: find('nextAction', 'next_action') }
}
function normalizeAdapter(keys, requested, format) {
  if (format === 'standard') return { format, fields: { ...STANDARD_FIELDS }, statusMap: {} }
  const supplied = isPlainObject(requested) ? requested : {}
  const fields = { ...detectFields(keys), ...(isPlainObject(supplied.fields) ? supplied.fields : {}) }
  for (const key of Object.keys(STANDARD_FIELDS)) {
    if (fields[key] == null || fields[key] === '') { fields[key] = null; continue }
    if (typeof fields[key] !== 'string' || !keys.includes(fields[key])) fail(`Mapped field ${key} is not a manifest column`)
  }
  if (!fields.itemId) fail('An explicit item ID field is required')
  const statusMap = {}
  if (isPlainObject(supplied.statusMap)) {
    for (const [source, target] of Object.entries(supplied.statusMap)) {
      const normalizedSource = asText(source, 80).toLowerCase()
      if (!normalizedSource || (target !== LEGACY_STATUS && !VALID_STATUS.has(target))) fail('Invalid explicit status mapping')
      statusMap[normalizedSource] = target
    }
  }
  return { format, fields, statusMap }
}
function safeValue(value, max = 16_000) {
  if (typeof value === 'string') return value.slice(0, max)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  try { const serialized = JSON.stringify(value); return serialized.length <= max ? JSON.parse(serialized) : serialized.slice(0, max) + '…' } catch { return '[unreadable value]' }
}
function identityFor(raw) {
  const source = isPlainObject(raw?.identity) ? raw.identity : raw
  return { spu: asText(source?.spu, 200), sku: asText(source?.sku, 200), barcode: asText(source?.barcode, 200) }
}
function pick(raw, field) { return field && isPlainObject(raw) ? raw[field] : undefined }
function normalizeItem(raw, fields, statusMap, index) {
  if (!isPlainObject(raw)) return { row: index + 1, state: 'invalid', problem: 'Row is not an object', sourceSha256: sha256(String(raw)) }
  const itemId = asText(pick(raw, fields.itemId), 200)
  const rawStatus = asText(pick(raw, fields.status), 80).toLowerCase()
  const mapped = Object.hasOwn(statusMap, rawStatus) ? statusMap[rawStatus] : rawStatus
  const known = VALID_STATUS.has(mapped) || mapped === LEGACY_STATUS
  return { itemId, identity: identityFor(raw), row: index + 1, status: known ? mapped : 'unknown', rawStatus, artifactPath: asText(pick(raw, fields.artifactPath), 2_000), evidence: safeValue(pick(raw, fields.evidence)), diff: safeValue(pick(raw, fields.diff)), error: asText(pick(raw, fields.error), 2_000), nextAction: asText(pick(raw, fields.nextAction), 1_000), sourceSha256: sha256(json(raw)), state: itemId ? (known ? 'ready' : 'needs_review') : 'invalid', problem: itemId ? (known ? null : `Unknown status: ${rawStatus || '(empty)'}`) : 'Missing explicit item ID' }
}
function parseManifest(manifestPath, requestedAdapter) {
  const resolved = ensureFile(manifestPath, 'Manifest')
  const buffer = fs.readFileSync(resolved)
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  let sourceItems; let format; let keys
  if (path.extname(resolved).toLowerCase() === '.csv') {
    const rows = csvRows(text); if (!rows.length) fail('CSV manifest has no header')
    const headers = rows[0].map((value) => asText(value, 100))
    if (!headers.every(Boolean) || new Set(headers).size !== headers.length) fail('CSV manifest has missing or duplicate headers')
    sourceItems = rows.slice(1).map((row) => Object.fromEntries(headers.map((key, index) => [key, row[index] ?? ''])))
    format = 'csv'; keys = headers
  } else {
    let parsed; try { parsed = JSON.parse(text) } catch { fail('Manifest must be JSON or UTF-8 CSV') }
    if (isPlainObject(parsed) && parsed.schemaVersion === 1 && Array.isArray(parsed.items)) { sourceItems = parsed.items; format = 'standard'; keys = Object.keys(parsed.items[0] || {}) }
    else if (Array.isArray(parsed)) { sourceItems = parsed; format = 'json-array'; keys = Object.keys(parsed[0] || {}) }
    else if (isPlainObject(parsed) && Array.isArray(parsed.items)) { sourceItems = parsed.items; format = 'json-items'; keys = Object.keys(parsed.items[0] || {}) }
    else fail('Unknown JSON manifest schema')
  }
  if (sourceItems.length > MAX_ITEMS) fail(`Manifest exceeds ${MAX_ITEMS} items`)
  const adapter = normalizeAdapter(keys, requestedAdapter, format)
  const items = sourceItems.map((raw, index) => normalizeItem(raw, adapter.fields, adapter.statusMap, index))
  const occurrences = new Map()
  for (const item of items) if (item.itemId) occurrences.set(item.itemId, (occurrences.get(item.itemId) || 0) + 1)
  for (const item of items) if (item.itemId && occurrences.get(item.itemId) > 1) { item.state = 'invalid'; item.problem = 'Duplicate item ID'; item.status = 'unknown' }
  return { manifestPath: resolved, sha256: sha256(buffer), format, adapter, items, rawBytes: buffer.length, bytes: buffer }
}
function archiveDir(home) { const target = path.join(path.resolve(home), 'task-archives'); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); return target }
function archivePath(home, taskId) { if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(taskId)) fail('Invalid task ID'); return path.join(archiveDir(home), `${taskId}.json`) }
function readArchive(home, taskId) { const target = archivePath(home, taskId); try { return JSON.parse(fs.readFileSync(target, 'utf8')) } catch { fail('Task archive not found', 'TASK_ARCHIVE_NOT_FOUND') } }
function writeArchive(home, archive) { atomicWrite(archivePath(home, archive.taskId), json(archive)); return archive }
function listArchives(home) {
  const directory = archiveDir(home); const entries = fs.readdirSync(directory, { withFileTypes: true })
  const archives = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{8}-[0-9a-f-]{27}\.json$/i.test(entry.name)) continue
    try {
      const target = path.join(directory, entry.name); const stat = fs.statSync(target)
      if (stat.size > MAX_BYTES) continue
      const value = JSON.parse(fs.readFileSync(target, 'utf8'))
      if (value?.schemaVersion === 1 && typeof value.taskId === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.taskId)) archives.push({ taskId: value.taskId, title: asText(value.title, 240), revision: Number.isInteger(value.revision) ? value.revision : 0 })
    } catch {}
  }
  return archives.sort((a, b) => a.taskId.localeCompare(b.taskId))
}
function withArchiveLock(home, taskId, operation) {
  const lock = `${archivePath(home, taskId)}.lock`; let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') fail('Task archive is being updated', 'TASK_ARCHIVE_CONFLICT'); throw error }
  try { return operation(readArchive(home, taskId)) } finally { fs.closeSync(fd); try { fs.unlinkSync(lock) } catch {} }
}
function validateSessions(value) { return Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id) && !/token|https?:|\//i.test(id)))].slice(0, 50) : [] }
function bind(home, manifestPath, metadata = {}) {
  const manifest = parseManifest(manifestPath, metadata.adapter)
  const taskId = crypto.randomUUID()
  const archive = { schemaVersion: 1, taskId, title: asText(metadata.title, 240), goal: asText(metadata.goal, 4_000), constraints: asText(metadata.constraints, 8_000), manifestPath: manifest.manifestPath, adapter: manifest.adapter, sessions: validateSessions(metadata.sessions), revision: 1, acceptance: { records: Object.create(null) }, retryRequests: [] }
  writeArchive(home, archive)
  return view(home, taskId)
}
function resolveArtifact(manifestPath, artifactPath) {
  if (!artifactPath || typeof artifactPath !== 'string' || path.isAbsolute(artifactPath)) fail('Artifact path must be relative to the manifest')
  if (/^[a-z][a-z0-9+.-]*:/i.test(artifactPath)) fail('Artifact URL is not allowed')
  const manifest = ensureFile(manifestPath, 'Manifest'); const root = fs.realpathSync(path.dirname(manifest))
  const lexical = path.resolve(path.dirname(manifest), artifactPath)
  if (!isInside(path.dirname(manifest), lexical)) fail('Artifact path escapes manifest directory')
  const extension = path.extname(lexical).toLowerCase(); if (!ALLOWED_ARTIFACT_EXTENSIONS.has(extension)) fail('Artifact type is not allowed')
  const target = ensureFile(lexical, 'Artifact')
  if (!isInside(root, target)) fail('Artifact resolves outside manifest directory')
  return target
}
function lockState(item, record) {
  if (!record) return { valid: false }
  if (item.state !== 'ready' || item.status !== 'succeeded') return { valid: false, warning: 'Source is no longer succeeded' }
  if (record.sourceSha256 !== item.sourceSha256) return { valid: false, warning: 'Source row changed since acceptance' }
  try { return fileHash(resolveArtifact(record.manifestPath, item.artifactPath)) === record.artifactSha256 ? { valid: true } : { valid: false, warning: 'Artifact changed since acceptance' } } catch { return { valid: false, warning: 'Accepted artifact is missing or unsafe' } }
}
function recordFor(records, itemId) { return isPlainObject(records) && Object.hasOwn(records, itemId) ? records[itemId] : undefined }
function renderItem(item, record) { return { ...item, acceptance: lockState(item, record) } }
function view(home, taskId) {
  const archive = readArchive(home, taskId); const manifest = parseManifest(archive.manifestPath, archive.adapter)
  const records = archive.acceptance?.records; const items = manifest.items.map((item) => renderItem(item, recordFor(records, item.itemId)))
  return { archive: { ...archive, acceptance: undefined }, manifest: { path: manifest.manifestPath, sha256: manifest.sha256, format: manifest.format, itemCount: items.length }, items }
}
function checkpoint(home, taskId, expectedRevision, metadata) {
  const result = withArchiveLock(home, taskId, (archive) => {
    if (!Number.isInteger(expectedRevision) || archive.revision !== expectedRevision) fail('Archive revision conflict', 'TASK_ARCHIVE_CONFLICT')
    for (const key of ['title', 'goal', 'constraints']) if (Object.hasOwn(metadata || {}, key)) archive[key] = asText(metadata[key], key === 'title' ? 240 : 8_000)
    if (Object.hasOwn(metadata || {}, 'sessions')) archive.sessions = validateSessions(metadata.sessions)
    archive.revision += 1; writeArchive(home, archive); return archive.taskId
  })
  return view(home, result)
}
function accept(home, taskId, itemId, expectedSourceSha256, expectedManifestSha256, expectedArtifactSha256) {
  const result = withArchiveLock(home, taskId, (archive) => {
    const manifest = parseManifest(archive.manifestPath, archive.adapter); const item = manifest.items.find((candidate) => candidate.itemId === itemId)
    if (!item || item.state !== 'ready' || item.status !== 'succeeded') fail('Only current succeeded items can be accepted')
    if (typeof expectedSourceSha256 !== 'string' || expectedSourceSha256 !== item.sourceSha256 || expectedManifestSha256 !== manifest.sha256) fail('Manifest changed; refresh before accepting', 'TASK_ARCHIVE_CONFLICT')
    const artifact = resolveArtifact(manifest.manifestPath, item.artifactPath); const artifactSha256 = fileHash(artifact)
    if (typeof expectedArtifactSha256 !== 'string' || expectedArtifactSha256 !== artifactSha256) fail('Artifact changed; inspect again before accepting', 'TASK_ARCHIVE_CONFLICT')
    archive.acceptance = archive.acceptance || {}; if (!isPlainObject(archive.acceptance.records)) archive.acceptance.records = Object.create(null)
    const record = { acceptedAt: new Date().toISOString(), sourceSha256: item.sourceSha256, artifactSha256, manifestPath: manifest.manifestPath, evidence: item.evidence == null ? null : safeValue(item.evidence, 2_000) }
    Object.defineProperty(archive.acceptance.records, itemId, { value: record, enumerable: true, configurable: true, writable: true })
    archive.revision += 1; writeArchive(home, archive); return archive.taskId
  })
  return view(home, result)
}
function retryPlan(home, taskId) {
  return withArchiveLock(home, taskId, (archive) => {
    const state = view(home, taskId); const ids = state.items.filter((item) => item.state === 'ready' && item.status === 'failed' && !item.acceptance.valid).map((item) => item.itemId)
    const request = { schemaVersion: 1, type: 'retry-request', requestId: crypto.randomUUID(), taskId, manifestPath: archive.manifestPath, manifestSha256: state.manifest.sha256, itemIds: ids, createdAt: new Date().toISOString() }
    const target = path.join(archiveDir(home), `retry-${request.requestId}.json`); fs.writeFileSync(target, json(request), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    archive.retryRequests = [...(archive.retryRequests || []), { requestId: request.requestId, path: target, manifestSha256: request.manifestSha256, itemIds: ids }]; archive.revision += 1; writeArchive(home, archive); return request
  })
}
function assertWritableStandard(manifest, label) {
  if (manifest.format !== 'standard') fail(`${label} must use standard schemaVersion 1 JSON`)
  if (manifest.items.some((item) => item.state !== 'ready' || !VALID_STATUS.has(item.status))) fail(`${label} has missing, duplicate, or invalid item IDs/statuses`)
}
function assertProtectedRows(current, candidate, archive) {
  const candidateById = new Map(candidate.items.map((item) => [item.itemId, item]))
  const records = archive.acceptance?.records
  for (const item of current.items) {
    const locked = lockState(item, recordFor(records, item.itemId)).valid
    if (item.status !== 'succeeded' && !locked) continue
    const replacement = candidateById.get(item.itemId)
    if (!replacement || replacement.sourceSha256 !== item.sourceSha256) fail(`Protected succeeded or accepted item cannot be changed: ${item.itemId}`)
  }
}
function update(home, taskId, expectedManifestSha256, nextManifestPath) {
  if (!/^[a-f0-9]{64}$/i.test(expectedManifestSha256 || '')) fail('Expected manifest hash is invalid')
  return withArchiveLock(home, taskId, (archive) => {
    const current = parseManifest(archive.manifestPath, archive.adapter)
    assertWritableStandard(current, 'Current manifest')
    const candidate = parseManifest(nextManifestPath)
    assertWritableStandard(candidate, 'Replacement manifest')
    assertProtectedRows(current, candidate, archive)
    const root = fs.realpathSync(path.dirname(current.manifestPath))
    if (!isInside(root, candidate.manifestPath)) fail('Replacement manifest must remain beside the source manifest')
    const lock = `${current.manifestPath}.task-archive.lock`; let lockFd
    try {
      try { lockFd = fs.openSync(lock, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') fail('Manifest is being updated', 'TASK_ARCHIVE_CONFLICT'); throw error }
      if (fileHash(current.manifestPath) !== expectedManifestSha256) fail('Manifest hash conflict', 'TASK_ARCHIVE_CONFLICT')
      atomicWrite(current.manifestPath, candidate.bytes)
    } finally { if (lockFd !== undefined) { fs.closeSync(lockFd); try { fs.unlinkSync(lock) } catch {} } }
    return view(home, taskId)
  })
}
function itemDetails(home, taskId, itemId) {
  const archive = readArchive(home, taskId); const manifest = parseManifest(archive.manifestPath, archive.adapter); const item = manifest.items.find((candidate) => candidate.itemId === itemId)
  if (!item) fail('Task item not found', 'TASK_ARCHIVE_NOT_FOUND')
  const detail = { item: renderItem(item, recordFor(archive.acceptance?.records, item.itemId)), artifact: null }
  if (item.artifactPath) {
    try {
      const target = resolveArtifact(manifest.manifestPath, item.artifactPath); const bytes = fs.readFileSync(target); const extension = path.extname(target).toLowerCase()
      const imageMime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extension]
      const binary = bytes.subarray(0, MAX_PREVIEW_BYTES).includes(0)
      detail.artifact = { name: path.basename(target), sha256: sha256(bytes), bytes: bytes.length, preview: imageMime ? '[安全图片预览]' : ['.pdf', '.xlsx', '.docx'].includes(extension) ? '[此格式不嵌入预览；请在受信任的外部程序中审查。]' : binary ? '[Binary artifact preview is unavailable]' : bytes.subarray(0, MAX_PREVIEW_BYTES).toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '�'), truncated: bytes.length > MAX_PREVIEW_BYTES, imageDataUrl: imageMime ? `data:${imageMime};base64,${bytes.toString('base64')}` : null }
    } catch (error) { detail.artifact = { unavailable: true, message: error.message } }
  }
  return detail
}

module.exports = { MAX_BYTES, MAX_ITEMS, parseManifest, bind, listArchives, view, checkpoint, accept, retryPlan, update, resolveArtifact, itemDetails }
