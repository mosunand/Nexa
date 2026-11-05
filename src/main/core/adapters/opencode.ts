// main/core/adapters/opencode.ts — OpenCode 适配器（v2 SQLite）。
// 对应老项目 OpenCodeAdapter.cpp：候选库路径首个存在者胜出（env 可覆盖），
// session 表名跨 schema 代际变化（session / session_v2），token 数据在
// message.data JSON blob 里。

import { existsSync } from 'node:fs'
import type { AgentAdapter, ParseResult } from './adapter'
import { newMeta } from './adapter'
import { dropReadonly, openReadonly } from './sqliteUtil'
import { opencodeDbPath } from '../paths'
import type { UsageRecord } from '@shared/types'
import type { SessionFile } from '../util'

const ID = 'opencode'
const COLOR = '#14b8a6' // opencode teal

function sourceDb(): import('better-sqlite3').Database | null {
  try {
    return openReadonly(opencodeDbPath(), 'opencode-src')
  } catch {
    dropReadonly('opencode-src')
    return null
  }
}

function sessionIdFromPseudoPath(path: string): string {
  const bar = path.lastIndexOf('|')
  return bar >= 0 ? path.slice(bar + 1) : path
}

export const opencodeAdapter: AgentAdapter = {
  id: ID,
  displayName: 'OpenCode',
  color: COLOR,

  dataPresent() {
    const d = opencodeDbPath()
    return { found: existsSync(d), dir: d }
  },

  listSessionFiles() {
    const files: SessionFile[] = []
    const db = sourceDb()
    if (!db) return { files, note: '数据库打不开（可能正被独占），下拍重试' }
    try {
      // 表名跨 schema 代际变化
      let sessionTable = ''
      for (const t of ['session', 'session_v2']) {
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(t) as { name: string } | undefined
        if (row) {
          sessionTable = t
          break
        }
      }
      if (!sessionTable) return { files, note: '库中未发现 session 表' }
      const rows = db.prepare(`SELECT id, time_updated FROM ${sessionTable}`).all() as Array<{
        id: string
        time_updated: number
      }>
      const path = opencodeDbPath()
      for (const r of rows) files.push({ path: path + '|' + r.id, mtimeMs: Number(r.time_updated) || 0, size: 0 })
      return { files, note: files.length === 0 ? '数据库中还没有会话' : '' }
    } catch (e) {
      dropReadonly('opencode-src')
      return { files, note: '查询失败：' + String((e as Error).message).slice(0, 80) }
    }
  },

  parseFile(f: SessionFile): ParseResult | null {
    const sessionId = sessionIdFromPseudoPath(f.path)
    const meta = newMeta(ID, sessionId, f.path)
    meta.originator = 'opencode'
    const records: UsageRecord[] = []
    try {
      const db = sourceDb()
      if (!db) return null

      // session meta（title/directory 列在大多数代际里存在）
      const srow = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId) as
        | Record<string, unknown>
        | undefined
      if (!srow) return null // 列表与解析之间会话消失了
      if ('title' in srow) meta.title = String(srow.title ?? '')
      if ('directory' in srow) meta.cwd = String(srow.directory ?? '')
      if ('time_created' in srow) meta.startedMs = Number(srow.time_created) || 0
      if ('time_updated' in srow) meta.updatedMs = Number(srow.time_updated) || 0

      // message 行：token 数据在 `data` JSON blob 里
      const rows = db
        .prepare('SELECT data FROM message WHERE session_id = ? ORDER BY time_created')
        .all(sessionId) as Array<{ data: string }>

      for (const row of rows) {
        let o: Record<string, unknown>
        try {
          o = JSON.parse(row.data ?? '{}')
        } catch {
          continue
        }
        if (String(o.role ?? '') !== 'assistant') continue
        const tokens = (o.tokens ?? {}) as Record<string, unknown>
        if (Object.keys(tokens).length === 0) continue
        const time = (o.time ?? {}) as Record<string, unknown>
        const model = (o.model ?? {}) as Record<string, unknown>
        const cache = (tokens.cache ?? {}) as Record<string, unknown>

        const r: UsageRecord = {
          agentId: ID,
          sessionId,
          turnId: '',
          responseId: String(o.id ?? ''),
          timeMs: 0,
          durOk: false,
          durApprox: false,
          durationMs: 0,
          model: String(model.id ?? o.modelID ?? ''),
          effort: String(model.variant ?? ''),
          source: 'main',
          inputTokens: Number(tokens.input ?? 0) || 0,
          cachedTokens: Number(cache.read ?? 0) || 0,
          cacheWriteTokens: Number(cache.write ?? 0) || 0,
          outputTokens: Number(tokens.output ?? 0) || 0,
          reasoningTokens: Number(tokens.reasoning ?? 0) || 0,
          error: '',
          tpsOk: false,
          tps: 0
        }
        const created = Number(time.created ?? 0) || 0
        const completed = Number(time.completed ?? 0) || 0
        r.timeMs = completed > 0 ? completed : created
        if (completed > created && completed - created >= 100) {
          r.durOk = true
          r.durationMs = completed - created
          if (r.outputTokens + r.reasoningTokens > 0) {
            r.tpsOk = true
            r.tps = (r.outputTokens + r.reasoningTokens) / (r.durationMs / 1000)
          }
        }
        if (r.inputTokens + r.outputTokens + r.reasoningTokens <= 0 && !r.error) continue
        records.push(r)
      }

      meta.updatedMs = Math.max(meta.startedMs, meta.updatedMs)
      if (meta.cwd && !meta.title) meta.title = meta.cwd.split(/[\\/]/).pop() ?? ''
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
      if (!meta.title) meta.title = meta.sessionId.slice(0, 12)
      return { meta, records, tools: {} } // 工具名在 part blob 里 —— 暂不聚合
    } catch {
      dropReadonly('opencode-src')
      return null
    }
  }
}
