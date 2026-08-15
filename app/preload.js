/**
 * Preload: the only bridge into the renderer — window controls for the
 * injected Claude Code style title bar. The web app itself runs untrusted.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ccDesktop', {
  minimize: () => ipcRenderer.send('cc:min'),
  toggleMaximize: () => ipcRenderer.send('cc:max'),
  close: () => ipcRenderer.send('cc:close'),
  isMaximized: () => ipcRenderer.invoke('cc:isMax'),
  onMaxChanged: (callback) => {
    ipcRenderer.on('cc:max-changed', (_event, value) => callback(Boolean(value)))
  },
})
