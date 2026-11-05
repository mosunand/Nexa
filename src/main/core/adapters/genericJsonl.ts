// main/core/adapters/genericJsonl.ts — 未实测 agent 的防御式通用解析器。
// dsh / workbuddy 等新 agent 暂无本机数据、无官方格式文档可考 —— 按老项目
// "按文档/源码格式防御式实现，格式变化时自动降级为空" 的哲学：
//   · 兼容各家常见 JSONL 形状（ts/timestamp/time、role/t/type、
//     usage 的 camel/snake/usageMetadata 三套字段）
//   · 任何行解析失败只丢该行；整文件无 usage 记录则返回 null（不入缓存）
//   · 装好 agent、数据目录出现后自动探测纳入统计
// 拿到真实样例后应替换为专用适配器。

import { readFileSync } from 'node:fs'
import { decompress } from 'fzstd'
import type { SessionInfo, UsageRecord } from '@shared/types'
import type { ParseResult } from './adapter'
import type { ToolStat } from '../util'
import { isoToMs } from '../util'
import { newMeta } from './adapter'

type Obj = Record<string, unknown>

// 读一个会话文件为行数组：zstd 帧（magic 28 B5 2F FD）自动解压，其余按 UTF-8
export function readSessionLines(filePath: string): string[] {
  const buf = readFileSync(filePath)
  const isZstd =
    buf.length > 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd
  const text = isZstd
    ? Buffer.from(decompress(buf)).toString('utf8')
    : buf.toString('utf8')
  return text.split('\n')
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function pick(o: Obj, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k]
  }
  return undefined
}

// 各家 usage 字段形状 → 统一五类 token
export function extractUsage(o: Obj): { in: number; out: number; reason: number; cached: number; wrote: number } | null {
  const candidates: Obj[] = []
  if (o.usage && typeof o.usage === 'object') candidates.push(o.usage as Obj)
  if (o.usageMetadata && typeof o.usageMetadata === 'object') candidates.push(o.usageMetadata as Obj)
  if (o.message && typeof o.message === 'object') {
    const m = o.message as Obj
    if (m.usage && typeof m.usage === 'object') candidates.push(m.usage as Obj)
  }
  if (o.in !== undefined || o.out !== undefined) candidates.push(o) // ms-agent 风格
  if (o.prompt_tokens !== undefined || o.completion_tokens !== undefined) candidates.push(o)

  for (const u of candidates) {
    const input = num(u.input_tokens ?? u.input ?? u.promptTokenCount ?? u.prompt_tokens ?? u.inputTokens)
    const output = num(
      u.output_tokens ?? u.output ?? u.candidatesTokenCount ?? u.completion_tokens ?? u.outputTokens
    )
    const reason = num(u.reasoning_tokens ?? u.reasoning ?? u.thoughtsTokenCount ?? u.thoughts ?? u.reasoningTokens)
    const cached = num(
      u.cache_read_input_tokens ?? u.cacheRead ?? u.cachedContentTokenCount ?? u.cached_input_tokens ?? u.cached_tokens
    )
    const wrote = num(
      u.cache_creation_input_tokens ?? u.cacheWrite ?? u.cache_creation_tokens ?? u.cache_write_input_tokens
    )
    if (input + output + reason + cached + wrote > 0) {
      return { in: input, out: output, reason, cached, wrote }
    }
  }
  return null
}

export function extractModel(o: Obj): string {
  return String(
    pick(o, ['model', 'modelID', 'modelId']) ??
      ((o.message as Obj | undefined)?.model as string | undefined) ??
      ''
  )
}

export function extractCwd(o: Obj): string {
  return String(pick(o, ['cwd', 'workspace', 'directory', 'project_dir']) ?? '')
}

export function extractTs(o: Obj): number {
  return isoToMs(pick(o, ['ts', 'timestamp', 'time', 'created_at', 'createdAt', 'created']) as string | undefined)
}

// 会话 id / 标题 的通用提取（meta 行或任意行）
export function extractSessionId(o: Obj): string {
  return String(pick(o, ['session_id', 'sessionId', 'id']) ?? '')
}

export interface GenericAcc {
  meta: SessionInfo
  records: UsageRecord[]
  tools: Record<string, ToolStat>
  prevUsageMs: number
  modelCount: Map<string, number>
}

export function newGenericAcc(agentId: string, sessionId: string, filePath: string): GenericAcc {
  return { meta: newMeta(agentId, sessionId, filePath), records: [], tools: {}, prevUsageMs: 0, modelCount: new Map() }
}

