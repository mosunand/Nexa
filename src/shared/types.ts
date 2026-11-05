// shared/types.ts — 全端共享的统一数据模型。
// 从老项目 src/core/Types.h 1:1 移植：
//   一条 UsageRecord = 一次完成的模型响应（token / TPS 的统计单元）
//   一条 SessionInfo = 一个本地会话（codex rollout / claude jsonl / zcode db 行）
// 时间统一为 epoch 毫秒；源文件里的 ISO-8601 "Z" 时间戳在解析时换算。

// ───────────────────────── usage（每次模型响应） ─────────────────────────

export interface UsageRecord {
  agentId: string
  sessionId: string
  turnId: string // 尽力而为的 turn 分组（未知为 ''）
  responseId: string // 供应商 response/message id（未知为 ''）
  timeMs: number // 完成时间戳（UTC ms）
  durOk: boolean // 流式时长可测
  durApprox: boolean // 时长含工具间隙（codex 近似）
  durationMs: number
  model: string
  effort: string // 推理力度/变体（未知为 ''）
  source: string // "main" | "sidechain" | …
  inputTokens: number
  cachedTokens: number // 缓存读
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  error: string // 非空 → 失败/中止的调用（零 token）
  tpsOk: boolean
  tps: number // (output+reasoning)/durationSeconds
}

export function totalTokens(r: Pick<UsageRecord, 'inputTokens' | 'outputTokens' | 'reasoningTokens'>): number {
  return r.inputTokens + r.outputTokens + r.reasoningTokens
}

// 对话重放的一条消息（按需解析，从不入缓存库）
export interface ChatMessage {
  role: 'user' | 'assistant' | 'reasoning' | 'tool' | 'tool_output'
  model?: string
  toolName?: string
  text: string
  timeMs: number
  isError?: boolean
}

// ───────────────────────── sessions ─────────────────────────

export interface SessionInfo {
  agentId: string
  sessionId: string
  filePath: string
  title: string
  cwd: string
  model: string
  originator: string
  startedMs: number
  updatedMs: number
  responses: number
  toolCalls: number
  errors: number
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  contextWindow: number
}

// ───────────────────────── agents ─────────────────────────

export interface AgentStatus {
  id: string
  name: string
  color: string
  found: boolean // 数据目录存在
  dataDir: string
  note: string
  sessions: number
  lastActivityMs: number
}

// ───────────────────────── 聚合 ─────────────────────────

export interface Kpis {
  requests: number
  sessions: number
  errors: number
  inTok: number
  outTok: number
  reasonTok: number
  cacheRead: number
  cacheWrite: number
  avgDurOk: boolean
  avgDurMs: number
  tpsOk: boolean
  weightedTps: number
  tpsSamples: number
}

export interface SeriesPoint {
  bucketMs: number
  requests: number
  input: number
  output: number
  reasoning: number
}

export interface ModelBreakdown {
  agentId: string
  model: string
  effort: string
  requests: number
  inTok: number
  cachedTok: number
  outTok: number
  reasonTok: number
  avgDurOk: boolean
  avgDurMs: number
  tpsOk: boolean
  weightedTps: number
  lastMs: number
}

export interface AgentBreakdown {
  agentId: string
  requests: number
  inTok: number
  cachedTok: number
  outTok: number
  reasonTok: number
}

export interface ToolBreakdown {
  agentId: string
  toolName: string
  calls: number
  sessions: number
}

export interface SpeedRow {
  timeMs: number
  agentId: string
  model: string
  sessionId: string
  output: number
  reasoning: number
  durOk: boolean
  durationMs: number
  tpsOk: boolean
  tps: number
}

export type TimeWindow = 'today' | '24h' | '7d' | '30d' | 'all'

export interface OverviewData {
  window: TimeWindow
  sinceMs: number
  kpis: Kpis
  todayKpis: Kpis // 固定"今天"窗口 — 左侧大卡数据源
  todayByModel: ModelBreakdown[] // today 卡的每模型明细行
  series: SeriesPoint[]
  byModel: ModelBreakdown[]
  byAgent: AgentBreakdown[]
  byTool: ToolBreakdown[]
  recentSpeed: SpeedRow[]
}

export interface ModelDayPoint {
  dayMs: number
  model: string
  genTok: number
}

export interface DailyTotal {
  dayMs: number
  tokens: number
}

export interface AgentTotal {
  agent: string
  requests: number
  inTok: number
  outTok: number
  reasonTok: number
}

// ───────────────────────── 扫描 / 设置 ─────────────────────────

export interface ScanResult {
  ok: boolean
  err: string
  totalFiles: number
  changedFiles: number
  freshCount: number
  scanMs: number
}

export interface ArchiveInfo {
  entries: number
  path: string
  retentionDays: number
}

export interface AppSettings {
  retentionDays: number
  theme: 'dark' | 'light'
  customAgents: CustomAgentConfig[]
  digestEnabled: boolean
  digestTime: string // 'HH:MM'
}

