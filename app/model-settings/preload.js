'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('modelSettings', {
  getHealth: () => ipcRenderer.invoke('model-settings:health'),
  getResources: () => ipcRenderer.invoke('model-settings:resources'),
  refreshResources: () => ipcRenderer.invoke('model-settings:refresh-resources'),
  loginChatGPT: () => ipcRenderer.invoke('model-settings:login'),
  openUsageDashboard: () => ipcRenderer.invoke('model-settings:open-usage'),
  openDshHome: () => ipcRenderer.invoke('model-settings:open-home'),
  onResources: (callback) => {
    ipcRenderer.on('model-settings:resources-updated', (_event, value) => callback(value))
  },
})
