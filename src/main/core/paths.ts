// main/core/paths.ts — 各 agent 数据目录与自身存储位置的解析（环境变量可覆盖）。
// 对应老项目 Paths.cpp + 各适配器内散落的目录探测。
// 注意：本模块运行在 worker 线程，Electron app 对象不可用 —— userData
// 路径由主进程在 spawn worker 时传入（initPaths）。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

let g_userData = ''

export function initPaths(userData: string): void {
  g_userData = userData
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : fallback
}

function underHome(tail: string): string {
  return join(homedir(), tail)
}

/** home 下相对路径（供适配器探测候选目录用） */
export function homePath(tail: string): string {
  return underHome(tail)
}

// ── 自身存储 ──

export function cacheDbPath(): string {
  return join(g_userData, 'cache.sqlite')
}

export function cacheDir(): string {
  return g_userData
}

// 归档默认进 userData（修复老版本"装进 Program Files 后归档不落盘"的已知限制）；
// 兼容老用户：优先 NEXA_ARCHIVE，其次老项目的 AGENT_MONITOR_ARCHIVE。
export function archivePath(): string {
  return envOr(
    'NEXA_ARCHIVE',
    envOr('AGENT_MONITOR_ARCHIVE', join(g_userData, 'usage-archive.bin'))
  )
}

// ── 各 agent ──

export function codexHome(): string {
  return envOr('CODEX_HOME', underHome('.codex'))
}
export function codexSessionsDir(): string {
  return join(codexHome(), 'sessions')
}
export function codexArchiveDir(): string {
  return join(codexHome(), 'archived_sessions')
}

export function claudeHome(): string {
  return envOr('CLAUDE_CONFIG_DIR', underHome('.claude'))
}
export function claudeProjectsDir(): string {
  return join(claudeHome(), 'projects')
}

export function zcodeDbPath(): string {
  return envOr('ZCODE_DB', underHome('.zcode/cli/db/db.sqlite'))
}

export function opencodeDbPath(): string {
  const env = process.env.OPENCODE_DB
  if (env && env.trim()) return env.trim()
  const appdata = process.env.APPDATA ?? underHome('AppData/Roaming')
  const candidates = [
    join(appdata, 'opencode/opencode.db'),
    underHome('.local/share/opencode/opencode.db'),
    underHome('.local/share/opencode/opencode.db3')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return candidates[0]!
}

// pi：PI_CODING_AGENT_SESSION_DIR → 目录本身；
//     PI_CODING_AGENT_DIR → <dir>/agent/sessions；默认 ~/.pi/agent/sessions
export function piSessionsDir(): string {
  const sd = process.env.PI_CODING_AGENT_SESSION_DIR
  if (sd && sd.trim()) return sd.trim()
  const root = process.env.PI_CODING_AGENT_DIR
  if (root && root.trim()) return join(root.trim(), 'agent', 'sessions')
  return underHome('.pi/agent/sessions')
}

// gemini / qwen 这对孪生的公共目录
export function geminiLikeHome(dirName: string, envVar: string | null): string {
  return envVar ? envOr(envVar, underHome(dirName)) : underHome(dirName)
}
