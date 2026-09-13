'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// No paths, shell APIs, URLs, or Electron objects are exposed to this page.
contextBridge.exposeInMainWorld('taskArchive', {
  bind: (metadata) => ipcRenderer.invoke('task-archive:bind', metadata),
  list: () => ipcRenderer.invoke('task-archive:list'),
  read: (taskId) => ipcRenderer.invoke('task-archive:read', taskId),
  checkpoint: (taskId, revision, metadata) => ipcRenderer.invoke('task-archive:checkpoint', taskId, revision, metadata),
  inspect: (taskId, itemId) => ipcRenderer.invoke('task-archive:inspect', taskId, itemId),
  accept: (taskId, itemId, sourceSha256, manifestSha256, artifactSha256) => ipcRenderer.invoke('task-archive:accept', taskId, itemId, sourceSha256, manifestSha256, artifactSha256),
  retryPlan: (taskId) => ipcRenderer.invoke('task-archive:retry-plan', taskId),
})
