// main/core/adapters/msagent.ts — MSAgent 适配器（~/.ms-agent/sessions JSONL）。
// 事件流格式（实测本机数据）：
//   {t:'meta', id, ts, workspace}                        会话元信息
//   {t:'user', text, ts}                                 用户输入
//   {t:'assistant', text?, tool_calls?, ts}              助手响应
//   {t:'tool', id, name, result, ts}                     工具执行
//   {t:'usage', in, out, wrote(bool), model, ts}         逐响应 token 用量
// 无流式时长字段 —— TPS 用相邻 usage 间隔近似（同 codex/pi 口径，
// >120s 视为用户暂停不可测，durApprox 标 ≈）。wrote 为布尔不可量化，
// 缓存读/写计数记 0。

import { existsSync } from 'node:fs'
import type { AgentAdapter, ParseResult } from './adapter'
import { newMeta } from './adapter'
import { homePath } from '../paths'
import { isoToMs, readLines, walkFiles, type ToolStat } from '../util'
import { join } from 'node:path'
import type { ChatMessage, UsageRecord } from '@shared/types'
import type { SessionFile } from '../util'

const ID = 'msagent'
const COLOR = '#f97316' // 橙 —— 与现有 7 家品牌色均不撞

function sessionsDir(): string {
  const env = process.env['NEXA_MSAGENT']
  if (env && env.trim()) return env.trim()
  return homePath('.ms-agent/sessions')
}

function baseName(p: string): string {
  const file = p.split(/[\\/]/).pop() ?? p
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

interface EventRec {
  t: string
  ts?: string
  id?: string
  workspace?: string
  text?: string
  name?: string
  result?: unknown
  model?: string
  in?: number
  out?: number
  wrote?: boolean
  tool_calls?: Array<{ name?: string }>
}

export const msagentAdapter: AgentAdapter = {
  id: ID,
  displayName: 'MSAgent',
  color: COLOR,

  dataPresent() {
    const d = sessionsDir()
    return { found: existsSync(d), dir: d }
  },

  listSessionFiles() {
    const root = sessionsDir()
    const files = existsSync(root) ? walkFiles(root, ['.jsonl']) : []
    return { files, note: files.length === 0 ? '未发现会话文件（~/.ms-agent/sessions）' : '' }
  },

  parseFile(f: SessionFile): ParseResult | null {
    const sessionId = baseName(f.path)
    const meta = newMeta(ID, sessionId, f.path)
    const records: UsageRecord[] = []
    const tools: Record<string, ToolStat> = {}
    try {
      let lastTs = 0
      let prevUsageMs = 0
      const modelCount = new Map<string, number>()

      for (const line of readLines(f.path)) {
        let o: EventRec
        try {
          o = JSON.parse(line) as EventRec
        } catch {
          continue
        }
        const ts = isoToMs(o.ts)
        if (ts > 0) lastTs = Math.max(lastTs, ts)

        if (o.t === 'meta') {
          if (o.id) meta.sessionId = o.id
          if (!meta.startedMs) meta.startedMs = ts
          meta.cwd = String(o.workspace ?? '')
          continue
        }

        if (o.t === 'usage') {
          const r: UsageRecord = {
            agentId: ID,
            sessionId: meta.sessionId,
            turnId: '',
            responseId: '',
            timeMs: ts,
            durOk: false,
            durApprox: false,
            durationMs: 0,
            model: String(o.model ?? ''),
            effort: '',
            source: 'main',
            inputTokens: Number(o.in ?? 0) || 0,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: Number(o.out ?? 0) || 0,
            reasoningTokens: 0,
            error: '',
            tpsOk: false,
            tps: 0
          }
          // 时长 ≈ 相邻 usage 间隔（>120s 用户暂停 → 不可测）
          if (prevUsageMs > 0 && ts > prevUsageMs && ts - prevUsageMs <= 120_000) {
            r.durOk = true
            r.durApprox = true
            r.durationMs = ts - prevUsageMs
            if (r.outputTokens > 0) {
              r.tpsOk = true
              r.tps = r.outputTokens / (r.durationMs / 1000)
            }
          }
          records.push(r)
          prevUsageMs = ts
          if (r.model) modelCount.set(r.model, (modelCount.get(r.model) ?? 0) + 1)
          continue
        }

        if (o.t === 'tool' && o.name) {
          const st = tools[o.name] ?? { calls: 0, firstMs: 0, lastMs: 0 }
          st.calls += 1
          if (st.firstMs === 0 || ts < st.firstMs) st.firstMs = ts
          if (ts > st.lastMs) st.lastMs = ts
          tools[o.name] = st
        }
      }

      meta.updatedMs = Math.max(meta.startedMs, lastTs)
      if (meta.cwd) meta.title = fileName(meta.cwd.replace(/[\\/]+$/, ''))
      if (!meta.title) meta.title = meta.sessionId.slice(0, 12)
      let best = ''
      let bestN = -1
      for (const [k, n] of modelCount) {
        if (n > bestN) {
          bestN = n
          best = k
        }
      }
      meta.model = best
      meta.originator = 'ms-agent'
      for (const r of records) {
        if (r.error) {
          meta.errors++
          continue
        }
        meta.inputTokens += r.inputTokens
        meta.outputTokens += r.outputTokens
      }
      meta.responses = records.length
      meta.toolCalls = Object.values(tools).reduce((s, t) => s + t.calls, 0)
      return { meta, records, tools }
    } catch {
      return null
    }
  },

  parseMessages(f: SessionFile): ChatMessage[] | null {
    const out: ChatMessage[] = []
    try {
      for (const line of readLines(f.path)) {
        let o: EventRec
        try {
          o = JSON.parse(line) as EventRec
        } catch {
          continue
        }
        const ts = isoToMs(o.ts)
        if (o.t === 'user') {
          const text = String(o.text ?? '').trim()
          if (text) out.push({ role: 'user', text: text.slice(0, 20000), timeMs: ts })
        } else if (o.t === 'assistant') {
          const text = String(o.text ?? '')
          const calls = Array.isArray(o.tool_calls) ? o.tool_calls : []
          if (text.trim()) {
            out.push({ role: 'assistant', text: text.slice(0, 20000), timeMs: ts })
          }
          for (const c of calls) {
            if (c?.name) {
              out.push({ role: 'tool', toolName: c.name, text: '', timeMs: ts })
            }
          }
        } else if (o.t === 'tool') {
          const result = typeof o.result === 'string' ? o.result : JSON.stringify(o.result ?? '')
          out.push({
            role: 'tool_output',
            toolName: String(o.name ?? ''),
            text: result.slice(0, 6000),
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
