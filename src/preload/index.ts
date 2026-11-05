// preload/index.ts — contextBridge：把类型化的 NexaApi 暴露给渲染端。
// contextIsolation 全开；渲染端拿到的只是 invoke 封装与事件订阅。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { NexaApi } from '@shared/api'

const invoke = (method: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke('nexa:invoke', method, args)

function subscribe(event: string, cb: (...payload: unknown[]) => void): () => void {
  const listener = (_e: IpcRendererEvent, name: string, payload?: unknown): void => {
    if (name === event) cb(payload)
  }
  ipcRenderer.on('nexa:event', listener)
  return () => ipcRenderer.removeListener('nexa:event', listener)
}

const api: NexaApi = {
  overview: (w) => invoke('overview', w) as never,
  sessionList: (q) => invoke('sessionList', q.agent, q.search, q.limit) as never,
  sessionInfo: (agent, sessionId) => invoke('sessionInfo', agent, sessionId) as never,
  sessionRecords: (agent, sessionId) => invoke('sessionRecords', agent, sessionId) as never,
  sessionMessages: (agent, sessionId) => invoke('sessionMessages', agent, sessionId) as never,
  modelBreakdown: (sinceMs) => invoke('modelBreakdown', sinceMs) as never,
  modelDailySeries: (sinceMs, topModels) => invoke('modelDailySeries', sinceMs, topModels) as never,
  toolBreakdown: (sinceMs, limit) => invoke('toolBreakdown', sinceMs, limit) as never,
  agentStatuses: () => invoke('agentStatuses') as never,
  rawRows: (agent, model, limit) => invoke('rawRows', agent, model, limit) as never,
  recentSpeed: (sinceMs, family, limit) => invoke('recentSpeed', sinceMs, family, limit) as never,
  dailyTotals: (f) => invoke('dailyTotals', f.agent, f.family) as never,
  dailyTokensByModel: (sinceMs, topModels, f) =>
    invoke('dailyTokensByModel', sinceMs, topModels, f.agent, f.family) as never,
  agentTotals: (f) => invoke('agentTotals', f.agent, f.family) as never,
  longestSessionActiveMs: (f) => invoke('longestSessionActiveMs', f.agent, f.family) as never,
  archiveModelFamilies: () => invoke('archiveModelFamilies') as never,
  archiveAgentIds: () => invoke('archiveAgentIds') as never,
  archiveInfo: () => invoke('archiveInfo') as never,
  projectStats: (sinceMs) => invoke('projectStats', sinceMs) as never,
  brakeStats: (sinceMs) => invoke('brakeStats', sinceMs) as never,
  dayReplay: (startMs, endMs) => invoke('dayReplay', startMs, endMs) as never,
  deepScan: (sinceMs) => invoke('deepScan', sinceMs) as never,
  zcodeDiagnostics: (sinceMs) => invoke('zcodeDiagnostics', sinceMs) as never,
  mergeArchiveFile: (path) => invoke('mergeArchiveFile', path) as never,
  dailyDigest: () => invoke('dailyDigest') as never,

  getSettings: () => ipcRenderer.invoke('nexa:getSettings') as never,
  setSettings: (patch) => ipcRenderer.invoke('nexa:setSettings', patch) as never,
  applyOverlay: (theme) => ipcRenderer.invoke('nexa:applyOverlay', theme) as never,
  pickDirectory: () => ipcRenderer.invoke('nexa:pickDirectory') as never,
  pickArchive: () => ipcRenderer.invoke('nexa:pickArchive') as never,

  on: ((event: string, cb: (payload?: unknown) => void) =>
    subscribe(event, cb)) as unknown as NexaApi['on']
}

contextBridge.exposeInMainWorld('nexa', api)
