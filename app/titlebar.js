/**
 * Injected into the page by the desktop shell: builds the Claude Code style
 * window chrome (✳ DeepSeek + traffic controls) above the web UI.
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
      + '<button class="cc-lab" data-act="lab" title="Open Harness Lab">Harness Lab</button>'
      + '<button class="cc-lab" data-act="settings" title="模型资源中心">模型资源</button>'
      + '<button class="cc-resource-chip" data-act="resources" title="打开模型资源中心"><span class="cc-resource-model">模型识别中</span><span class="cc-resource-quota">本机用量加载中</span></button>'
      + '<span class="cc-spacer"></span>'
      + '<button class="cc-btn" data-act="min" title="Minimize">\u2013</button>'
      + '<button class="cc-btn" data-act="max" title="Maximize">\u25A1</button>'
      + '<button class="cc-btn cc-close" data-act="close" title="Close">\u00D7</button>'
    document.body.prepend(bar)

    const min = bar.querySelector('[data-act="min"]')
    const max = bar.querySelector('[data-act="max"]')
    const close = bar.querySelector('[data-act="close"]')
    const lab = bar.querySelector('[data-act="lab"]')
    const settings = bar.querySelector('[data-act="settings"]')
    const resources = bar.querySelector('[data-act="resources"]')
    min.addEventListener('click', () => window.ccDesktop.minimize())
    close.addEventListener('click', () => window.ccDesktop.close())
    lab.addEventListener('click', () => window.ccDesktop.openHarnessLab())
    settings.addEventListener('click', () => window.ccDesktop.openModelSettings())
    resources.addEventListener('click', () => window.ccDesktop.openModelSettings())
    const compactModel = (model) => String(model || '未知模型').replace(/^gpt-/i, '').slice(0, 24)
    const renderResources = (snapshot) => {
      if (!snapshot || !resources) return
      const model = resources.querySelector('.cc-resource-model')
      const quota = resources.querySelector('.cc-resource-quota')
      model.textContent = compactModel(snapshot.route?.model)
      const primary = snapshot.quota?.windows?.[0]
      if (Number.isFinite(primary?.remainingPercent)) {
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
  // The shell renders late (React); retry until the body accepts the bar.
  const timer = setInterval(() => {
    if (document.getElementById('cc-titlebar')) { clearInterval(timer); return }
    tryRun()
  }, 400)
  setTimeout(() => clearInterval(timer), 15000)
})()
