'use strict'

const health = document.getElementById('health')
const oauthCopy = document.getElementById('oauth-copy')
const feedback = document.getElementById('feedback')

function card(label, value, state) {
  const node = document.createElement('div')
  node.className = 'card'
  const labelNode = document.createElement('div')
  labelNode.className = 'label'
  labelNode.textContent = label
  const valueNode = document.createElement('div')
  valueNode.className = `value ${state === true ? 'ok' : state === false ? 'bad' : ''}`
  valueNode.textContent = value
  node.append(labelNode, valueNode)
  return node
}

async function refresh() {
  feedback.textContent = ''
  try {
    const data = await window.modelSettings.getHealth()
    health.replaceChildren(
      card('Desktop', `v${data.appVersion}`, true),
      card('DSH Runtime', data.dshVersion ? `${data.dshVersion} (${data.dshCommit || 'unknown'})` : '版本未知', Boolean(data.dshVersion)),
      card('本地服务', data.serverRunning ? '运行中' : '未运行', data.serverRunning),
      card('运行时文件', data.runtimePresent ? '完整' : '缺失', data.runtimePresent),
      card('settings.yaml', data.settingsPresent ? '已配置' : '尚未创建', data.settingsPresent),
      card('OAuth 适配', data.patch.ok ? '兼容' : '需要修复', data.patch.ok),
      card('DSH_HOME', data.dshHome),
    )
    oauthCopy.textContent = data.oauth.present
      ? `已登录${data.oauth.accountId ? ` · ${data.oauth.accountId}` : ''}${data.oauth.expires ? ` · 有效期至 ${new Date(data.oauth.expires).toLocaleString()}` : ''}`
      : '尚未检测到 ChatGPT 登录凭据。'
  } catch {
    feedback.textContent = '无法读取本地运行状态。'
  }
}

document.getElementById('refresh').addEventListener('click', refresh)
document.getElementById('open-home').addEventListener('click', () => window.modelSettings.openDshHome())
document.getElementById('login').addEventListener('click', async () => {
  feedback.textContent = '正在启动浏览器授权；完成后点击“刷新”。'
  try { await window.modelSettings.loginChatGPT() } catch { feedback.textContent = '登录进程启动失败。' }
})

refresh()
