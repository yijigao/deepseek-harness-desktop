'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('modelSettings', {
  getHealth: () => ipcRenderer.invoke('model-settings:health'),
  loginChatGPT: () => ipcRenderer.invoke('model-settings:login'),
  openDshHome: () => ipcRenderer.invoke('model-settings:open-home'),
})
