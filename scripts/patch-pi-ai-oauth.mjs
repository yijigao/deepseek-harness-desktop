#!/usr/bin/env node
/**
 * patch-pi-ai-oauth.mjs — install the OAuth credential-store seam into a
 * deployed `@deepseek-ai/dsh-llm-pi-ai` adapter (idempotent).
 *
 * Why: the stock adapter builds pi-ai's `Models` without a credential store,
 * so OAuth-only catalog routes (`openai-codex` — the ChatGPT-subscription
 * route) fail every request with "Provider is not configured". This script
 * splices a file-backed store (`$DSH_HOME/oauth-credentials.json`) into the
 * deployed `lib/index.js`, giving such routes the same durable,
 * refresh-persisting storage pi-ai's own CLI login flow writes.
 *
 * License note: the script ships only the small delta — the four insertion
 * sites — never a copy of DeepSeek's proprietary adapter file, so the runtime
 * keeps its own license and the repo stays patch-only.
 *
 * The splice is line-anchored and byte-preserving: it rewrites only the four
 * insertion sites, keeps the original line endings, and fails loudly if an
 * upstream change moves any anchor, so a newer runtime can never be silently
 * half-patched.
 *
 * Usage:
 *   node patch-pi-ai-oauth.mjs <runtimeRoot>            # patch (idempotent)
 *   node patch-pi-ai-oauth.mjs <runtimeRoot> --check    # verify only, no write
 *   node patch-pi-ai-oauth.mjs <runtimeRoot> --restore  # restore from backup
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const [runtimeRootArg, modeArg = 'patch'] = process.argv.slice(2)
if (!runtimeRootArg) {
  console.error('usage: node patch-pi-ai-oauth.mjs <runtimeRoot> [--check|--restore]')
  process.exit(2)
}
const runtimeRoot = runtimeRootArg.replace(/[\\/]+$/, '')
const libDir = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib')
const target = join(libDir, 'index.js')
const backup = join(libDir, 'index.js.oauth-bak')
const mode = modeArg === '--check' ? 'check' : modeArg === '--restore' ? 'restore' : 'patch'

if (mode === 'restore') {
  if (!existsSync(backup)) {
    console.error(`no backup to restore from: ${backup}`)
    process.exit(2)
  }
  copyFileSync(backup, target)
  console.log(`[restore] restored ${target} from ${backup}`)
  process.exit(0)
}

if (!existsSync(target)) {
  console.error(`adapter not found: ${target}\n  is <runtimeRoot> the runtime tree root?`)
  process.exit(2)
}

const raw = readFileSync(target, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const upstreamIntegrated = raw.includes('function credentialStoreFrom(ctx)')
  && raw.includes('createModels(this.config.auth)')
if (upstreamIntegrated) {
  console.log('[check] upstream credential and OAuth seams are integrated; legacy patch is unnecessary')
  syntaxCheck(target)
  process.exit(0)
}

const already = raw.includes('class FileCredentialStore') && raw.includes('oauthCredentialsPath')
if (already) {
  if (mode === 'check') {
    console.log('[check] already patched — markers present')
    syntaxCheck(target)
  } else {
    console.log(`[patch] already patched — nothing to do (${target})`)
  }
  process.exit(0)
}
if (mode === 'check') {
  console.error('[check] NOT patched (markers absent)')
  process.exit(1)
}

// ── anchors (matched on trimmed text so upstream re-indentation survives) ──
const ANCHOR_IMPORT = 'import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";'
const ANCHOR_CREATE_MODELS = 'const models = createModels();'
const ANCHOR_DIRECTORY_RETURN = 'return [...entries.values()];'
const ANCHOR_RESOLVE_ATTACHMENTS = 'resolveAttachments: () => ctx.get("attachments")'

const trimmed = lines.map((l) => l.trim())
const idxOf = (needle, what) => {
  const hits = []
  for (let i = 0; i < trimmed.length; i++) if (trimmed[i] === needle) hits.push(i)
  if (hits.length !== 1) {
    console.error(`[patch] anchor not found or ambiguous for ${what} (${hits.length} hits): ${needle}`)
    process.exit(3)
  }
  return hits[0]
}

const idxImport = idxOf(ANCHOR_IMPORT, 'dsh-timeout import')
const idxCreate = idxOf(ANCHOR_CREATE_MODELS, 'createModels() call')
const idxReturn = idxOf(ANCHOR_DIRECTORY_RETURN, 'directoryEntries return')
if (trimmed[idxReturn + 1] !== '}') {
  console.error('[patch] expected "}" right after directoryEntries return — upstream layout changed')
  process.exit(3)
}
const idxAttach = idxOf(ANCHOR_RESOLVE_ATTACHMENTS, 'resolveAttachments property')

const indent = (line, prefix) => (line.length ? prefix + line.replace(/^\s*/, '') : line)

// ── payloads (the whole delta; byte-identical to the reference patch) ────────
const PAYLOAD_IMPORTS = [
  '// OAuth persistence seam (subscription login for catalog routes such as',
  '// openai-codex): the stock adapter passes no credential store to createModels,',
  '// so pi-ai resolves OAuth from its default in-memory store and every request',
  '// on such a route fails "Provider is not configured". The file-backed store',
  '// below gives the route the same durable, refresh-persisting storage pi-ai\'s',
  '// own CLI login flow writes.',
  'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
  'import { homedir } from "node:os";',
  'import { dirname, join } from "node:path";',
]