// 一行 JSON → 累积进 acc；返回是否识别出任何内容
export function feedGenericLine(acc: GenericAcc, line: string, agentId: string): boolean {
  let o: Obj
  try {
    o = JSON.parse(line) as Obj
  } catch {
    return false
  }
  if (!o || typeof o !== 'object') return false
  const type = String(pick(o, ['t', 'type', 'role']) ?? '').toLowerCase()
  const ts = extractTs(o)
  if (ts > 0 && ts > acc.meta.updatedMs) acc.meta.updatedMs = ts
  let hit = false

  // 会话元信息行（会话身份保持文件名派生 —— 与 codex 同理，meta 里的 id 可能
  // 是跨文件共享的线程 id，覆盖会让 records 主键不一致）
  if (type === 'meta' || type === 'session' || type === 'session_meta') {
    if (!acc.meta.startedMs) acc.meta.startedMs = ts
    const cwd = extractCwd(o)
    if (cwd) acc.meta.cwd = cwd
    hit = true
  }
  if (!acc.meta.cwd) {
    const cwd = extractCwd(o)
    if (cwd) acc.meta.cwd = cwd
  }

  // usage 行（独立事件或内嵌在消息里）
  const usage = extractUsage(o)
  if (usage) {
    const r: UsageRecord = {
      agentId,
      sessionId: acc.meta.sessionId,
      turnId: '',
      responseId: String(o.response_id ?? o.responseId ?? o.id ?? ''),
      timeMs: ts,
      durOk: false,
      durApprox: false,
      durationMs: 0,
      model: extractModel(o),
      effort: '',
      source: 'main',
      inputTokens: usage.in,
      cachedTokens: usage.cached,
      cacheWriteTokens: usage.wrote,
      outputTokens: usage.out,
      reasoningTokens: usage.reason,
      error: '',
      tpsOk: false,
      tps: 0
    }
    // 时长 ≈ 相邻 usage 间隔（120s 上限，同 codex/pi 口径）
    if (acc.prevUsageMs > 0 && ts > acc.prevUsageMs && ts - acc.prevUsageMs <= 120_000) {
      r.durOk = true
      r.durApprox = true
      r.durationMs = ts - acc.prevUsageMs
      if (r.outputTokens + r.reasoningTokens > 0) {
        r.tpsOk = true
        r.tps = (r.outputTokens + r.reasoningTokens) / (r.durationMs / 1000)
      }
    }
    if (ts > 0) {
      acc.records.push(r)
      acc.prevUsageMs = ts
      if (r.model) acc.modelCount.set(r.model, (acc.modelCount.get(r.model) ?? 0) + 1)
    }
    hit = true
  }

  // 工具行
  if (type === 'tool' || type === 'tool_call' || type === 'function_call') {
    const name = String(pick(o, ['name', 'tool_name', 'toolName']) ?? '')
    if (name) {
      const st = acc.tools[name] ?? { calls: 0, firstMs: 0, lastMs: 0 }
      st.calls += 1
      if (st.firstMs === 0 || ts < st.firstMs) st.firstMs = ts
      if (ts > st.lastMs) st.lastMs = ts
      acc.tools[name] = st
      acc.meta.toolCalls++
    }
    hit = true
  }

  // 错误行
  const err = o.error
  if (err && typeof err === 'string') {
    // 错误归入下一跳前先记录 —— 记零 token 错误
    acc.records.push({
      agentId,
      sessionId: acc.meta.sessionId,
      turnId: '',
      responseId: '',
      timeMs: ts,
      durOk: false,
      durApprox: false,
      durationMs: 0,
      model: '',
      effort: '',
      source: 'main',
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      error: String(err).slice(0, 200),
      tpsOk: false,
      tps: 0
    })
    hit = true
  }
  return hit
}

// 收尾：标题/模型/聚合
export function finishGeneric(acc: GenericAcc, fallbackTitle: string): ParseResult {
  const meta = acc.meta
  meta.updatedMs = Math.max(meta.startedMs, meta.updatedMs)
  if (meta.cwd) meta.title = meta.cwd.split(/[\\/]/).pop() || ''
  if (!meta.title) meta.title = fallbackTitle
  let best = ''
  let bestN = -1
  for (const [k, n] of acc.modelCount) {
    if (n > bestN) {
      bestN = n
      best = k
    }
  }
  meta.model = best
  for (const r of acc.records) {
    if (r.error) {
      meta.errors++
      continue
    }
    meta.inputTokens += r.inputTokens
    meta.cachedTokens += r.cachedTokens
    meta.cacheWriteTokens += r.cacheWriteTokens
    meta.outputTokens += r.outputTokens
    meta.reasoningTokens += r.reasoningTokens
  }
  meta.responses = acc.records.length
  return { meta, records: acc.records, tools: acc.tools }
}
