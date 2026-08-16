import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fileList = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).split('\0').filter(Boolean)

const patterns = [
  {
    id: 'private-key-material',
    expression: new RegExp(`${['BEGIN', 'PRIVATE', 'KEY'].join('[- ]+')}|${['BEGIN', 'OPENSSH', 'PRIVATE', 'KEY'].join('[- ]+')}`, 'i'),
  },
  {
    id: 'provider-token-shape',
    expression: new RegExp(`\\b${['s', 'k'].join('')}-[A-Za-z0-9_-]{16,}\\b`),
  },
  {
    id: 'github-token-shape',
    expression: new RegExp(`\\b(?:${['g', 'h', 'p'].join('')}_[A-Za-z0-9]{20,}|${['github', 'pat'].join('_')}_[A-Za-z0-9_]{20,})\\b`, 'i'),
  },
  {
    id: 'bearer-credential',
    expression: new RegExp(`\\b${['Bear', 'er'].join('')}\\s+[A-Za-z0-9._~+/-]{16,}`, 'i'),
  },
  {
    id: 'credential-in-url',
    expression: /\b(?:https?|socks5?):\/\/[^\s/@:]+:[^\s/@]+@/i,
  },
  {
    id: 'credential-assignment',
    expression: /(?:api[_-]?key|apikey|authorization|password|secret|cookie|session[_-]?token|access[_-]?token)\s*["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
]

const findings = []
for (const relativePath of fileList) {
  const absolutePath = path.join(repositoryRoot, relativePath)
  let buffer
  try {
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue
    buffer = fs.readFileSync(absolutePath)
  } catch {
    continue
  }
  if (buffer.includes(0)) continue
  const lines = buffer.toString('utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    const scanLine = line
      .replace(/synthetic-placeholder/gi, '')
      .replace(/\[(?:REDACTED|CONTENT OMITTED|PATH)\]/gi, '')
      .replace(/<[^>]+>/g, '')
    for (const pattern of patterns) {
      if (pattern.expression.test(scanLine)) findings.push({ file: relativePath, line: index + 1, rule: pattern.id })
      pattern.expression.lastIndex = 0
    }
  })
}

if (findings.length > 0) {
  console.error(`Secret scan failed with ${findings.length} finding(s).`)
  for (const finding of findings) console.error(`${finding.file}:${finding.line} ${finding.rule}`)
  process.exitCode = 1
} else {
  console.log(`Secret scan passed (${fileList.length} project files checked).`)
}
