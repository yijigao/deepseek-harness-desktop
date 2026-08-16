'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('harnessLab', Object.freeze({
  listRuns: () => ipcRenderer.invoke('harness-lab:list-runs'),
  getRun: (runId) => ipcRenderer.invoke('harness-lab:get-run', runId),
  compareRuns: (runAId, runBId) => ipcRenderer.invoke('harness-lab:compare-runs', runAId, runBId),
}))
