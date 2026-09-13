/**
 * Builds the lightweight DeepSea Signal desktop control bar.
 */
(() => {
  if (document.getElementById('cc-titlebar')) return
  if (!window.ccDesktop) return
  const tryRun = () => {
    if (!document.body || document.getElementById('cc-titlebar')) return
    const bar = document.createElement('div')
    bar.id = 'cc-titlebar'
    bar.innerHTML = '<img class="cc-mark" src="__DEEPSEEK_LOGO_DATA_URL__" alt="" draggable="false">'
      + '<span class="cc-name">DeepSeek</span>'
      + '<button class="cc-lab" data-act="tasks" title="任务档案与批次验收">任务</button>'
      + '<button class="cc-lab" data-act="settings" title="模型资源中心">模型资源</button>'
      + '<button class="cc-resource-chip" data-act="resources" title="打开模型资源中心"><span class="cc-resource-model">模型识别中</span><span class="cc-resource-quota">本机用量加载中</span></button>'
      + '<span class="cc-spacer"></span>'
      + '<button class="cc-lab" data-act="recover" hidden>引擎离线 · 重新连接</button>'
      + '<button class="cc-btn" data-act="min" title="Minimize">\u2013</button>'
      + '<button class="cc-btn" data-act="max" title="Maximize">\u25A1</button>'
      + '<button class="cc-btn cc-close" data-act="close" title="Close">\u00D7</button>'
    const mark = bar.querySelector('.cc-mark')
    mark.addEventListener('error', () => { mark.hidden = true; mark.style.display = 'none' })
    if (!mark.getAttribute('src')) { mark.hidden = true; mark.style.display = 'none' }
    document.body.prepend(bar)

    const min = bar.querySelector('[data-act="min"]')
    const max = bar.querySelector('[data-act="max"]')
    const close = bar.querySelector('[data-act="close"]')
    const settings = bar.querySelector('[data-act="settings"]')
    const tasks = bar.querySelector('[data-act="tasks"]')
    const resources = bar.querySelector('[data-act="resources"]')
    const recovery = bar.querySelector('[data-act="recover"]')
    const renderEngine = ({ state }) => {
      recovery.hidden = state === 'online'
      recovery.style.display = state === 'online' ? 'none' : ''
      recovery.disabled = state === 'recovering'
      recovery.textContent = state === 'recovering' ? '正在恢复引擎…' : '引擎离线 · 重新连接'
    }
    recovery.addEventListener('click', () => window.ccDesktop.recoverEngine().catch(() => {}))
    window.ccDesktop.onEngineState(renderEngine)
    window.ccDesktop.getEngineState().then(renderEngine).catch(() => {})
    min.addEventListener('click', () => window.ccDesktop.minimize())
    close.addEventListener('click', () => window.ccDesktop.close())
    settings.addEventListener('click', () => window.ccDesktop.openModelSettings())
    tasks.addEventListener('click', () => window.ccDesktop.openTaskArchive())
    resources.addEventListener('click', () => window.ccDesktop.openModelSettings())
    const compactModel = (model) => String(model || '未知模型').replace(/^gpt-/i, '').slice(0, 24)
    const renderResources = (snapshot) => {
      if (!snapshot || !resources) return
      const model = resources.querySelector('.cc-resource-model')
      const quota = resources.querySelector('.cc-resource-quota')
      model.textContent = compactModel(snapshot.route?.model)
      const primary = snapshot.quota?.windows?.[0]
      const deepseek = Array.isArray(snapshot.resources) ? snapshot.resources.find((item) => item?.provider === 'deepseek-official') : null
      const balance = deepseek?.balances?.[0]
      if (snapshot.route?.provider === 'deepseek-official' && Number.isFinite(balance?.total)) {
        quota.textContent = `余额 ${balance.currency || 'CNY'} ${Number(balance.total).toFixed(2)}`
        resources.dataset.level = deepseek.available === false ? 'warning' : 'ok'
      } else if (Number.isFinite(primary?.remainingPercent)) {
        const remaining = Math.round(primary.remainingPercent)
        quota.textContent = `${primary.label || '额度'}剩余 ${remaining}%`
        resources.dataset.level = remaining <= 10 ? 'critical' : remaining <= 30 ? 'warning' : 'ok'
      } else {
        const tokens = Number(snapshot.localUsage?.today?.totalTokens) || 0
        quota.textContent = tokens > 0 ? `今日 ${new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(tokens)} tokens` : '额度后台更新中'
        resources.dataset.level = 'unknown'
      }
    }
    window.ccDesktop.onModelResources(renderResources)
    window.ccDesktop.getModelResources().then(renderResources).catch(() => {})
    const renderMax = (isMax) => {
      max.textContent = isMax ? '\u2750' : '\u25A1'
      max.title = isMax ? 'Restore' : 'Maximize'
    }
    max.addEventListener('click', () => window.ccDesktop.toggleMaximize())
    window.ccDesktop.onMaxChanged(renderMax)
    window.ccDesktop.isMaximized().then(renderMax)
  }
  tryRun()
})()
