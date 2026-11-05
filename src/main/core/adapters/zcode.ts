// main/core/adapters/zcode.ts — ZCode 适配器（SQLite 源，只读观测）。
// 对应老项目 ZCodeAdapter.cpp：session 表列会话，model_usage → 逐请求记录
// （服务器计流式时长 → 精确 TPS），turn_usage 汇总"最长聊天时长"，
// message/part 两表驱动对话重放（按 ZCode 自己的 UI 显示语义过滤）。

import { existsSync } from 'node:fs'
import type { AgentAdapter, ParseResult } from './adapter'
import { dropReadonly, openReadonly } from './sqliteUtil'
import { zcodeDbPath } from '../paths'
import type { ChatMessage } from '@shared/types'
import type { SessionFile, ToolStat } from '../util'

const ID = 'zcode'
const COLOR = '#3b82f6' // zcode blue

function sourceDb(): import('better-sqlite3').Database | null {
  try {
    return openReadonly(zcodeDbPath(), 'zcode-src')
  } catch {
    dropReadonly('zcode-src')
    return null
  }
}

function sessionIdFromPseudoPath(path: string): string {
  const bar = path.lastIndexOf('|')
  return bar >= 0 ? path.slice(bar + 1) : path
}

// part 自带 time{start|created}；比 message 的创建时间更贴近真实发生点
function partTimeMs(part: Record<string, unknown>, fallback: number): number {
  const t = (part.time ?? {}) as Record<string, unknown>
  const v = Number(t.start ?? t.created ?? 0)
  return v > 0 ? v : fallback
}

