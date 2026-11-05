// main/core/adapters/pi.ts — pi（badlogic）适配器（sessions JSONL）。
// 对应老项目 PiAdapter.cpp：官方文档格式 + 防御式解析；pi 用 camelCase
// usage 字段（input/output/cacheRead/cacheWrite），snake_case 变体也认。

import { existsSync } from 'node:fs'
import type { AgentAdapter, ParseResult } from './adapter'
import { newMeta } from './adapter'
import { piSessionsDir } from '../paths'
import { isoToMs, readLines, walkFiles } from '../util'
import type { UsageRecord } from '@shared/types'
import type { SessionFile } from '../util'

const ID = 'pi'
const COLOR = '#e06c75' // pi red

function baseName(p: string): string {
  const file = p.split(/[\\/]/).pop() ?? p
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

// 宽容的 usage 提取：camelCase 优先，snake_case 兜底
function readUsage(u: Record<string, unknown>, r: UsageRecord): void {
  r.inputTokens = Number(u.input ?? 0) || Number(u.input_tokens ?? 0) || 0
  r.outputTokens = Number(u.output ?? 0) || Number(u.output_tokens ?? 0) || 0
  r.cachedTokens = Number(u.cacheRead ?? 0) || Number(u.cache_read_input_tokens ?? 0) || 0
  r.cacheWriteTokens = Number(u.cacheWrite ?? 0) || Number(u.cache_creation_input_tokens ?? 0) || 0
}

export const piAdapter: AgentAdapter = {
  id: ID,
  displayName: 'pi',
  color: COLOR,

  dataPresent() {
    const d = piSessionsDir()
    return { found: existsSync(d), dir: d }
  },

  listSessionFiles() {
    const root = piSessionsDir()
    const files = existsSync(root) ? walkFiles(root, ['.jsonl']) : []
    return { files, note: files.length === 0 ? '未发现会话文件（按官方文档格式解析）' : '' }
  },

  parseFile(f: SessionFile): ParseResult | null {
    const sessionId = baseName(f.path)
    const meta = newMeta(ID, sessionId, f.path)
    const records: UsageRecord[] = []
    try {
      let model = ''
      let lastTs = 0
      let prevTs = 0

      for (const line of readLines(f.path)) {
        let o: Record<string, unknown>
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        const type = String(o.type ?? '')
        const ts = isoToMs(o.timestamp as string)
        if (ts > 0) {
          lastTs = Math.max(lastTs, ts)
          prevTs = ts
        }

        if (type === 'session') {
          if (!meta.startedMs) meta.startedMs = ts
          meta.cwd = String(o.cwd ?? '')
          meta.originator = 'pi ' + String(o.version ?? '')
          const sid = String(o.id ?? '')
          if (sid) meta.sessionId = sid
        } else if (type === 'model_change') {
          const m = String(o.model ?? '')
          if (m) model = m
        } else if (type === 'message') {
          // pi 把 LLM 消息包了一层；嵌套与扁平两种形态都接受
          let m = (o.message ?? {}) as Record<string, unknown>
          if (Object.keys(m).length === 0) m = o
          const role = String(m.role ?? '')
          if (role !== 'assistant' && !('usage' in m)) continue
          const u = (m.usage ?? {}) as Record<string, unknown>
          if (Object.keys(u).length === 0) continue
          const r: UsageRecord = {
            agentId: ID,
            sessionId: meta.sessionId,
            turnId: '',
            responseId: '',
            timeMs: ts,
            durOk: false,
            durApprox: false,
            durationMs: 0,
            model: String(m.model ?? '') || String(o.model ?? '') || model,
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
          readUsage(u, r)
          if (r.inputTokens + r.outputTokens + r.reasoningTokens === 0) continue
          if (prevTs > 0 && ts > prevTs) {
            r.durOk = true
            r.durApprox = true
            r.durationMs = ts - prevTs
          }
          records.push(r)
        }
      }

      meta.updatedMs = Math.max(meta.startedMs, lastTs)
      meta.model = model
      if (meta.cwd && !meta.title) meta.title = fileName(meta.cwd.replace(/[\\/]+$/, ''))
      for (const r of records) {
        meta.inputTokens += r.inputTokens
        meta.cachedTokens += r.cachedTokens
        meta.cacheWriteTokens += r.cacheWriteTokens
        meta.outputTokens += r.outputTokens
        meta.reasoningTokens += r.reasoningTokens
      }
      meta.responses = records.length
      if (!meta.title) meta.title = meta.sessionId.slice(0, 12)
      return { meta, records, tools: {} } // pi 工具调用形态未文档化 —— 不计数
    } catch {
      return null
    }
  }
}
