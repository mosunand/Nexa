// main/core/adapters/customAgent.ts — 用户自定义 agent 的动态适配器工厂。
// 自写 agent 的数据目录无法自动探测 —— 用户在设置里登记目录并选一个格式
// 模板：既有的 claude/codex/gemini/pi/msagent 解析器直接复用（只换目录），
// 未知格式走通用 JSONL 防御解析（genericJsonl.ts）。

import { existsSync } from 'node:fs'
import type { AgentAdapter } from './adapter'
import type { CustomAgentConfig } from '@shared/types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { geminiAdapter, qwenAdapter } from './geminiLike'
import { piAdapter } from './pi'
import { msagentAdapter } from './msagent'
import { feedGenericLine, finishGeneric, newGenericAcc, readSessionLines } from './genericJsonl'
import { walkFiles } from '../util'

const CUSTOM_PREFIX = 'custom-'

export function customAgentId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return CUSTOM_PREFIX + (slug || 'agent')
}

// 自定义 agent 品牌色：按 id 稳定分配（与内置色不冲突）
const CUSTOM_PALETTE = ['#38bdf8', '#e879f9', '#facc15', '#fb7185', '#4ade80', '#c084fc', '#fdba74', '#5eead4']

export function customAgentColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return CUSTOM_PALETTE[Math.abs(h) % CUSTOM_PALETTE.length] as string
}

// 通用 JSONL 解析的自定义适配器
function buildGenericAdapter(cfg: CustomAgentConfig, color: string): AgentAdapter {
  return {
    id: cfg.id,
    displayName: cfg.name,
    color,
    dataPresent: () => ({ found: existsSync(cfg.dir), dir: cfg.dir }),
    listSessionFiles: () => {
      const files = existsSync(cfg.dir) ? walkFiles(cfg.dir, ['.jsonl', '.json', '.zst']) : []
      return { files, note: files.length === 0 ? '目录暂无会话文件（.jsonl/.json/.zst）' : '' }
    },
    parseFile: (f) => {
      try {
        const acc = newGenericAcc(cfg.id, sessionIdFromFile(f.path), f.path)
        let hit = false
        for (const line of readSessionLines(f.path)) {
          if (!line.trim()) continue
          if (feedGenericLine(acc, line, cfg.id)) hit = true
        }
        if (!hit || acc.records.length === 0) return null // 无可识别内容 → 不入缓存
        return finishGeneric(acc, sessionIdFromFile(f.path).slice(0, 12))
      } catch {
        return null
      }
    }
  }
}

function sessionIdFromFile(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

// 按配置构建自定义适配器；format = 内置格式模板 → 克隆该适配器只换目录
export function buildCustomAdapter(cfg: CustomAgentConfig, color: string): AgentAdapter | null {
  const dir = cfg.dir
  if (cfg.format === 'generic') return buildGenericAdapter(cfg, color)

  const base: AgentAdapter | undefined = {
    claude: claudeAdapter,
    codex: codexAdapter,
    gemini: geminiAdapter,
    qwen: qwenAdapter,
    pi: piAdapter,
    msagent: msagentAdapter
  }[cfg.format]
  if (!base) return null

  return {
    id: cfg.id,
    displayName: cfg.name,
    color,
    dataPresent: () => ({ found: existsSync(dir), dir }),
    listSessionFiles: () => {
      const files = existsSync(dir) ? walkFiles(dir, ['.jsonl', '.json', '.zst']) : []
      return { files, note: files.length === 0 ? '目录暂无会话文件' : '' }
    },
    parseFile: (f) => base.parseFile(f),
    parseMessages: base.parseMessages ? (f) => base.parseMessages!(f) : undefined
  }
}

export const CUSTOM_ID_PREFIX = CUSTOM_PREFIX
