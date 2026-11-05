// main/core/adapters/codex.ts — Codex（OpenAI）适配器（rollout JSONL）。
// 对应老项目 CodexAdapter.cpp：token_usage_record（新格式）/ token_count
// （旧格式合成）→ 逐响应记录；时长 ≈ 同 turn 内相邻响应间隔（含工具间隙，
// >120s 视为不可测）；turn_aborted 记零 token 错误。

import { existsSync } from 'node:fs'
import type { AgentAdapter, ParseResult } from './adapter'
import { newMeta } from './adapter'
import { codexArchiveDir, codexSessionsDir } from '../paths'
import { fileContains, isoToMs, readLines, walkFiles, type ToolStat } from '../util'
import type { ChatMessage, UsageRecord } from '@shared/types'
import type { SessionFile } from '../util'

const ID = 'codex'
const COLOR = '#10a37a' // OpenAI teal
const K_MAX_STREAM_GAP_MS = 120 * 1000

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

function sessionIdFromPath(path: string): string {
  const m = UUID_RE.exec(path)
  if (m?.[1]) return m[1]
  const file = path.split(/[\\/]/).pop() ?? path
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const parts = stem.split('-')
  return parts.length >= 5 ? parts.slice(-5).join('-') : stem
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function emptyRecord(sessionId: string): UsageRecord {
  return {
    agentId: ID,
    sessionId,
    turnId: '',
    responseId: '',
    timeMs: 0,
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
    error: '',
    tpsOk: false,
    tps: 0
  }
}

// message content 数组 → 拼接文本
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const v of content as Array<Record<string, unknown>>) {
    const t = String(v.text ?? '')
    if (t) parts.push(t)
  }
  return parts.join('\n')
}

interface TurnInfo {
  model: string
  effort: string
  startMs: number
}

