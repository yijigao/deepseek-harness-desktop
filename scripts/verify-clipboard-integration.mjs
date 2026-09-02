/** Verify that the compiled Harness frontend contains the source-level desktop clipboard bridge. */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyRuntime(runtimeRoot) {
  const assets = path.join(path.resolve(runtimeRoot), 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
  const bundles = readdirSync(assets).filter((name) => name.endsWith('.js'))
  const target = bundles.find((name) => {
    const source = readFileSync(path.join(assets, name), 'utf8')
    return source.includes('ccDesktop') && source.includes('writeClipboard')
  })
  if (!target) throw new Error('compiled frontend does not contain the native clipboard host integration')
  return path.join(assets, target)
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  const root = process.argv[2]
  if (!root) { console.error('usage: node verify-clipboard-integration.mjs <runtimeRoot>'); process.exitCode = 2 }
  else { try { console.log(`[clipboard] source integration ready: ${verifyRuntime(root)}`) } catch (error) { console.error(`[clipboard] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 } }
}
