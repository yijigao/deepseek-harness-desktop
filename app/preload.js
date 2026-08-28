/**
 * Preload: the only bridge into the renderer — window controls for the
 * injected Claude Code style title bar. The web app itself runs untrusted.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ccDesktop', {
  minimize: () => ipcRenderer.send('cc:min'),
  toggleMaximize: () => ipcRenderer.send('cc:max'),
  close: () => ipcRenderer.send('cc:close'),
  openHarnessLab: () => ipcRenderer.send('cc:open-harness-lab'),
  openModelSettings: () => ipcRenderer.send('cc:open-model-settings'),
  getModelResources: () => ipcRenderer.invoke('cc:model-resources'),
  getPinnedSessions: () => ipcRenderer.invoke('cc:get-session-pins'),
  setPinnedSessions: (ids) => ipcRenderer.invoke('cc:set-session-pins', ids),
  isMaximized: () => ipcRenderer.invoke('cc:isMax'),
  onMaxChanged: (callback) => {
    ipcRenderer.on('cc:max-changed', (_event, value) => callback(Boolean(value)))
  },
  onModelResources: (callback) => {
    ipcRenderer.on('cc:model-resources-updated', (_event, value) => callback(value))
  },
})
