// pages/SourcesPage.tsx — ▦ 数据源：各 agent 探测状态（徽章：已检测 /
// 未检测）、数据目录、会话文件数、最近活动；附数据口径说明与
// "如何新增一个 agent 适配器"指南。

import { type ReactNode } from 'react'
import type { AgentStatus } from '@shared/types'
import { useAsync, useDataTick } from '../lib/data'
import { agentColor } from '../lib/colors'
import { Badge, Card, CardTitle, Empty } from '../components/ui'
import { fmtInt, relTime } from '../lib/format'

export function SourcesPage(): ReactNode {
  const tick = useDataTick()
  const statuses = useAsync<AgentStatus[]>(() => window.nexa.agentStatuses(), [tick])

  if (statuses.loading && !statuses.data) return <Empty text="" loading />
  const list = statuses.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-bold text-ink">数据源</h2>
        <span className="text-xs text-faint">全程只读 · 只观测、不修改任何 agent 的数据</span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
        {list.map((s) => (
          <Card key={s.id}>
            <div className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: agentColor(s.id) }} />
              <span className="text-sm font-semibold text-ink">{s.name}</span>
              {s.found ? <Badge tone="ok">已检测</Badge> : <Badge>未检测</Badge>}
              <span className="ml-auto text-xs text-faint">{relTime(s.lastActivityMs)}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted">会话文件</div>
                <div className="mt-0.5 font-mono text-sm text-ink">{s.found ? fmtInt(s.sessions) : '—'}</div>
              </div>
              <div>
                <div className="text-muted">最近活动</div>
                <div className="mt-0.5 text-sm text-ink">{s.lastActivityMs > 0 ? relTime(s.lastActivityMs) : '—'}</div>
              </div>
            </div>
            <div className="mt-3">
              <div className="text-muted">数据目录</div>
              <div className="mono mt-0.5 break-all text-[11px] text-soft" title={s.dataDir}>
                {s.dataDir || '—'}
              </div>
            </div>
            {s.note && <div className="mt-2 text-[11px] text-faint">{s.note}</div>}
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardTitle>数据口径</CardTitle>
          <ul className="space-y-2 text-xs leading-relaxed text-muted">
            <li>
              <b className="text-ink">一条记录 = 一次完成的模型响应</b>
              ，带五类 token：输入 / 缓存读 / 缓存写 / 输出 / 推理。总 token = 输入 + 输出 + 推理（缓存不计入总量）。
            </li>
            <li>
              <b className="text-ink">TPS =（输出 + 推理）÷ 流式秒数</b>
              ，分层着色 &lt;20 红 / 20–100 黄 / &gt;100 绿；"加权平均" = Σ生成 token ÷ Σ可测秒数（不是逐条平均）。
            </li>
            <li>
              <b className="text-ink">时长可测性</b>
              ：ZCode / Claude Code / OpenCode 有精确流式时长；Codex 与 pi 用相邻响应时间差近似（界面标 ≈）。相邻间隔超过
              120 秒视为不可测；100ms 以下的单块响应不参与速度统计。
            </li>
            <li>
              <b className="text-ink">错误口径</b>
              ：中止 / API 错误 / 取消各记一条零 token 错误记录（已消耗 token 保留在统计里），错误率 = 错误 ÷ 总请求。
            </li>
            <li>
              <b className="text-ink">时间与"今天"</b>
              ：按本地时区，"今天"按本地零点切；日聚合对齐本地午夜。
            </li>
            <li>
              <b className="text-ink">模型大类</b>
              ：模型名第一个 <code className="mono">-</code> 前的小写段（GLM-5.3-Flash → glm）。
            </li>
          </ul>
        </Card>

        <Card>
          <CardTitle>如何新增一个 agent 适配器</CardTitle>
          <ol className="list-decimal space-y-2 pl-4 text-xs leading-relaxed text-muted">
            <li>
              新建 <code className="mono text-ink">src/main/core/adapters/xxx.ts</code>
              ，实现 <code className="mono text-ink">AgentAdapter</code> 接口：
              <code className="mono text-ink"> id / displayName / color / dataPresent /
              listSessionFiles / parseFile</code>
              （把自家 JSONL / JSON / SQLite 归一化为统一的 SessionInfo + UsageRecord，
              逐行防御式解析；支持对话重放则再实现 parseMessages）。
            </li>
            <li>
              在 <code className="mono text-ink">registry.ts</code> 注册。
            </li>
            <li>UI、过滤、聚合、缓存、归档全部自动生效。</li>
          </ol>
          <p className="mt-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[11px] text-faint">
            格式变化时适配器自动降级为空，不影响其他 agent；装了对应 agent 后会被自动探测并纳入统计。
            第三方模型（如 Claude Code 路由到 GLM / DeepSeek）按模型名出现在该 agent 的记录里，按模型维度自然覆盖。
          </p>
        </Card>
      </div>
    </div>
  )
}