const PAYLOAD_CLASS = [
  '/**',
  ' * File-backed pi-ai credential store for the OAuth-only provider routes the',
  ' * stock adapter cannot serve (`openai-codex` is the one the installed catalog',
  ' * ships). Mirrors pi-ai\'s `InMemoryCredentialStore` semantics — per-provider',
  ' * serialized writes, `modify` keeping the previous credential on `undefined` —',
  ' * with JSON persistence under the harness home, so a ChatGPT subscription',
  ' * login survives restarts and token refreshes stay durable.',
  ' */',
  'class FileCredentialStore {',
  '\tpath;',
  '\tcredentials = new Map();',
  '\tchains = new Map();',
  '\tconstructor(path) {',
  '\t\tthis.path = path;',
  '\t\ttry {',
  '\t\t\tconst raw = JSON.parse(readFileSync(path, "utf-8"));',
  '\t\t\tfor (const [providerId, credential] of Object.entries(raw)) this.credentials.set(providerId, credential);',
  '\t\t} catch {',
  '\t\t\t// Absent or unreadable: start empty and persist on the first write.',
  '\t\t}',
  '\t}',
  '\t/** Serialize tasks per provider id, matching the in-memory store. */',
  '\tenqueue(providerId, task) {',
  '\t\tconst previous = this.chains.get(providerId) ?? Promise.resolve();',
  '\t\tconst next = (async () => {',
  '\t\t\tawait previous.catch(() => { });',
  '\t\t\treturn task();',
  '\t\t})();',
  '\t\tthis.chains.set(providerId, next.catch(() => { }));',
  '\t\treturn next;',
  '\t}',
  '\tpersist() {',
  '\t\tmkdirSync(dirname(this.path), { recursive: true });',
  '\t\twriteFileSync(this.path, JSON.stringify(Object.fromEntries(this.credentials), null, 2));',
  '\t}',
  '\tasync read(providerId) {',
  '\t\treturn this.credentials.get(providerId);',
  '\t}',
  '\tasync list() {',
  '\t\treturn [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));',
  '\t}',
  '\tmodify(providerId, fn) {',
  '\t\treturn this.enqueue(providerId, async () => {',
  '\t\t\tconst current = this.credentials.get(providerId);',
  '\t\t\tconst next = await fn(current);',
  '\t\t\tif (next !== void 0) this.credentials.set(providerId, next);',
  '\t\t\tthis.persist();',
  '\t\t\treturn next ?? current;',
  '\t\t});',
  '\t}',
  '\tdelete(providerId) {',
  '\t\treturn this.enqueue(providerId, async () => {',
  '\t\t\tthis.credentials.delete(providerId);',
  '\t\t\tthis.persist();',
  '\t\t});',
  '\t}',
  '}',
  '/**',
  ' * The managed OAuth credential document: `$DSH_HOME/oauth-credentials.json`,',
  ' * falling back to `~/.dsh` when DSH_HOME is unset, matching dsh-home-paths.',
  ' * The standalone login script writes the same file, so the app and the',
  ' * one-time login share one store.',
  ' */',
  'function oauthCredentialsPath() {',
  '\tconst home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");',
  '\treturn join(home, "oauth-credentials.json");',
  '}',
]

// ── splice ───────────────────────────────────────────────────────────────────
const out = []
let i = 0
while (i < lines.length) {
  if (i === idxImport) {
    out.push(lines[i])
    for (const line of PAYLOAD_IMPORTS) out.push(line)
    i++
    continue
  }
  if (i === idxCreate) {
    out.push(indent('const models = createModels(this.config.credentials === void 0 ? void 0 : { credentials: this.config.credentials });', lines[i].match(/^\s*/)[0]))
    i++
    continue
  }
  if (i === idxReturn) {
    out.push(lines[i]) // return [...entries.values()];
    out.push(lines[i + 1]) // }
    for (const line of PAYLOAD_CLASS) out.push(line)
    i += 2
    continue
  }
  if (i === idxAttach) {
    out.push(indent('resolveAttachments: () => ctx.get("attachments"),', lines[i].match(/^\s*/)[0]))
    out.push(indent('credentials: new FileCredentialStore(oauthCredentialsPath())', lines[i].match(/^\s*/)[0]))
    i++
    continue
  }
  out.push(lines[i])
  i++
}

const patched = out.join(eol)

// ── commit with backup + syntax verification ─────────────────────────────────
if (!existsSync(backup)) {
  copyFileSync(target, backup)
  console.log(`[patch] backed up original to ${backup}`)
}
writeFileSync(target, patched)
console.log(`[patch] wrote ${target} (+${out.length - lines.length} lines)`)
syntaxCheck(target)
console.log('[patch] ok — OAuth credential seam installed (log in with config-example/oauth-login-openai-codex.mjs)')

function syntaxCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  } catch {
    console.error(`[patch] syntax check FAILED on ${file} — restore with --restore`)
    process.exit(4)
  }
}
