// main/data/worker.ts — 数据服务 worker 线程。
// 所有磁盘 IO / SQLite / 解析都在这里跑，主进程零阻塞（对应老项目
// "GUI 线程零磁盘 IO" 的承诺）。主进程通过简单 RPC（requestId 映射）
// 调用本线程；扫描事件经 parentPort 推回。

import { parentPort, workerData } from 'node:worker_threads'
import { initPaths } from '../core/paths'
import { Store } from './store'
import type { CustomAgentConfig, ScanResult, UsageRecord } from '@shared/types'

interface WorkerData {
  userData: string
  retentionDays: number
  customAgents?: CustomAgentConfig[]
}

const data = workerData as WorkerData
initPaths(data.userData)

const store = new Store()
if (Array.isArray(data.customAgents)) store.setCustomAgents(data.customAgents)

type RpcMethod = string
interface RpcRequest {
  type: 'rpc'
  id: number
  method: RpcMethod
  args: unknown[]
}
interface EventMessage {
  type: 'event'
  event: string
  payload?: unknown
}

const port = parentPort!
if (!port) throw new Error('worker 必须经 worker_threads 启动')

function post(msg: EventMessage): void {
  port.postMessage(msg)
}

// ── RPC 分发表 ──

type Handler = (args: unknown[]) => unknown
const handlers = new Map<RpcMethod, Handler>([
  [
    'scan',
    () => {
      const { result, fresh } = store.scan()
      return { result, fresh }
    }
  ],
  ['overview', ([window]) => store.overview(window as Parameters<Store['overview']>[0])],
  ['sessionList', ([agent, search, limit]) => store.sessionList(String(agent), String(search ?? ''), Number(limit ?? 500))],
  ['sessionInfo', ([agent, sessionId]) => store.sessionInfo(String(agent), String(sessionId))],
  ['sessionRecords', ([agent, sessionId]) => store.sessionRecords(String(agent), String(sessionId))],
  ['sessionMessages', ([agent, sessionId]) => {
    const r = store.parseSessionMessages(String(agent), String(sessionId))
    if (!r.ok) throw new Error(r.err)
    return r.messages
  }],
  ['modelBreakdown', ([sinceMs]) => store.modelBreakdown(Number(sinceMs ?? 0))],
  ['modelDailySeries', ([sinceMs, top]) => store.modelDailySeries(Number(sinceMs ?? 0), Number(top ?? 5))],
  ['toolBreakdown', ([sinceMs, limit]) => store.toolBreakdown(Number(sinceMs ?? 0), Number(limit ?? 30))],
  ['agentStatuses', () => store.agentStatuses()],
  ['lastScanMs', () => store.lastScanMs()],
  ['rawRows', ([agent, model, limit]) => store.rawRows(String(agent ?? ''), String(model ?? ''), Number(limit ?? 400))],
  ['recentSpeed', ([sinceMs, family, limit]) => store.recentSpeed(Number(sinceMs ?? 0), String(family ?? ''), Number(limit ?? 60))],
  ['dailyTotals', ([agent, family]) => store.dailyTotals(String(agent ?? ''), String(family ?? ''))],
  ['dailyTokensByModel', ([sinceMs, top, agent, family]) =>
    store.dailyTokensByModel(Number(sinceMs ?? 0), Number(top ?? 5), String(agent ?? ''), String(family ?? ''))],
  ['agentTotals', ([agent, family]) => store.agentTotals(String(agent ?? ''), String(family ?? ''))],
  ['longestSessionActiveMs', ([agent, family]) => store.longestSessionActiveMs(String(agent ?? ''), String(family ?? ''))],
  ['archiveModelFamilies', () => store.familyNames()],
  ['archiveAgentIds', () => store.archiveAgentIds()],
  ['archiveInfo', () => store.archiveInfo()],
  ['setRetentionDays', ([days]) => {
    store.setRetentionDays(Number(days ?? 730))
    return store.archiveInfo()
  }],
  ['projectStats', ([sinceMs]) => store.projectStats(Number(sinceMs ?? 0))],
  ['brakeStats', ([sinceMs]) => store.brakeStats(Number(sinceMs ?? 0))],
  ['dayReplay', ([startMs, endMs]) => store.dayReplay(Number(startMs ?? 0), Number(endMs ?? 0))],
  ['deepScan', ([sinceMs]) => store.deepScan(Number(sinceMs ?? 0))],
  ['zcodeDiagnostics', ([sinceMs]) => store.zcodeDiagnostics(Number(sinceMs ?? 0))],
  ['mergeArchiveFile', ([path]) => store.mergeArchiveFile(String(path ?? ''))],
  ['dailyDigest', () => store.dailyDigest()],
  ['setCustomAgents', (list) => {
    store.setCustomAgents((list ?? []) as CustomAgentConfig[])
    return true
  }],
  ['setPollPaused', ([paused]) => {
    pollPaused = !!paused
    store.setPollPaused(pollPaused)
    return true
  }]
])

port.on('message', (msg: RpcRequest) => {
  if (!msg || msg.type !== 'rpc') return
  const handler = handlers.get(msg.method)
  if (!handler) {
    port.postMessage({ type: 'rpc-reply', id: msg.id, ok: false, error: '未知方法: ' + msg.method })
    return
  }
  try {
    const result = handler(msg.args ?? [])
    port.postMessage({ type: 'rpc-reply', id: msg.id, ok: true, result })
  } catch (e) {
    port.postMessage({ type: 'rpc-reply', id: msg.id, ok: false, error: String((e as Error).message) })
  }
})

// ── 轮询（2 秒一拍；最小化时暂停） ──

let pollBusy = false
let pollPaused = false

store.setRetentionDays(Number(data.retentionDays) || 730)

// 老版缓存迁移先于首拍：水位线初始化会把历史纳入，实时流不会回放旧记录
try {
  const migrated = store.migrateLegacyCache()
  if (migrated.rows > 0) {
    console.log(`[nexa] legacy cache migrated: ${migrated.sessions} sessions, ${migrated.rows} rows`)
  }
} catch (e) {
  console.warn('[nexa] legacy cache migration failed:', (e as Error).message)
}

// 首次扫描立即跑一拍，让 UI 尽快有数据
setImmediate(() => {
  tick()
})

function tick(): void {
  if (pollBusy || pollPaused) return
  pollBusy = true
  try {
    const { result, fresh } = store.scan()
    postScan(result, fresh)
  } catch {
    /* 单拍失败不致命 —— 下拍重试 */
  } finally {
    pollBusy = false
  }
}

function postScan(result: ScanResult, fresh: UsageRecord[]): void {
  post({ type: 'event', event: 'scanFinished', payload: result })
  if (fresh.length > 0) post({ type: 'event', event: 'newRecords', payload: fresh })
  if (result.ok && result.changedFiles > 0) post({ type: 'event', event: 'dataChanged' })
}

// setPollPaused 同时更新本模块的轮询暂停标志（见 handlers 表）

const timer = setInterval(tick, 2000)
timer.unref?.()
