// main/core/adapters/claude.ts — Claude Code 适配器（projects JSONL）。
// 对应老项目 ClaudeAdapter.cpp：message.id 流式分组 → 精确流式时长与 TPS；
// api error 行记零 token 错误；ai-title / last-prompt 兜底会话标题。

import { existsSync } from 'node:fs'
import type { AgentAdapter, ParseResult } from './adapter'
import { newMeta } from './adapter'
import { claudeProjectsDir } from '../paths'
import { isoToMs, readLines, walkFiles, type ToolStat } from '../util'
import type { ChatMessage, UsageRecord } from '@shared/types'
import type { SessionFile } from '../util'

const ID = 'claude'
const COLOR = '#d97757' // Anthropic coral

function baseName(p: string): string {
  const file = p.split(/[\\/]/).pop() ?? p
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

// user message.content（string | 块数组）→ 纯文本
function userText(message: Record<string, unknown>): string {
  const c = message.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  const parts: string[] = []
  for (const v of c as Array<Record<string, unknown>>) {
    if (v.type === 'text' && typeof v.text === 'string') parts.push(v.text)
  }
  return parts.join('\n')
}

interface Acc {
  rec: UsageRecord
  firstMs: number
  lines: number
}

export const claudeAdapter: AgentAdapter = {
  id: ID,
  displayName: 'Claude Code',
  color: COLOR,

  dataPresent() {
    const d = claudeProjectsDir()
    return { found: existsSync(d), dir: d }
  },

  listSessionFiles() {
    const root = claudeProjectsDir()
    const files = existsSync(root) ? walkFiles(root, ['.jsonl']) : []
    return { files, note: files.length === 0 ? '未发现会话 JSONL（先跑一次 claude）' : '' }
  },

  parseFile(f: SessionFile): ParseResult | null {
    const meta = newMeta(ID, baseName(f.path), f.path)
    const records: UsageRecord[] = []
    const tools: Record<string, ToolStat> = {}
    try {
      const acc = new Map<string, Acc>() // message.id → 流式累加器
      const modelCount = new Map<string, number>() // 会话模型 = 出现最多者
      let firstUserTitle = ''
      let aiTitle = ''
      let lastPromptTitle = ''
      let titleSet = false
      let toolUses = 0
      let lastTs = 0

      for (const line of readLines(f.path)) {
        let o: Record<string, unknown>
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        if (!o || typeof o !== 'object') continue
        const type = String(o.type ?? '')
        const ts = isoToMs(o.timestamp as string)
        if (ts > 0) lastTs = Math.max(lastTs, ts)

        if (type === 'user') {
          if (!meta.startedMs) meta.startedMs = ts
          const cwd = String(o.cwd ?? '')
          if (cwd) meta.cwd = cwd
          if (!titleSet) {
            const t = userText((o.message ?? {}) as Record<string, unknown>).trim()
            const originKind = String(
              ((o.origin ?? {}) as Record<string, unknown>).kind ?? ''
            )
            // 跳过 tool_result-only / 中断噪音
            if (t && !t.startsWith('<') && originKind === 'human') {
              firstUserTitle = t
              titleSet = true
            }
          }
        } else if (type === 'ai-title') {
          aiTitle = String(o.aiTitle ?? '')
        } else if (type === 'last-prompt') {
          lastPromptTitle = String(o.lastPrompt ?? '')
        } else if (type === 'assistant') {
          const m = (o.message ?? {}) as Record<string, unknown>
          const mid = String(m.id ?? '')
          const u = (m.usage ?? {}) as Record<string, unknown>
          const apiError = !!o.isApiErrorMessage
          const sid = String(o.sessionId ?? '') || meta.sessionId
          const source = o.isSidechain ? 'sidechain' : 'main'

          if (apiError && Object.keys(u).length === 0) {
            // API 错误行 —— 记零 token 错误记录，让错误率覆盖失败调用
            records.push({
              agentId: ID,
              sessionId: sid,
              turnId: '',
              responseId: mid,
              timeMs: ts,
              durOk: false,
              durApprox: false,
              durationMs: 0,
              model: String(m.model ?? ''),
              effort: '',
              source,
              inputTokens: 0,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              error: 'api_error',
              tpsOk: false,
              tps: 0
            })
            continue
          }
          if (!mid || Object.keys(u).length === 0) continue // 错误/空 assistant 行

          let a = acc.get(mid)
          if (!a || a.lines === 0) {
            a = {
              rec: {
                agentId: ID,
                sessionId: sid,
                turnId: '',
                responseId: mid,
                timeMs: ts,
                durOk: false,
                durApprox: false,
                durationMs: 0,
                model: String(m.model ?? ''),
                effort: '',
                source,
                inputTokens: 0,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                error: '',
                tpsOk: false,
                tps: 0
              },
              firstMs: ts,
              lines: 0
            }
            acc.set(mid, a)
          }
          a.rec.timeMs = ts
          // 每行 usage 对该消息是累计值 → 保留最后一行
          a.rec.inputTokens = Number(u.input_tokens ?? 0) || 0
          a.rec.cacheWriteTokens = Number(u.cache_creation_input_tokens ?? 0) || 0
          a.rec.cachedTokens = Number(u.cache_read_input_tokens ?? 0) || 0
          a.rec.outputTokens = Number(u.output_tokens ?? 0) || 0
          a.lines++

          const content = (m.content ?? []) as Array<Record<string, unknown>>
          for (const c of content) {
            if (c.type === 'tool_use') {
              toolUses++
              const name = String(c.name ?? '')
              if (name) {
                const st = tools[name] ?? { calls: 0, firstMs: 0, lastMs: 0 }
                st.calls += 1
                if (st.firstMs === 0 || ts < st.firstMs) st.firstMs = ts
                if (ts > st.lastMs) st.lastMs = ts
                tools[name] = st
              }
            }
          }
        }
      }

      // 流式分组收尾 → 逐响应记录
      for (const a of acc.values()) {
        const r = a.rec
        if (r.timeMs > a.firstMs) {
          r.durOk = true
          r.durationMs = r.timeMs - a.firstMs
          // <100ms 的"流"是单块响应 —— 时间粒度让 TPS 无意义
          if (r.durationMs >= 100 && r.outputTokens > 0) {
            r.tpsOk = true
            r.tps = r.outputTokens / (r.durationMs / 1000)
          }
        }
        records.push(r)
        modelCount.set(r.model, (modelCount.get(r.model) ?? 0) + 1)
      }
      records.sort((a, b) => a.timeMs - b.timeMs)

      // 会话聚合
      meta.updatedMs = Math.max(meta.startedMs, lastTs)
      let bestModel = ''
      let bestN = -1
      for (const [k, n] of modelCount) {
        if (n > bestN) {
          bestN = n
          bestModel = k
        }
      }
      meta.model = bestModel
      if (aiTitle) meta.title = aiTitle.slice(0, 120)
      else if (firstUserTitle) meta.title = firstUserTitle.slice(0, 120)
      else if (lastPromptTitle) meta.title = lastPromptTitle.slice(0, 120)
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
      meta.toolCalls = toolUses
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
        const type = String(o.type ?? '')
        const ts = isoToMs(o.timestamp as string)

        if (type === 'user') {
          const m = (o.message ?? {}) as Record<string, unknown>
          const c = m.content
          if (typeof c === 'string') {
            const t = c.trim()
            if (t && !t.startsWith('<')) {
              out.push({ role: 'user', text: t.slice(0, 20000), timeMs: ts })
            }
            continue
          }
          if (!Array.isArray(c)) continue
          for (const item of c as Array<Record<string, unknown>>) {
            const it = String(item.type ?? '')
            if (it === 'text') {
              const t = String(item.text ?? '').trim()
              if (!t) continue
              out.push({ role: 'user', text: t.slice(0, 20000), timeMs: ts })
            } else if (it === 'tool_result') {
              const content = item.content
              let text = ''
              if (typeof content === 'string') text = content
              else if (Array.isArray(content)) {
                const parts: string[] = []
                for (const v of content as Array<Record<string, unknown>>) {
                  if (v.type === 'text' && typeof v.text === 'string') parts.push(v.text)
                }
                text = parts.join('\n')
              }
              out.push({ role: 'tool_output', text: text.slice(0, 6000), timeMs: ts })
            }
          }
        } else if (type === 'assistant') {
          const m = (o.message ?? {}) as Record<string, unknown>
          const content = (m.content ?? []) as Array<Record<string, unknown>>
          const model = String(m.model ?? '')
          const isError = !!o.isApiErrorMessage
          for (const item of content) {
            const it = String(item.type ?? '')
            if (it === 'text') {
              const text = String(item.text ?? '')
              if (!text) continue
              out.push({ role: 'assistant', model, text: text.slice(0, 20000), timeMs: ts, isError })
            } else if (it === 'thinking') {
              const text = String(item.thinking ?? '')
              if (!text) continue
              out.push({ role: 'reasoning', text: text.slice(0, 8000), timeMs: ts })
            } else if (it === 'tool_use') {
              out.push({
                role: 'tool',
                model,
                toolName: String(item.name ?? ''),
                text: JSON.stringify(item.input ?? {}).slice(0, 4000),
                timeMs: ts
              })
            }
          }
        }
      }
      return out
    } catch {
      return null
    }
  }
}
