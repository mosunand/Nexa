// main/core/adapters/geminiLike.ts — Gemini CLI / Qwen Code 孪生适配器。
// 对应老项目 GeminiLikeAdapter.cpp：~/.gemini|~/.qwen/tmp/*/chats/ 下的
// 新 JSONL 树格式与旧单 JSON 格式；TokensSummary 与 usageMetadata 两套
// token 字段都认。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentAdapter, ParseResult } from './adapter'
import { newMeta } from './adapter'
import { geminiLikeHome } from '../paths'
import { isoToMs, readLines, walkFiles } from '../util'
import type { UsageRecord } from '@shared/types'
import type { SessionFile } from '../util'

function baseName(p: string): string {
  const file = p.split(/[\\/]/).pop() ?? p
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

// gemini TokensSummary: {input, output, cached, thoughts, tool, total}
// qwen usageMetadata:  {promptTokenCount, candidatesTokenCount,
//                       cachedContentTokenCount, thoughtsTokenCount}
function readTokens(o: Record<string, unknown>, r: UsageRecord): void {
  let t = (o.tokens ?? {}) as Record<string, unknown>
  if (Object.keys(t).length === 0) t = (o.usageMetadata ?? {}) as Record<string, unknown>
  if (Object.keys(t).length === 0) return
  if ('input' in t) {
    // gemini TokensSummary
    r.inputTokens = Number(t.input ?? 0) || 0
    r.outputTokens = Number(t.output ?? 0) || 0
    r.cachedTokens = Number(t.cached ?? 0) || 0
    r.reasoningTokens = Number(t.thoughts ?? 0) || 0
  } else {
    // gemini-sdk GenerateContentResponseUsageMetadata（qwen）
    r.inputTokens = Number(t.promptTokenCount ?? 0) || 0
    r.outputTokens = Number(t.candidatesTokenCount ?? 0) || 0
    r.cachedTokens = Number(t.cachedContentTokenCount ?? 0) || 0
    r.reasoningTokens = Number(t.thoughtsTokenCount ?? 0) || 0
  }
}

function makeAdapter(id: string, displayName: string, color: string, homeDirName: string, homeEnvVar: string | null): AgentAdapter {
  return {
    id,
    displayName,
    color,

    dataPresent() {
      const home = geminiLikeHome(homeDirName, homeEnvVar)
      const d = join(home, 'tmp')
      return { found: existsSync(d), dir: d }
    },

    listSessionFiles() {
      const home = geminiLikeHome(homeDirName, homeEnvVar)
      const chatsRoot = join(home, 'tmp')
      const files = existsSync(chatsRoot) ? walkFiles(chatsRoot, ['.jsonl', '.json']) : []
      return { files, note: files.length === 0 ? '未发现会话文件（chats/*.jsonl|*.json）' : '' }
    },

    parseFile(f: SessionFile): ParseResult | null {
      const meta = newMeta(id, baseName(f.path), f.path)
      const records: UsageRecord[] = []
      try {
        let lastTs = 0
        const modelCount = new Map<string, number>()
        let metaDirectories = ''

        const readMessage = (o: Record<string, unknown>, type: string): void => {
          if (type !== 'gemini' && type !== 'assistant') return
          const r: UsageRecord = {
            agentId: id,
            sessionId: meta.sessionId,
            turnId: '',
            responseId: '',
            timeMs: isoToMs(o.timestamp as string),
            durOk: false,
            durApprox: false,
            durationMs: 0,
            model: String(o.model ?? ''),
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
          readTokens(o, r)
          if (r.inputTokens + r.outputTokens + r.reasoningTokens <= 0) return
          records.push(r)
          if (r.model) modelCount.set(r.model, (modelCount.get(r.model) ?? 0) + 1)
        }

        if (f.path.toLowerCase().endsWith('.jsonl')) {
          // ── 当前 JSONL 树格式 ──
          for (const line of readLines(f.path)) {
            let o: Record<string, unknown>
            try {
              o = JSON.parse(line)
            } catch {
              continue
            }
            const type = String(o.type ?? '')
            const ts = isoToMs(o.timestamp as string)
            if (ts > 0) lastTs = Math.max(lastTs, ts)

            if (type === 'metadata' || 'sessionId' in o) {
              const sid = String(o.sessionId ?? '')
              if (sid) meta.sessionId = sid
              if (!meta.startedMs) meta.startedMs = ts > 0 ? ts : isoToMs(o.startTime as string)
              const dirs = (o.directories ?? []) as unknown[]
              if (Array.isArray(dirs) && dirs.length > 0) metaDirectories = String(dirs[0])
              if (String(o.kind ?? '') === 'subagent') meta.originator = 'subagent'
            }
            readMessage(o, type)
          }
        } else {
          // ── 旧单 JSON：{sessionId, startTime, messages:[...]} ──
          let root: Record<string, unknown> = {}
          try {
            root = JSON.parse(readFileSync(f.path, 'utf8'))
          } catch {
            return null
          }
          const sid = String(root.sessionId ?? '')
          if (sid) meta.sessionId = sid
          meta.startedMs = isoToMs(root.startTime as string)
          const msgs = (root.messages ?? []) as Array<Record<string, unknown>>
          for (const o of msgs) {
            const ts = isoToMs(o.timestamp as string)
            if (ts > 0) lastTs = Math.max(lastTs, ts)
            readMessage(o, String(o.type ?? ''))
          }
        }

        // 聚合
        meta.updatedMs = Math.max(meta.startedMs, lastTs)
        if (metaDirectories) meta.cwd = metaDirectories
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
        return { meta, records, tools: {} } // gemini 系文件记工具调用但不记名字
      } catch {
        return null
      }
    }
  }
}

export const geminiAdapter = makeAdapter('gemini', 'Gemini CLI', '#4285f4', '.gemini', null)
export const qwenAdapter = makeAdapter('qwen', 'Qwen Code (千问)', '#7c3aed', '.qwen', 'QWEN_HOME')
