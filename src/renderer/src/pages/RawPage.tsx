// pages/RawPage.tsx — ≣ 原始数据：统一响应记录浏览器。按 agent 与模型关键字
// （LIKE）过滤，默认最近 400 条；点击行弹出记录对话框（摘要 + 着色 JSON +
// 复制按钮）。

import { useState, type ReactNode } from 'react'
import type { UsageRecord } from '@shared/types'
import { AGENTS_META } from '@shared/types'
import { useAsync, useDataTick } from '../lib/data'
import { exportCsv } from '../lib/csv'
import { agentColor, agentName } from '../lib/colors'
import { JsonView } from '../components/JsonView'
import { AgentTag, Badge, Card, CopyBtn, Empty, Modal } from '../components/ui'
import { fmtDur, fmtInt, fmtMs, fmtNumCn, fmtTimeFull, fmtTps, speedColor } from '../lib/format'

export function RawPage(): ReactNode {
  const [agent, setAgent] = useState('')
  const [model, setModel] = useState('')
  const [limit, setLimit] = useState(400)
  const [sel, setSel] = useState<UsageRecord | null>(null)
  const tick = useDataTick()

  const rows = useAsync<UsageRecord[]>(() => window.nexa.rawRows(agent, model, limit), [agent, model, limit, tick])
  const list = rows.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-ink">原始数据</h2>
          <span className="text-xs text-faint">统一响应记录 · 最近 {limit} 条</span>
        </div>
        <div className="flex items-center gap-2">
          <select className="input w-32" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">全部 Agent</option>
            {Object.entries(AGENTS_META).map(([id, m]) => (
              <option key={id} value={id}>
                {m.name}
              </option>
            ))}
          </select>
          <input className="input w-52 font-mono text-xs" placeholder="模型关键字（LIKE）…" value={model} onChange={(e) => setModel(e.target.value)} />
          <select className="input w-24" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[100, 400, 1000, 2000].map((n) => (
              <option key={n} value={n}>
                {n} 条
              </option>
            ))}
          </select>
          <button
            className="btn h-[30px] px-2.5 text-xs"
            onClick={() =>
              exportCsv(
                `nexa-raw-${new Date().toISOString().slice(0, 10)}.csv`,
                ['时间', 'Agent', '模型', '会话', '输入', '缓存读', '缓存写', '输出', '推理', '时长ms', 'TPS', '错误'],
                list.map((r) => [
                  new Date(r.timeMs).toLocaleString('zh-CN', { hour12: false }),
                  agentName(r.agentId),
                  r.model,
                  r.sessionId,
                  r.inputTokens,
                  r.cachedTokens,
                  r.cacheWriteTokens,
                  r.outputTokens,
                  r.reasoningTokens,
                  Math.round(r.durationMs),
                  r.tpsOk ? r.tps.toFixed(1) : '',
                  r.error
                ])
              )
            }
          >
            导出 CSV
          </button>
        </div>
      </div>

      <Card pad={false} className="overflow-x-auto">
        {rows.loading && !rows.data ? (
          <Empty text="" loading />
        ) : list.length === 0 ? (
          <div className="py-10">
            <Empty text="没有匹配的记录" />
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>时间</th>
                <th>Agent</th>
                <th>模型</th>
                <th>会话</th>
                <th className="num">输入</th>
                <th className="num">缓存</th>
                <th className="num">输出</th>
                <th className="num">推理</th>
                <th className="num">总量</th>
                <th className="num">时长</th>
                <th className="num">速度</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i} className="cursor-pointer" onClick={() => setSel(r)}>
                  <td className="text-faint">{fmtTimeFull(r.timeMs)}</td>
                  <td>
                    <AgentTag id={r.agentId} name={agentName(r.agentId)} color={agentColor(r.agentId)} size={6} />
                  </td>
                  <td className="max-w-44 truncate font-mono text-xs" title={r.model}>
                    {r.model || '—'}
                    {r.effort && <span className="ml-1 text-faint">{r.effort}</span>}
                  </td>
                  <td className="font-mono text-xs text-faint">{r.sessionId.slice(0, 8)}</td>
                  <td className="num">{fmtNumCn(r.inputTokens)}</td>
                  <td className="num text-faint">{fmtNumCn(r.cachedTokens + r.cacheWriteTokens)}</td>
                  <td className="num">{fmtNumCn(r.outputTokens)}</td>
                  <td className="num">{fmtNumCn(r.reasoningTokens)}</td>
                  <td className="num font-medium">{fmtNumCn(r.inputTokens + r.outputTokens + r.reasoningTokens)}</td>
                  <td className="num text-faint">
                    {r.durOk ? fmtMs(r.durationMs) : '—'}
                    {r.durApprox ? '≈' : ''}
                  </td>
                  <td className="num font-semibold" style={{ color: r.tpsOk ? speedColor(r.tps) : undefined }}>
                    {r.tpsOk ? fmtTps(r.tps) : '—'}
                  </td>
                  <td>
                    {r.error ? (
                      <Badge tone="bad">{r.error}</Badge>
                    ) : r.source && r.source !== 'main' ? (
                      <Badge tone="accent">{r.source}</Badge>
                    ) : (
                      <span className="text-xs text-faint">ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 记录对话框 */}
      <Modal
        open={!!sel}
        onClose={() => setSel(null)}
        wide
        title={
          sel ? (
            <span className="flex items-center gap-2">
              <AgentTag id={sel.agentId} name={agentName(sel.agentId)} color={agentColor(sel.agentId)} />
              <span className="font-mono">{sel.model || '—'}</span>
              <span className="text-faint">{fmtTimeFull(sel.timeMs)}</span>
            </span>
          ) : (
            ''
          )
        }
      >
        {sel && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="chip">时长 {sel.durOk ? fmtDur(sel.durationMs / 1000) : '—'}{sel.durApprox ? ' ≈' : ''}</span>
              <span className="chip">速度 {sel.tpsOk ? fmtTps(sel.tps) : '—'}</span>
              <span className="chip">输入 {fmtInt(sel.inputTokens)}</span>
              <span className="chip">缓存读 {fmtInt(sel.cachedTokens)}</span>
              <span className="chip">缓存写 {fmtInt(sel.cacheWriteTokens)}</span>
              <span className="chip">输出 {fmtInt(sel.outputTokens)}</span>
              <span className="chip">推理 {fmtInt(sel.reasoningTokens)}</span>
              {sel.error && <span className="chip text-bad">✗ {sel.error}</span>}
            </div>
            <div className="card max-h-[46vh] overflow-auto p-3">
              <JsonView data={sel} />
            </div>
            <div className="text-right">
              <CopyBtn text={JSON.stringify(sel, null, 2)} label="复制 JSON" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
