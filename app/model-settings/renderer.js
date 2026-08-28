'use strict'

const health = document.getElementById('health')
const oauthCopy = document.getElementById('oauth-copy')
const feedback = document.getElementById('feedback')
const quotaGrid = document.getElementById('quota-grid')
const localUsage = document.getElementById('local-usage')
const refreshButton = document.getElementById('refresh')

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 180) : fallback
}

function number(value, fallback = null) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function element(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content != null) node.textContent = String(content)
  return node
}

function healthCard(label, value, state) {
  const node = element('div', 'health-card')
  node.append(element('div', 'label', label), element('div', `value ${state === true ? 'ok' : state === false ? 'bad' : ''}`, value))
  return node
}

function compactTokens(value) {
  const numeric = number(value, 0)
  return new Intl.NumberFormat('zh-CN', { notation: numeric >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(numeric)
}

function formatUpdated(iso) {
  const timestamp = Date.parse(text(iso))
  if (!Number.isFinite(timestamp)) return '尚未完成更新'
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return '刚刚更新'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前更新`
  return new Date(timestamp).toLocaleString('zh-CN')
}

function formatReset(window) {
  const resetAt = Date.parse(text(window?.resetAt))
  const after = number(window?.resetAfterSeconds)
  const remainingMs = Number.isFinite(resetAt) ? resetAt - Date.now() : after == null ? null : after * 1000
  if (remainingMs == null) return '重置时间未知'
  if (remainingMs <= 0) return '即将重置'
  const hours = Math.floor(remainingMs / 3_600_000)
  const minutes = Math.ceil((remainingMs % 3_600_000) / 60_000)
  const countdown = hours ? `${hours} 小时 ${minutes} 分后` : `${minutes} 分钟后`
  return Number.isFinite(resetAt) ? `${countdown} · ${new Date(resetAt).toLocaleString('zh-CN')}` : countdown
}

function quotaCard(window) {
  const used = Math.min(100, Math.max(0, number(window?.usedPercent, 0)))
  const remaining = number(window?.remainingPercent, 100 - used)
  const node = element('article', 'quota-card')
  const head = element('div', 'quota-head')
  head.append(element('span', 'label', text(window?.label, '额度窗口')), element('strong', '', `剩余 ${Math.round(remaining)}%`))
  const track = element('div', 'progress-track')
  const bar = element('span', 'progress-value')
  bar.style.width = `${used}%`
  if (remaining <= 10) bar.dataset.level = 'critical'
  else if (remaining <= 30) bar.dataset.level = 'warning'
  track.append(bar)
  node.append(head, track, element('p', 'small muted', formatReset(window)))
  return node
}

function placeholderQuota(message) {
  const node = element('article', 'quota-card quota-placeholder')
  node.append(element('span', 'label', '账户额度'), element('strong', '', '暂不可读'), element('p', 'small muted', message))
  return node
}

function usageCard(label, value) {
  const node = element('article', 'usage-card')
  node.append(
    element('span', 'label', label),
    element('strong', '', `${compactTokens(value.totalTokens)} tokens`),
    element('p', 'small muted', `${compactTokens(value.requests)} 次回复 · 输入 ${compactTokens(value.inputTokens)} · 输出 ${compactTokens(value.outputTokens)}`),
  )
  return node
}

function renderResources(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  if (!document.body.dataset.resourceRenderMs) document.body.dataset.resourceRenderMs = String(Math.round(performance.now()))
  const provider = text(snapshot.route?.provider, '未知提供商')
  const model = text(snapshot.route?.model, '未知模型')
  document.getElementById('route-name').textContent = `${provider} / ${model}`
  const source = snapshot.route?.source === 'active-session' ? '来自最近活动会话' : snapshot.route?.source === 'default-settings' ? '来自默认模型设置' : '模型来源未知'
  document.getElementById('route-meta').textContent = `${source} · ${formatUpdated(snapshot.updatedAt)}`

  const status = text(snapshot.quota?.status, 'unavailable')
  const state = document.getElementById('quota-state')
  state.textContent = status === 'available' ? '账户数据可用' : status === 'stale' ? '显示上次数据' : status === 'refreshing' ? '后台更新中' : '本机账本可用'
  state.dataset.state = status
  const windows = Array.isArray(snapshot.quota?.windows) ? snapshot.quota.windows : []
  const cards = windows.map(quotaCard)
  const credits = snapshot.quota?.credits
  if (credits) {
    const card = element('article', 'quota-card')
    const value = credits.unlimited ? '不限量' : number(credits.balance) == null ? (credits.hasCredits ? '可用' : '未提供') : `${credits.balance} credits`
    card.append(element('span', 'label', '扩展积分'), element('strong', '', value), element('p', 'small muted', '账户级资源，不归属于单一模型'))
    cards.push(card)
  }
  if (!cards.length) cards.push(placeholderQuota(text(snapshot.quota?.message, '后台额度服务暂不可用。')))
  quotaGrid.replaceChildren(...cards)
  document.getElementById('quota-message').textContent = text(snapshot.quota?.message)

  const current = snapshot.localUsage?.currentSession || {}
  const today = snapshot.localUsage?.today || {}
  const month = snapshot.localUsage?.month || {}
  localUsage.replaceChildren(usageCard('当前会话', current), usageCard('今天', today), usageCard('本月', month))
  document.getElementById('usage-scope').textContent = `已扫描 ${Math.max(0, number(snapshot.localUsage?.scannedSessions, 0))} 个近期会话`

  const remaining = number(windows[0]?.remainingPercent)
  const quotaMessage = text(snapshot.quota?.message)
  document.getElementById('recommendation').textContent = /登录凭据|重新登录/.test(quotaMessage)
    ? 'ChatGPT 授权已过期。点击“登录 ChatGPT”完成授权，再点“后台刷新”即可读取真实额度。'
    : remaining != null && remaining <= 10
    ? '当前短周期额度紧张。建议缩小任务范围、降低推理等级，或临时切换到 Luna / 备用提供商。'
    : remaining != null && remaining <= 30
      ? '额度进入注意区间，长任务开始前建议先确认周额度和重置时间。'
      : '资源状态正常；账户数据不可读时，以本机账本和官方用量页面为准。'
}

async function refreshHealth() {
  try {
    const data = await window.modelSettings.getHealth()
    health.replaceChildren(
      healthCard('Desktop', `v${text(data.appVersion, '未知')}`, true),
      healthCard('DSH Runtime', data.dshVersion ? `${text(data.dshVersion)} (${text(data.dshCommit, 'unknown')})` : '版本未知', Boolean(data.dshVersion)),
      healthCard('本地服务', data.serverRunning ? '运行中' : '未运行', data.serverRunning),
      healthCard('运行时文件', data.runtimePresent ? '完整' : '缺失', data.runtimePresent),
      healthCard('settings.yaml', data.settingsPresent ? '已配置' : '尚未创建', data.settingsPresent),
      healthCard('OAuth 适配', data.patch?.ok === true ? '兼容' : data.patch?.ok === false ? '需要修复' : '后台检测中', data.patch?.ok),
    )
    oauthCopy.textContent = data.oauth?.present
      ? `ChatGPT 已登录${data.oauth.expires ? ` · 凭据有效期至 ${new Date(data.oauth.expires).toLocaleString('zh-CN')}` : ''}`
      : '尚未检测到 ChatGPT 登录凭据。'
    if (data.resources) renderResources(data.resources)
  } catch {
    feedback.textContent = '无法读取本地运行状态。'
  }
}

async function initialLoad() {
  feedback.textContent = ''
  const [resources] = await Promise.allSettled([window.modelSettings.getResources(), refreshHealth()])
  if (resources.status === 'fulfilled') renderResources(resources.value)
}

refreshButton.addEventListener('click', async () => {
  feedback.textContent = '后台读取账户额度和本机会话，窗口可以继续使用。'
  refreshButton.disabled = true
  refreshButton.textContent = '后台更新中…'
  try {
    renderResources(await window.modelSettings.refreshResources())
    feedback.textContent = '资源数据已更新。'
  } catch {
    feedback.textContent = '账户服务暂不可用，已保留缓存和本机用量。'
  } finally {
    refreshButton.disabled = false
    refreshButton.textContent = '后台刷新'
  }
})

document.getElementById('open-usage').addEventListener('click', () => window.modelSettings.openUsageDashboard())
document.getElementById('open-home').addEventListener('click', () => window.modelSettings.openDshHome())
document.getElementById('login').addEventListener('click', async () => {
  feedback.textContent = '正在启动浏览器授权；完成后点击“后台刷新”。'
  try { await window.modelSettings.loginChatGPT() } catch { feedback.textContent = '登录进程启动失败。' }
})
window.modelSettings.onResources(renderResources)
initialLoad()