// 用户自定义 agent：自写 agent 的数据目录可能无法自动探测 —— 手动登记
// 目录 + 选一个格式模板（复用现有解析器或通用防御解析）。
export interface CustomAgentConfig {
  id: string // 稳定 slug（custom- 前缀），由名称生成
  name: string // 显示名
  dir: string // 数据目录（递归扫 .jsonl/.json/.zst）
  format: 'generic' | 'claude' | 'codex' | 'gemini' | 'pi' | 'msagent'
}

export const CUSTOM_AGENT_FORMATS: Array<{ id: CustomAgentConfig['format']; label: string }> = [
  { id: 'generic', label: '通用 JSONL（自动识别 usage 字段）' },
  { id: 'claude', label: 'Claude Code 会话格式' },
  { id: 'codex', label: 'Codex rollout 格式' },
  { id: 'gemini', label: 'Gemini/Qwen chats 格式' },
  { id: 'pi', label: 'pi 会话格式' },
  { id: 'msagent', label: 'MSAgent 事件流格式' }
]

// ───────────────────────── 项目洞察 / 急刹车 / 重放 / 文件热点 ─────────────────────────

export interface ProjectStat {
  project: string // 完整 cwd
  name: string // basename 显示
  agents: string[]
  sessions: number
  requests: number
  inTok: number
  outTok: number
  reasonTok: number
  cacheTok: number
  errors: number
  aborts: number // 用户主动打断（cancelled_by_user / turn_aborted）
  tpsOk: boolean
  weightedTps: number
  lastMs: number
}

export interface HourBucket {
  hour: number // 0..23 本地小时
  requests: number
  aborts: number
}

export interface BrakeModelRow {
  model: string
  requests: number
  aborts: number
  abortedTok: number
}

// 急刹车指数：你主动打断 agent 的频率与代价
export interface BrakeStats {
  sinceMs: number
  requests: number
  aborts: number
  abortedTok: number // 被打断时已烧掉的 token（in+out+reason）
  byModel: BrakeModelRow[]
  byHour: HourBucket[]
}

// 一日重放：当天逐响应行
export interface DayReplayRow {
  timeMs: number
  agentId: string
  model: string
  inTok: number
  outTok: number
  reasonTok: number
  tps: number
  durOk: boolean
  error: string
}

export interface FileHotspot {
  file: string // 相对项目根的路径（能算则算）
  edits: number
  tokens: number // 归因的生成 token（response → 下一个文件工具调用）
}

export interface LoopHit {
  sessionId: string
  agentId: string
  tool: string
  repeats: number // 同参数重复次数（≥3 视为卡死环）
  args: string // 参数摘要（截断）
}

export interface DeepScanResult {
  scannedSessions: number
  truncated: boolean // 达到预算上限（80 会话 / 8s）
  hotspots: FileHotspot[]
  loops: LoopHit[]
}

// ───────────────────────── 体检（ZCode 源库深检） ─────────────────────────

export interface TtftRow {
  model: string
  count: number
  avgMs: number
  p50Ms: number
  p90Ms: number
}

export interface ToolSafetyRow {
  tool: string
  calls: number
  destructive: number
  failed: number
}

export interface DangerousCall {
  tool: string
  timeMs: number
  status: string
  exitCode: number
}

export interface ZcodeDiagnostics {
  available: boolean
  sinceMs: number
  // ① 首字延迟
  ttft: TtftRow[]
  // ② 安全审计
  destructiveCalls: number
  failedCalls: number
  contextExceeded: number
  tools: ToolSafetyRow[]
  recentDangerous: DangerousCall[]
  // ③ 重试账单
  retriedCalls: number
  retryCount: number
  wastedTokens: number
  topErrors: Array<{ type: string; count: number }>
}

// 托盘日报
export interface DailyDigest {
  tokens: number
  requests: number
  yesterdayTokens: number
  topModel: string
  topModelPct: number
}

export interface ArchiveMergeResult {
  added: number
  total: number
}

export const ABORT_ERRORS = ['cancelled_by_user', 'turn_aborted']

export const AGENTS_META: Record<string, { name: string; color: string }> = {
  zcode: { name: 'ZCode', color: '#3b82f6' },
  codex: { name: 'Codex', color: '#10a37a' },
  claude: { name: 'Claude Code', color: '#d97757' },
  gemini: { name: 'Gemini CLI', color: '#4285f4' },
  qwen: { name: 'Qwen Code (千问)', color: '#7c3aed' },
  opencode: { name: 'OpenCode', color: '#14b8a6' },
  pi: { name: 'pi', color: '#e06c75' },
  msagent: { name: 'MSAgent', color: '#f97316' },
  dsh: { name: 'DeepSeek Harness (dsh)', color: '#4d6bfe' },
  workbuddy: { name: 'workbuddy', color: '#84cc16' }
}
