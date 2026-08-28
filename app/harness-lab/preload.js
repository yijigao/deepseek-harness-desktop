'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('harnessLab', Object.freeze({
  listRuns: () => ipcRenderer.invoke('harness-lab:list-runs'),
  getRun: (runId) => ipcRenderer.invoke('harness-lab:get-run', runId),
  compareRuns: (runAId, runBId) => ipcRenderer.invoke('harness-lab:compare-runs', runAId, runBId),
  copyOptimizationBrief: (runAId, runBId) => ipcRenderer.invoke('harness-lab:copy-brief', runAId, runBId),
  exportReport: (runAId, runBId) => ipcRenderer.invoke('harness-lab:export-report', runAId, runBId),
  setBaseline: (runId) => ipcRenderer.invoke('harness-lab:set-baseline', runId),
  copyRunFix: (runId) => ipcRenderer.invoke('harness-lab:copy-run-fix', runId),
  openOriginal: (runId) => ipcRenderer.invoke('harness-lab:open-original', runId),
}))