export const codexAdapter: AgentAdapter = {
  id: ID,
  displayName: 'Codex',
  color: COLOR,

  dataPresent() {
    const d = codexSessionsDir()
    return { found: existsSync(d), dir: d }
  },

  listSessionFiles() {
    const files: SessionFile[] = []
    for (const root of [codexSessionsDir(), codexArchiveDir()]) {
      if (existsSync(root)) files.push(...walkFiles(root, ['.jsonl']))
    }
    return { files, note: files.length === 0 ? '未发现 rollout 会话文件' : '' }
  },

  parseFile(f: SessionFile): ParseResult | null {
    const sessionId = sessionIdFromPath(f.path)
    const meta = newMeta(ID, sessionId, f.path)
    const records: UsageRecord[] = []
    const tools: Record<string, ToolStat> = {}
    try {
      // pre-pass：该文件是否带新的 token_usage_record 格式？（子串探测，不解析
      // JSON）。是 → token_count 快照一条都不合成 —— 包括首条 usage record
      // 之前的那些，否则会重复计数。
      const fileHasUsageRecords = fileContains(f.path, 'token_usage_record')

      const turns = new Map<string, TurnInfo>()
      let lastTurnId = ''
      let lastCountMs = 0 // 上一条 token_count 的时间戳
      let sawUsageRecord = fileHasUsageRecords
      let titleSet = false
      let lastPromptTitle = ''
      let toolCalls = 0
      let lastTs = 0

      for (const line of readLines(f.path)) {
        let o: Record<string, unknown>
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        const type = String(o.type ?? '')
        const p = (o.payload ?? {}) as Record<string, unknown>
        const ts = isoToMs(o.timestamp as string)
        if (ts > 0) lastTs = Math.max(lastTs, ts)

        if (type === 'session_meta') {
          if (!meta.startedMs) meta.startedMs = ts
          meta.cwd = String(p.cwd ?? '')
          meta.originator = String(p.originator ?? '')
          meta.contextWindow = Number(p.context_window ?? 0) || 0
          // 注意：会话身份保持由文件名派生（每文件唯一）。
          // session_meta.session_id 是 THREAD id —— resume 分叉会产出共享它
          // 的新 rollout 文件，会让记录撞车。
        } else if (type === 'turn_context') {
          const ti: TurnInfo = {
            model: String(p.model ?? ''),
            effort: String(p.effort ?? ''),
            startMs: ts
          }
          lastTurnId = String(p.turn_id ?? '')
          turns.set(lastTurnId, ti)
          if (ti.model) meta.model = ti.model
        } else if (type === 'token_usage_record') {
          sawUsageRecord = true
          const u = (p.usage ?? {}) as Record<string, unknown>
          const r = emptyRecord(sessionId)
          r.turnId = String(p.turn_id ?? '')
          r.responseId = String(p.response_id ?? '')
          r.timeMs = ts
          r.inputTokens = Number(u.input_tokens ?? 0) || 0
          r.cachedTokens = Number(u.cached_input_tokens ?? 0) || 0
          r.cacheWriteTokens = Number(u.cache_write_input_tokens ?? 0) || 0
          r.outputTokens = Number(u.output_tokens ?? 0) || 0
          r.reasoningTokens = Number(u.reasoning_output_tokens ?? 0) || 0
          const ti = turns.get(r.turnId) ?? { model: '', effort: '', startMs: 0 }
          r.model = ti.model
          r.effort = ti.effort
          // 时长 ≈ 同 turn 上一响应到本响应的间隔（首响应：到 turn 起点）
          // —— 含工具间隙；长间隙意味着用户暂停 → 不可测，丢弃
          const ref = lastCountMs > ti.startMs ? lastCountMs : ti.startMs
          if (ts > ref && ref > 0 && ts - ref <= K_MAX_STREAM_GAP_MS) {
            r.durOk = true
            r.durApprox = true
            r.durationMs = ts - ref
            if (r.outputTokens + r.reasoningTokens > 0) {
              r.tpsOk = true
              r.tps = (r.outputTokens + r.reasoningTokens) / (r.durationMs / 1000)
            }
          }
          records.push(r)
          lastCountMs = ts
        } else if (type === 'event_msg') {
          const et = String(p.type ?? '')
          if (et === 'token_count' && !sawUsageRecord) {
            // 旧格式合成：每响应一条 token_count，last_token_usage = 该响应用量
            const info = (p.info ?? {}) as Record<string, unknown>
            const last = (info.last_token_usage ?? {}) as Record<string, unknown>
            if (!meta.contextWindow) {
              meta.contextWindow = Number(info.model_context_window ?? 0) || 0
            }
            const r = emptyRecord(sessionId)
            r.turnId = lastTurnId
            r.timeMs = ts
            r.inputTokens = Number(last.input_tokens ?? 0) || 0
            r.cachedTokens = Number(last.cached_input_tokens ?? 0) || 0
            r.outputTokens = Number(last.output_tokens ?? 0) || 0
            r.reasoningTokens = Number(last.reasoning_output_tokens ?? 0) || 0
            const ti = turns.get(lastTurnId) ?? { model: '', effort: '', startMs: 0 }
            r.model = ti.model
            r.effort = ti.effort
            const ref = lastCountMs > 0 ? lastCountMs : ti.startMs
            if (ts > ref && ref > 0 && ts - ref <= K_MAX_STREAM_GAP_MS) {
              r.durOk = true
              r.durApprox = true
              r.durationMs = ts - ref
              if (r.outputTokens + r.reasoningTokens > 0) {
                r.tpsOk = true
                r.tps = (r.outputTokens + r.reasoningTokens) / (r.durationMs / 1000)
              }
            }
            if (r.inputTokens + r.outputTokens + r.reasoningTokens > 0) records.push(r)
            lastCountMs = ts
          } else if (et === 'user_message' && !titleSet) {
            const t = String(p.message ?? '')
            if (t && !t.startsWith('<')) lastPromptTitle = t
          } else if (et === 'turn_aborted') {
            // 中止的 turn → 零 token 错误记录，与完成请求共用错误率口径
            const r = emptyRecord(sessionId)
            r.turnId = lastTurnId
            r.timeMs = ts
            const ti = turns.get(lastTurnId) ?? { model: '', effort: '', startMs: 0 }
            r.model = ti.model
            r.effort = ti.effort
            r.error = 'turn_aborted'
            records.push(r)
          }
        } else if (type === 'response_item') {
          const it = String(p.type ?? '')
          if (it === 'function_call') {
            toolCalls++
            const name = String(p.name ?? '')
            if (name) {
              const st = tools[name] ?? { calls: 0, firstMs: 0, lastMs: 0 }
              st.calls += 1
              if (st.firstMs === 0 || ts < st.firstMs) st.firstMs = ts
              if (ts > st.lastMs) st.lastMs = ts
              tools[name] = st
            }
          } else if (
            it === 'message' &&
            String(p.role ?? '') === 'user' &&
            !titleSet
          ) {
            const t = messageText(p.content).trim()
            // 跳过 <environment_context>/<app-context> 包装消息
            if (t && !t.startsWith('<')) {
              lastPromptTitle = t
              titleSet = true
            }
          }
        }
      }

      // 会话聚合
      meta.updatedMs = Math.max(meta.startedMs, lastTs)
      if (lastPromptTitle) meta.title = lastPromptTitle.slice(0, 120)
      else if (meta.cwd) meta.title = fileName(meta.cwd.replace(/[\\/]+$/, ''))
      if (!meta.title) meta.title = meta.sessionId.slice(0, 12)
      for (const r of records) {
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
      meta.responses = records.length
      meta.toolCalls = toolCalls
      return { meta, records, tools }
    } catch {
      return null
    }
  },

  parseMessages(f: SessionFile): ChatMessage[] | null {
    const out: ChatMessage[] = []
    try {
      for (const line of readLines(f.path)) {
        let o: Record<string, unknown>
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        if (String(o.type ?? '') !== 'response_item') continue
        const p = (o.payload ?? {}) as Record<string, unknown>
        const it = String(p.type ?? '')
        const ts = isoToMs(o.timestamp as string)

        if (it === 'message') {
          const role = String(p.role ?? '')
          const text = messageText(p.content)
          if (!text) continue
          if (role === 'developer') continue // 内部指令 —— 回放噪音
          if (role === 'user' && text.trim().startsWith('<')) continue // 环境包装
          out.push({ role: role === 'user' ? 'user' : 'assistant', text: text.slice(0, 20000), timeMs: ts })
        } else if (it === 'reasoning') {
          const parts: string[] = []
          for (const v of (p.summary ?? []) as Array<Record<string, unknown>>) {
            const t = String(v.text ?? '')
            if (t) parts.push(t)
          }
          const text = parts.join('\n')
          if (!text) continue
          out.push({ role: 'reasoning', text: text.slice(0, 8000), timeMs: ts })
        } else if (it === 'function_call') {
          out.push({
            role: 'tool',
            toolName: String(p.name ?? ''),
            text: String(p.arguments ?? '').slice(0, 4000),
            timeMs: ts
          })
        } else if (it === 'function_call_output') {
          out.push({ role: 'tool_output', text: String(p.output ?? '').slice(0, 6000), timeMs: ts })
        } else if (it === 'web_search_call') {
          out.push({
            role: 'tool',
            toolName: 'web_search',
            text: String(((p.action ?? {}) as Record<string, unknown>).query ?? '').slice(0, 1000),
            timeMs: ts
          })
        }
      }
      return out
    } catch {
      return null
    }
  }
}
