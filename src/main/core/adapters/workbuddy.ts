// main/core/adapters/workbuddy.ts — workbuddy 适配器。
// ⚠️ 防御式实现：本机未发现其数据目录，格式无文档可考（仅在 CodeBuddy
// 技能市场见到相关技能名）。按常见布局探测候选目录，内容按通用 JSONL
// 形状解析（见 genericJsonl.ts）；格式不符时自动降级为空。
// 若你手上有 workbuddy 的会话文件，指个目录（NEXA_WORKBUDDY）或发一份
// 样例，即可精调成专用解析。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentAdapter, ParseResult } from './adapter'
import { homePath } from '../paths'
import { walkFiles } from '../util'
import type { SessionFile } from '../util'
import { feedGenericLine, finishGeneric, newGenericAcc, readSessionLines } from './genericJsonl'

const ID = 'workbuddy'
const COLOR = '#84cc16' // lime —— 与现有品牌色均不撞

function candidateDirs(): string[] {
  const out: string[] = []
  const env = process.env['NEXA_WORKBUDDY']
  if (env && env.trim()) out.push(env.trim())
  out.push(
    homePath('.workbuddy/sessions'),
    homePath('.workbuddy'),
    join(homePath('AppData/Roaming/workbuddy')),
    join(homePath('AppData/Local/workbuddy')),
    join(homePath('.config/workbuddy'))
  )
  return out
}

function findDataDir(): string | null {
  for (const d of candidateDirs()) {
    if (!existsSync(d)) continue
    if (walkFiles(d, ['.jsonl', '.zst', '.json']).length > 0) return d
  }
  return null
}

function baseName(p: string): string {
  const file = p.split(/[\\/]/).pop() ?? p
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

export const workbuddyAdapter: AgentAdapter = {
  id: ID,
  displayName: 'workbuddy',
  color: COLOR,

  dataPresent() {
    const d = findDataDir()
    return { found: !!d, dir: d ?? candidateDirs()[0]! }
  },

  listSessionFiles() {
    const root = findDataDir()
    const files = root ? walkFiles(root, ['.jsonl', '.zst', '.json']) : []
    return {
      files,
      note: files.length === 0 ? '未发现会话文件（候选目录均空；装好后自动探测）' : ''
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
      if (!hit || acc.records.length === 0) return null
      return finishGeneric(acc, sessionId.slice(0, 12))
    } catch {
      return null
    }
  }
}
