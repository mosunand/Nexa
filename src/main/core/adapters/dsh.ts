// main/core/adapters/dsh.ts — DeepSeek Harness（dsh）适配器。
// ⚠️ 防御式实现：官方格式未在本地实测（老项目路线图：~/.dsh/sessions，
// zstd 压缩）。zstd 帧自动解压（fzstd 纯 JS，零原生依赖），内容按通用
// JSONL 形状解析（见 genericJsonl.ts）；格式不符时自动降级为空，不影响
// 其他 agent。拿到真实样例后请替换为专用解析。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentAdapter, ParseResult } from './adapter'
import { homePath } from '../paths'
import { walkFiles } from '../util'
import type { SessionFile } from '../util'
import { feedGenericLine, finishGeneric, newGenericAcc, readSessionLines } from './genericJsonl'

const ID = 'dsh'
const COLOR = '#4d6bfe' // DeepSeek 品牌蓝

function sessionsDir(): string {
  const env = process.env['NEXA_DSH']
  if (env && env.trim()) return env.trim()
  return homePath('.dsh/sessions')
}

function baseName(p: string): string {
  const file = p.split(/[\\/]/).pop() ?? p
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

export const dshAdapter: AgentAdapter = {
  id: ID,
  displayName: 'DeepSeek Harness (dsh)',
  color: COLOR,

  dataPresent() {
    const d = sessionsDir()
    return { found: existsSync(d), dir: d }
  },

  listSessionFiles() {
    const root = sessionsDir()
    const files = existsSync(root) ? walkFiles(root, ['.jsonl', '.zst', '.json']) : []
    return {
      files,
      note: files.length === 0 ? '未发现会话文件（~/.dsh/sessions，装好后自动探测）' : ''
    }
  },

  parseFile(f: SessionFile): ParseResult | null {
    const sessionId = baseName(f.path)
    const acc = newGenericAcc(ID, sessionId, f.path)
    try {
      const lines = readSessionLines(f.path)
      let hit = false
      for (const line of lines) {
        if (!line.trim()) continue
        if (feedGenericLine(acc, line, ID)) hit = true
      }
      if (!hit || acc.records.length === 0) return null // 无可识别内容 → 不入缓存
      return finishGeneric(acc, sessionId.slice(0, 12))
    } catch {
      return null
    }
  }
}

// dsh 候选目录（供数据源页展示）
export function dshCandidateDirs(): string[] {
  return [sessionsDir(), join(homePath('.dsh'), 'sessions')]
}