export const zcodeAdapter: AgentAdapter = {
  id: ID,
  displayName: 'ZCode',
  color: COLOR,

  dataPresent() {
    const d = zcodeDbPath()
    return { found: existsSync(d), dir: d }
  },

  listSessionFiles() {
    const files: SessionFile[] = []
    const db = sourceDb()
    if (!db) return { files, note: '数据库打不开（可能正被独占），下拍重试' }
    try {
      // 一条"伪文件"= 一个会话；mtime = session.time_updated，
      // 增量扫描器因此只重读真正变过的会话
      const rows = db
        .prepare('SELECT id, time_updated FROM session ORDER BY time_updated DESC')
        .all() as Array<{ id: string; time_updated: number }>
      const dbPath = zcodeDbPath()
      for (const r of rows) files.push({ path: dbPath + '|' + r.id, mtimeMs: Number(r.time_updated) || 0, size: 0 })
      return { files, note: files.length === 0 ? '数据库中还没有会话' : '' }
    } catch (e) {
      dropReadonly('zcode-src')
      return { files, note: '查询失败：' + String((e as Error).message).slice(0, 80) }
    }
  },

  parseFile(f: SessionFile): ParseResult | null {
    const db = sourceDb()
    if (!db) return null
    const sessionId = sessionIdFromPseudoPath(f.path)
    const meta: ParseResult['meta'] = {
      agentId: ID,
      sessionId,
      filePath: f.path,
      title: '',
      cwd: '',
      model: '',
      originator: 'zcode',
      startedMs: 0,
      updatedMs: 0,
      responses: 0,
      toolCalls: 0,
      errors: 0,
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      contextWindow: 0
    }
    const records: ParseResult['records'] = []
    const tools: Record<string, ToolStat> = {}
    try {
      // ── session meta ──
      const srow = db
        .prepare('SELECT title, directory, time_created, time_updated FROM session WHERE id = ?')
        .get(sessionId) as { title: string; directory: string; time_created: number; time_updated: number } | undefined
      if (!srow) return null // 列表与解析之间会话消失了
      meta.title = srow.title ?? ''
      meta.cwd = srow.directory ?? ''
      meta.startedMs = Number(srow.time_created) || 0
      meta.updatedMs = Number(srow.time_updated) || 0
      if (!meta.title) meta.title = meta.cwd.split(/[\\/]/).pop() || ''
      if (!meta.title) meta.title = sessionId.slice(0, 12)

      // ── durOk 门槛：只排除以失败/取消收尾的 turn —— 仍在 RUNNING 的
      // turn 的每请求服务器时长是有效的（最长聊天时长另行从 turn_usage 计算）
      const badTurns = new Set<string>()
      for (const r of db
        .prepare(
          "SELECT turn_id FROM turn_usage WHERE session_id = ? AND status IN ('error', 'cancelled', 'aborted')"
        )
        .all(sessionId) as Array<{ turn_id: string }>) {
        badTurns.add(r.turn_id)
      }

      const rows = db
        .prepare(
          `SELECT completed_at, model_id, variant, duration_ms,
                  input_tokens, output_tokens, reasoning_tokens,
                  cache_read_input_tokens, cache_creation_input_tokens,
                  query_source, status, error_type, cancelled_by_user, turn_id
           FROM model_usage WHERE session_id = ? ORDER BY started_at`
        )
        .all(sessionId) as Array<{
        completed_at: number
        model_id: string
        variant: string
        duration_ms: number
        input_tokens: number
        output_tokens: number
        reasoning_tokens: number
        cache_read_input_tokens: number
        cache_creation_input_tokens: number
        query_source: string
        status: string
        error_type: string
        cancelled_by_user: 0 | 1
        turn_id: string
      }>

      for (const q of rows) {
        const completedMs = Number(q.completed_at) || 0
        const durMs = Number(q.duration_ms) || 0
        const errorType = q.error_type ?? ''
        const cancelled = !!q.cancelled_by_user
        const rowTurn = q.turn_id ?? ''

        const r: ParseResult['records'][number] = {
          agentId: ID,
          sessionId,
          turnId: rowTurn,
          responseId: '',
          timeMs: completedMs > 0 ? completedMs : meta.updatedMs,
          durOk: durMs > 0 && !badTurns.has(rowTurn),
          durApprox: false,
          durationMs: durMs,
          model: q.model_id ?? '',
          effort: q.variant ?? '',
          source: q.query_source ?? '',
          inputTokens: Number(q.input_tokens) || 0,
          cachedTokens: Number(q.cache_read_input_tokens) || 0,
          cacheWriteTokens: Number(q.cache_creation_input_tokens) || 0,
          outputTokens: Number(q.output_tokens) || 0,
          reasoningTokens: Number(q.reasoning_tokens) || 0,
          error: '',
          tpsOk: false,
          tps: 0
        }
        // 服务器计测的时长 → 精确 TPS（与 claude 同一 100ms 下限：
        // <100ms 的行没有有意义的 tokens/sec）
        if (r.durOk && r.durationMs >= 100 && r.outputTokens + r.reasoningTokens > 0) {
          r.tpsOk = true
          r.tps = (r.outputTokens + r.reasoningTokens) / (r.durationMs / 1000)
        }
        // error/cancelled 行保留 token —— 已消耗。只有流式时长门槛排除它们
        // （官方 zcode 语义：completed-turn 过滤只作用于聊天时长）
        if (errorType || cancelled) r.error = cancelled ? 'cancelled_by_user' : errorType
        records.push(r)
      }

      // ── tool usage → 按名计数 ──
      let toolCalls = 0
      for (const t of db
        .prepare(
          `SELECT tool_name, COUNT(*) AS calls, MIN(started_at) AS first, MAX(started_at) AS last
           FROM tool_usage WHERE session_id = ? GROUP BY tool_name ORDER BY 2 DESC`
        )
        .all(sessionId) as Array<{ tool_name: string; calls: number; first: number; last: number }>) {
        const calls = Number(t.calls) || 0
        toolCalls += calls
        if (calls > 0 && t.tool_name) {
          const st = tools[t.tool_name] ?? { calls: 0, firstMs: 0, lastMs: 0 }
          st.calls += calls
          const first = Number(t.first) || 0
          const last = Number(t.last) || 0
          if (st.firstMs === 0 || (first > 0 && first < st.firstMs)) st.firstMs = first
          if (last > st.lastMs) st.lastMs = last
          tools[t.tool_name] = st
        }
      }

      // ── session 聚合 ──
      for (const r of records) {
        if (r.error) meta.errors++
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
      dropReadonly('zcode-src')
      return null
    }
  },

  parseMessages(f: SessionFile): ChatMessage[] | null {
    const db = sourceDb()
    if (!db) return null
    const sessionId = sessionIdFromPseudoPath(f.path)
    const out: ChatMessage[] = []
    try {
      // message.data = {role, time{created}, modelID, semantics{kind…}};
      // part.data = 内容块（text / reasoning / tool / step-start…）。
      // 只回放真人输入与助手响应：agent_runtime 注入的隐藏消息（todo 提醒、
      // 压缩摘要、系统提醒）与 timeline 事件按 zcode 自己的显示语义跳过
      const rows = db
        .prepare(
          `SELECT m.data AS mdata, p.data AS pdata FROM part p
           JOIN message m ON m.id = p.message_id
           WHERE p.session_id = ? ORDER BY m.time_created, p.sequence`
        )
        .all(sessionId) as Array<{ mdata: string; pdata: string }>

      for (const row of rows) {
        let msg: Record<string, unknown> = {}
        let part: Record<string, unknown> = {}
        try {
          msg = JSON.parse(row.mdata ?? '{}')
          part = JSON.parse(row.pdata || '{}')
        } catch {
          continue
        }
        const type = String(part.type ?? '')
        const role = String(msg.role ?? '')
        const kind = String(
          ((msg.semantics ?? {}) as Record<string, unknown>).kind ?? ''
        )
        const baseMs = Number(((msg.time ?? {}) as Record<string, unknown>).created ?? 0) || 0

        if (type === 'text') {
          const text = String(part.text ?? '').trim()
          if (!text) continue
          if (role === 'user') {
            if (kind !== 'user_prompt') continue // 隐藏注入
            out.push({ role: 'user', text: text.slice(0, 20000), timeMs: partTimeMs(part, baseMs) })
          } else {
            if (kind !== 'assistant_response') continue // timeline 事件等
            out.push({
              role: 'assistant',
              model: String(msg.modelID ?? ''),
              text: text.slice(0, 20000),
              timeMs: partTimeMs(part, baseMs)
            })
          }
        } else if (type === 'reasoning') {
          const text = String(part.text ?? '')
          if (!text) continue
          out.push({ role: 'reasoning', text: text.slice(0, 8000), timeMs: partTimeMs(part, baseMs) })
        } else if (type === 'tool') {
          // 调用与输出在同一个 part 的 state 里：input=参数，output=结果
          const state = (part.state ?? {}) as Record<string, unknown>
          out.push({
            role: 'tool',
            toolName: String(part.tool ?? ''),
            text: JSON.stringify(state.input ?? {}).slice(0, 4000),
            timeMs: partTimeMs(part, baseMs)
          })
          const output = String(state.output ?? '')
          if (output) {
            const endMs = Number(((state.time ?? {}) as Record<string, unknown>).end ?? 0) || 0
            out.push({
              role: 'tool_output',
              text: output.slice(0, 6000),
              timeMs: endMs > 0 ? endMs : partTimeMs(part, baseMs),
              isError: String(state.status ?? '') === 'error'
            })
          }
        }
        // step-start / step-finish / file / timeline / compaction：非对话内容
      }
      return out
    } catch {
      dropReadonly('zcode-src')
      return null
    }
  },

  longestChatMs(familyLike: string): number {
    // 对齐 ZCode 自己的用量面板：每会话 Σ 已完成 turn 时长，最大者胜出。
    // familyLike 参数化绑定 —— 不拼字符串（哪怕它来自内部常量，也杜绝注入面）
    const db = sourceDb()
    if (!db) return -1
    try {
      let sql = `SELECT MAX(agg) AS m FROM (SELECT t.session_id, SUM(t.duration_ms) agg
                 FROM turn_usage t WHERE t.status = 'completed'`
      if (familyLike)
        sql += ` AND EXISTS (SELECT 1 FROM model_usage mu WHERE mu.turn_id = t.turn_id
                 AND lower(mu.model) LIKE ?)`
      sql += ' GROUP BY t.session_id)'
      const row = (familyLike
        ? db.prepare(sql).get(familyLike)
        : db.prepare(sql).get()) as { m: number | null } | undefined
      const v = Number(row?.m ?? 0)
      return Number.isFinite(v) && v > 0 ? v : -1
    } catch {
      return -1
    }
  }
}
