// shared/api.ts — 渲染端可见的类型化 API 契约 + 推送事件。
// preload 通过 contextBridge 暴露 window.nexa（NexaApi），主进程经 worker 执行。

import type {
  AgentStatus,
  AgentTotal,
  AppSettings,
  ArchiveInfo,
  ArchiveMergeResult,
  BrakeStats,
  ChatMessage,
  DailyTotal,
  DailyDigest,
  DayReplayRow,
  DeepScanResult,
  ModelBreakdown,
  ModelDayPoint,
  OverviewData,
  ProjectStat,
  ScanResult,
  SessionInfo,
  SpeedRow,
  TimeWindow,
  ToolBreakdown,
  UsageRecord,
  ZcodeDiagnostics
} from './types'

export interface SessionQuery {
  agent: string
  search: string
  limit: number
}

export interface StatsFilter {
  agent: string
  family: string
}

export interface NexaApi {
  // ── 查询（主进程 worker 执行，全只读） ──
  overview(window: TimeWindow): Promise<OverviewData>
  sessionList(q: SessionQuery): Promise<SessionInfo[]>
  sessionInfo(agent: string, sessionId: string): Promise<SessionInfo>
  sessionRecords(agent: string, sessionId: string): Promise<UsageRecord[]>
  sessionMessages(agent: string, sessionId: string): Promise<ChatMessage[]>
  modelBreakdown(sinceMs: number): Promise<ModelBreakdown[]>
  modelDailySeries(sinceMs: number, topModels: number): Promise<ModelDayPoint[]>
  toolBreakdown(sinceMs: number, limit: number): Promise<ToolBreakdown[]>
  agentStatuses(): Promise<AgentStatus[]>
  rawRows(agent: string, model: string, limit: number): Promise<UsageRecord[]>
  recentSpeed(sinceMs: number, family: string, limit: number): Promise<SpeedRow[]>
  // 使用统计（归档优先）
  dailyTotals(f: StatsFilter): Promise<DailyTotal[]>
  dailyTokensByModel(sinceMs: number, topModels: number, f: StatsFilter): Promise<ModelDayPoint[]>
  agentTotals(f: StatsFilter): Promise<AgentTotal[]>
  longestSessionActiveMs(f: StatsFilter): Promise<number>
  archiveModelFamilies(): Promise<string[]>
  archiveAgentIds(): Promise<string[]>
  archiveInfo(): Promise<ArchiveInfo>
  // ── 项目洞察 / 急刹车 / 重放 / 深度扫描 ──
  projectStats(sinceMs: number): Promise<ProjectStat[]>
  brakeStats(sinceMs: number): Promise<BrakeStats>
  dayReplay(startMs: number, endMs: number): Promise<DayReplayRow[]>
  deepScan(sinceMs: number): Promise<DeepScanResult>
  // ── 体检 / 归档合并 / 日报 ──
  zcodeDiagnostics(sinceMs: number): Promise<ZcodeDiagnostics>
  mergeArchiveFile(path: string): Promise<ArchiveMergeResult>
  dailyDigest(): Promise<DailyDigest>
  // ── 设置 ──
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  // 主题切换（主进程同步原生窗口控制按钮配色）
  applyOverlay(theme: 'dark' | 'light'): Promise<boolean>
  // 选择目录（自定义 agent 数据目录用）
  pickDirectory(): Promise<string | null>
  // 选择归档文件（多机合并用）
  pickArchive(): Promise<string | null>
  // ── 事件订阅（scanFinished / newRecords / dataChanged） ──
  on(event: 'scanFinished', cb: (r: ScanResult) => void): () => void
  on(event: 'newRecords', cb: (records: UsageRecord[]) => void): () => void
  on(event: 'dataChanged', cb: () => void): () => void
}

// 渲染端事件 union
export type NexaEventMap = {
  scanFinished: ScanResult
  newRecords: UsageRecord[]
  dataChanged: undefined
  workerDead: undefined
}
