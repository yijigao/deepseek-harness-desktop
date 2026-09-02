/** Legacy migration for runtimes built before the native clipboard host was integrated upstream. */
import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MARKER = '/* DSH_DESKTOP_NATIVE_CLIPBOARD */'

export function patchClipboardBundle(source) {
  if (source.includes(MARKER)) return { source, changed: false }
  const needle = 'async function y1(n){'
  const start = source.indexOf(needle)
  if (start === -1 || source.indexOf(needle, start + needle.length) !== -1) {
    throw new Error('clipboard patch anchor missing or ambiguous')
  }
  const replacement = `${needle}${MARKER}if(window.ccDesktop?.writeClipboard){try{const e=await window.ccDesktop.writeClipboard(n);if(e)return!0}catch{}}`
  let patched = `${source.slice(0, start)}${replacement}${source.slice(start + needle.length)}`
  const functionEnd = patched.indexOf('}function ', start)
  const bodyEnd = functionEnd === -1 ? patched.length : functionEnd
  const body = patched.slice(start, bodyEnd)
  if (!body.includes('catch{return!1}')) throw new Error('clipboard fallback anchor missing')
  patched = `${patched.slice(0, start)}${body.replace('catch{return!1}', 'catch{}')}${patched.slice(bodyEnd)}`
  return { source: patched, changed: true }
}

function findBundles(runtimeRoot) {
  const assets = path.join(path.resolve(runtimeRoot), 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
  return readdirSync(assets).filter((name) => name.endsWith('.js')).map((name) => path.join(assets, name))
}

export function patchRuntime(runtimeRoot, checkOnly = false) {
  const targets = findBundles(runtimeRoot)
  if (targets.length === 0) throw new Error('dsh-web-frontend bundles not found')
  let matched = 0
  let changed = false
  for (const target of targets) {
    const original = readFileSync(target, 'utf8')
    if (!original.includes('async function y1(n){') && !original.includes(MARKER)) continue
    matched += 1
    if (checkOnly) {
      if (!original.includes(MARKER)) throw new Error(`clipboard patch is not installed: ${target}`)
      continue
    }
    const result = patchClipboardBundle(original)
    if (!result.changed) continue
    const temporary = `${target}.clipboard-${process.pid}.tmp`
    try { writeFileSync(temporary, result.source, { encoding: 'utf8', mode: 0o600 }); renameSync(temporary, target) }
    catch (error) { try { unlinkSync(temporary) } catch {}; throw error }
    changed = true
  }
  if (matched === 0) throw new Error('clipboard function not found in frontend bundles')
  return { changed, targets }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  const root = process.argv[2]
  if (!root) { console.error('usage: node patch-clipboard.mjs <runtimeRoot> [--check]'); process.exitCode = 2 }
  else { try { const result = patchRuntime(root, process.argv[3] === '--check'); console.log(`[clipboard] ${result.changed ? 'installed' : 'ready'}`) } catch (error) { console.error(`[clipboard] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 } }
}
