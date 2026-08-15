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
    bar.innerHTML = '<span class="cc-mark">\u2733</span>'
      + '<span class="cc-name">DeepSeek</span>'
      + '<span class="cc-spacer"></span>'
      + '<button class="cc-btn" data-act="min" title="Minimize">\u2013</button>'
      + '<button class="cc-btn" data-act="max" title="Maximize">\u25A1</button>'
      + '<button class="cc-btn cc-close" data-act="close" title="Close">\u00D7</button>'
    document.body.prepend(bar)

    const min = bar.querySelector('[data-act="min"]')
    const max = bar.querySelector('[data-act="max"]')
    const close = bar.querySelector('[data-act="close"]')
    min.addEventListener('click', () => window.ccDesktop.minimize())
    close.addEventListener('click', () => window.ccDesktop.close())
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
