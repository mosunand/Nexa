// main/core/adapters/adapter.ts — 适配器插件接口 + 内置注册表。
// 对应老项目 AgentAdapter.h / AgentAdapter.cpp。
// 一个适配器知道：agent 把会话写在哪里、如何廉价地列出会话文件
// （mtime/size 探测）、如何把一个文件归一化为统一的 SessionInfo +
// UsageRecord 模型。新增 agent = 实现接口 + 在 createAdapters() 注册。

import type { ChatMessage, SessionInfo, UsageRecord } from '@shared/types'
import type { SessionFile, ToolStat } from '../util'
import { createAdapters as _create } from './registry'

export interface ParseResult {
  meta: SessionInfo
  records: UsageRecord[]
  tools: Record<string, ToolStat>
}

export interface AgentAdapter {
  id: string
  displayName: string
  color: string

  // 数据目录存在？（返回探测的目录路径）
  dataPresent(): { found: boolean; dir: string }

  // 廉价目录遍历：文件列表 + mtime/size，不做内容解析。
  // note：空列表时的提示（打不开库 / 没有会话等）
  listSessionFiles(): { files: SessionFile[]; note: string }

  // 把一个文件解析进统一模型。返回 null = 文件完全读不了；
  // 坏行防御式跳过。
  parseFile(f: SessionFile): ParseResult | null

  // 对话重放 —— 按需从源文件解析（永不入缓存库）。
  // 返回 null = 该 agent 暂不支持。
  parseMessages?(f: SessionFile): ChatMessage[] | null

  // 最长聊天时长（agent 官方口径；-1 = 不支持，归档的流式时长和兜底）
  longestChatMs?(familyLike: string): number
}

// 空 SessionInfo 工厂
export function newMeta(agentId: string, sessionId: string, filePath: string): SessionInfo {
  return {
    agentId,
    sessionId,
    filePath,
    title: '',
    cwd: '',
    model: '',
    originator: '',
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
}

// SQLite 只读连接助手（zcode / opencode 共用）
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

export function createAdapters(): AgentAdapter[] {
  return _create()
}
