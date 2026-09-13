'use strict'
const fs = require('node:fs')
const path = require('node:path')

// This is an installed-capability check, not a login or provider eligibility test.
function nativeCredentialIntegration(runtime, exists = fs.existsSync) {
  const required = ['dsh-credentials-local', 'dsh-llm-pi-ai']
  if (!required.every(name => exists(path.join(runtime, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')))) return null
  return { ok: true, mode: 'native', detail: '原生凭据组件已安装，无需旧 OAuth 补丁。账号有效性以资源查询结果为准。' }
}

module.exports = { nativeCredentialIntegration }
