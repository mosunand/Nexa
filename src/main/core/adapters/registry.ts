// main/core/adapters/registry.ts — 内置适配器注册表（显示顺序）。
// 对应老项目 AgentRegistry::createAdapters()。

import type { AgentAdapter } from './adapter'
import { zcodeAdapter } from './zcode'
import { codexAdapter } from './codex'
import { claudeAdapter } from './claude'
import { geminiAdapter, qwenAdapter } from './geminiLike'
import { opencodeAdapter } from './opencode'
import { piAdapter } from './pi'
import { msagentAdapter } from './msagent'
import { dshAdapter } from './dsh'
import { workbuddyAdapter } from './workbuddy'

export function createAdapters(): AgentAdapter[] {
  return [
    zcodeAdapter,
    codexAdapter,
    claudeAdapter,
    geminiAdapter,
    qwenAdapter,
    opencodeAdapter,
    piAdapter,
    // 新增 agent：msagent 为实测完整支持，dsh/workbuddy 为防御式实现
    msagentAdapter,
    dshAdapter,
    workbuddyAdapter
  ]
}
