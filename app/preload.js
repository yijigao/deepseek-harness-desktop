/**
 * Preload: the only bridge into the renderer — window controls for the
 * injected Claude Code style title bar. The web app itself runs untrusted.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshHost', {
  clipboard: { writeText: (text) => ipcRenderer.invoke('cc:write-clipboard', text) },
})

contextBridge.exposeInMainWorld('ccDesktop', {
  minimize: () => ipcRenderer.send('cc:min'),
  toggleMaximize: () => ipcRenderer.send('cc:max'),
  close: () => ipcRenderer.send('cc:close'),
  openModelSettings: () => ipcRenderer.send('cc:open-model-settings'),
  openTaskArchive: () => ipcRenderer.send('cc:open-task-archive'),
  getModelResources: () => ipcRenderer.invoke('cc:model-resources'),
  getEngineState: () => ipcRenderer.invoke('cc:engine-state'),
  recoverEngine: () => ipcRenderer.invoke('cc:recover-engine'),
  onEngineState: (callback) => {
    ipcRenderer.on('cc:engine-state', (_event, value) => callback(value))
  },
  getPinnedSessions: () => ipcRenderer.invoke('cc:get-session-pins'),
  setPinnedSessions: (ids) => ipcRenderer.invoke('cc:set-session-pins', ids),
  writeClipboard: (text) => ipcRenderer.invoke('cc:write-clipboard', text),
  isMaximized: () => ipcRenderer.invoke('cc:isMax'),
  onMaxChanged: (callback) => {
    ipcRenderer.on('cc:max-changed', (_event, value) => callback(Boolean(value)))
  },
  onModelResources: (callback) => {
    ipcRenderer.on('cc:model-resources-updated', (_event, value) => callback(value))
  },
})
