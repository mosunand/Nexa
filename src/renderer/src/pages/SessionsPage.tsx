// pages/SessionsPage.tsx — ▤ 会话：左侧跨全部 agent 的会话列表（过滤/排序/
// 搜索），右侧详情四个标签页 —— 均为懒加载（切到才解析，点开本体毫秒级）：
//   概览：元数据表 + 逐响应 TPS 曲线
//   对话：完整对话重放（五种角色分色排版，代码块等宽面板，出错染红）
//   明细：逐响应 token 表
//   JSON：该会话每条响应的统一原始记录（语法着色）

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ChatMessage, SessionInfo, UsageRecord } from '@shared/types'
import { AGENTS_META } from '@shared/types'
import { useAsync, useDataTick } from '../lib/data'
import { agentColor, agentName } from '../lib/colors'
import { Chart, chartTheme } from '../components/Chart'
import { JsonView } from '../components/JsonView'
import { AgentTag, Card, CopyBtn, Empty, Modal } from '../components/ui'
import { fmtDur, fmtInt, fmtMs, fmtNumCn, fmtTime, fmtTimeFull, fmtTps, relTime, shortId, speedColor } from '../lib/format'
import { useTheme } from '../lib/theme'

type SortKey = 'updated' | 'tokens'
type Tab = 'overview' | 'chat' | 'detail' | 'json'

export function SessionsPage(): ReactNode {
  const [agent, setAgent] = useState('')
  const [sort, setSort] = useState<SortKey>('updated')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<{ agent: string; sessionId: string } | null>(null)
  const tick = useDataTick()

  const list = useAsync<SessionInfo[]>(
    () => window.nexa.sessionList({ agent, search, limit: 500 }),
    [agent, search, sort, tick]
  )

  const sorted = useMemo(() => {
    const l = list.data ? [...list.data] : []
    if (sort === 'tokens') {
      l.sort((a, b) => b.inputTokens + b.outputTokens + b.reasoningTokens - (a.inputTokens + a.outputTokens + a.reasoningTokens))
    } else {
      l.sort((a, b) => b.updatedMs - a.updatedMs)
    }
    return l
  }, [list.data, sort])

  const selectedInfo = useMemo(() => sorted.find((s) => selected && s.agentId === selected.agent && s.sessionId === selected.sessionId), [sorted, selected])

  // 命令面板跳转：定位到指定会话
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<{ agent: string; sessionId: string }>).detail
      if (!d) return
      setAgent('')
      setSearch('')
      setSelected({ agent: d.agent, sessionId: d.sessionId })
    }
    window.addEventListener('nexa:open-session', onOpen)
    return () => window.removeEventListener('nexa:open-session', onOpen)
  }, [])

  return (
    <div className="flex h-full gap-4">
      {/* ── 左：会话列表 ── */}
      <div className="flex w-[340px] shrink-0 flex-col 2xl:w-[400px]">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-base font-bold text-ink">会话</h2>
          <span className="text-xs text-faint">{sorted.length} 个</span>
        </div>
        <div className="mb-2 flex gap-2">
          <select className="input w-28" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">全部 Agent</option>
            {Object.entries(AGENTS_META).map(([id, m]) => (
              <option key={id} value={id}>
                {m.name}
              </option>
            ))}
          </select>
          <select className="input w-28" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="updated">最近更新</option>
            <option value="tokens">Token 最多</option>
          </select>
        </div>
        <input className="input mb-2 w-full" placeholder="搜索标题 / 目录 / 模型 / 会话 id…" value={search} onChange={(e) => setSearch(e.target.value)} />

        <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
          {list.loading && !list.data ? (
            <Empty text="" loading />
          ) : sorted.length === 0 ? (
            <Empty text="没有匹配的会话" />
          ) : (
            sorted.map((s) => {
              const on = selected && s.agentId === selected.agent && s.sessionId === selected.sessionId
              const tot = s.inputTokens + s.outputTokens + s.reasoningTokens
              return (
                <button
                  key={s.agentId + s.sessionId}
                  className={`card block w-full px-3.5 py-2.5 text-left transition-all ${
                    on ? 'border-accent/60 shadow-[0_0_0_1px_var(--accent)]' : 'hover:border-line-strong'
                  }`}
                  onClick={() => setSelected({ agent: s.agentId, sessionId: s.sessionId })}
                >
                  <div className="flex items-center gap-2">
                    <AgentTag id={s.agentId} name={agentName(s.agentId)} color={agentColor(s.agentId)} />
                    <span className="ml-auto shrink-0 font-mono text-xs font-semibold text-ink">{fmtNumCn(tot)}</span>
                  </div>
                  <div className="mt-1 truncate text-[13px] font-medium text-ink" title={s.title}>
                    {s.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                    <span className="truncate" title={s.cwd}>
                      {s.cwd.split(/[\\/]/).slice(-2).join('\\')}
                    </span>
                    <span className="ml-auto shrink-0">{relTime(s.updatedMs)}</span>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* ── 右：详情（懒加载四标签） ── */}
      <div className="min-w-0 flex-1">
        {selectedInfo ? (
          <SessionDetail key={selectedInfo.agentId + selectedInfo.sessionId} info={selectedInfo} />
        ) : (
          <Card className="flex h-full items-center justify-center">
            <Empty text="从左侧选择一个会话" />
          </Card>
        )}
      </div>
    </div>
  )
}

// ── 会话详情 ──

function SessionDetail({ info }: { info: SessionInfo }): ReactNode {
  const [tab, setTab] = useState<Tab>('overview')

  return (
    <Card pad={false} className="flex h-full flex-col overflow-hidden">
      {/* 头 */}
      <div className="border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <AgentTag id={info.agentId} name={agentName(info.agentId)} color={agentColor(info.agentId)} />
          <h3 className="truncate text-sm font-semibold text-ink" title={info.title}>
            {info.title}
          </h3>
          <span className="ml-auto shrink-0 text-xs text-faint">{fmtTimeFull(info.updatedMs)}</span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-faint">
          <span className="font-mono">id {shortId(info.sessionId, 14)}</span>
          <span className="truncate" title={info.cwd}>
            {info.cwd}
          </span>
          <CopyBtn text={info.filePath} label="复制路径" />
        </div>
      </div>

      {/* 标签 */}
      <div className="flex gap-1 border-b border-line px-4 py-1.5">
        {(
          [
            ['overview', '概览'],
            ['chat', '对话'],
            ['detail', '明细'],
            ['json', 'JSON']
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t ? 'bg-panel-2 text-ink' : 'text-muted hover:text-soft'
            }`}
            style={tab === t ? { color: 'var(--accent)' } : undefined}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 内容（懒加载：只有切到才挂载对应组件） */}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'overview' && <OverviewTab info={info} />}
        {tab === 'chat' && <ChatTab info={info} />}
        {tab === 'detail' && <DetailTab info={info} />}
        {tab === 'json' && <JsonTab info={info} />}
      </div>
    </Card>
  )
}

// ── 概览：元数据表 + TPS 曲线 ──

function OverviewTab({ info }: { info: SessionInfo }): ReactNode {
  const { theme } = useTheme()
  const dark = theme === 'dark'
  const base = useMemo(() => chartTheme(dark), [dark])
  const records = useAsync<UsageRecord[]>(() => window.nexa.sessionRecords(info.agentId, info.sessionId), [info.agentId, info.sessionId])

  const tpsOpt = useMemo(() => {
    const rs = (records.data ?? []).filter((r) => r.tpsOk)
    if (rs.length === 0) return null
    return {
      ...base,
      xAxis: { ...base.xAxis, type: 'category', data: rs.map((r) => fmtTime(r.timeMs)) },
      yAxis: { ...base.yAxis, type: 'value', name: 't/s' },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 4,
          data: rs.map((r) => ({ value: Number(r.tps.toFixed(1)), itemStyle: { color: speedColor(r.tps) } })),
          lineStyle: { width: 1.6, color: '#818cf8' }
        }
      ],
      tooltip: { ...base.tooltip, trigger: 'axis', valueFormatter: (v: unknown) => fmtTps(Number(v)) }
    } as const
  }, [records.data, base])

  const meta: Array<[string, ReactNode]> = [
    ['Agent', <AgentTag id={info.agentId} name={agentName(info.agentId)} color={agentColor(info.agentId)} />],
    ['会话 id', <span className="font-mono text-xs">{info.sessionId}</span>],
    ['模型', info.model || '—'],
    ['目录', <span className="break-all font-mono text-xs">{info.cwd || '—'}</span>],
    ['上下文窗口', info.contextWindow > 0 ? fmtInt(info.contextWindow) : '—'],
    ['各模型', <span className="font-mono text-xs">{info.originator || '—'}</span>],
    ['响应数', fmtInt(info.responses)],
    ['工具调用', fmtInt(info.toolCalls)],
    ['错误', fmtInt(info.errors)],
    ['缓存命中率', cacheHitText(info)],
    ['文件路径', <span className="break-all font-mono text-[11px]">{info.filePath}</span>]
  ]

  return (
    <div className="grid grid-cols-2 gap-4 p-4">
      <div className="card overflow-hidden">
        <table className="data">
          <tbody>
            {meta.map(([k, v]) => (
              <tr key={k}>
                <td className="w-28 bg-panel-2/40 text-xs font-medium text-muted">{k}</td>
                <td className="text-xs">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card p-4">
        <div className="mb-2 text-sm font-semibold text-ink">逐响应 TPS</div>
        {tpsOpt ? (
          <Chart option={tpsOpt} className="h-64" />
        ) : (
          <Empty text={records.loading ? '' : '没有可测流式响应（或该 agent 为间隔近似口径）'} loading={records.loading} />
        )}
        <div className="mt-2 flex gap-4 text-[11px] text-faint">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#ef4444]" />
            &lt;20 t/s
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#eab308]" />
            20–100
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#22c55e]" />
            &gt;100
          </span>
        </div>
      </div>
    </div>
  )
}

function cacheHitText(info: SessionInfo): string {
  const denom = info.inputTokens + info.cachedTokens + info.cacheWriteTokens
  return denom > 0 ? ((info.cachedTokens / denom) * 100).toFixed(1) + '%' : '—'
}

// ── 对话：完整重放 ──

function ChatTab({ info }: { info: SessionInfo }): ReactNode {
  const msgs = useAsync<ChatMessage[]>(() => window.nexa.sessionMessages(info.agentId, info.sessionId), [info.agentId, info.sessionId])
  const [showAll, setShowAll] = useState(false)

  if (msgs.loading && !msgs.data) return <Empty text="" loading />
  if (msgs.err) return <Empty text={msgs.err} />
  const all = msgs.data ?? []
  if (all.length === 0) return <Empty text="该 agent 暂不支持对话重放" />
  const shown = showAll ? all : all.slice(0, 400)

  return (
    <div className="p-4">
      <div className="space-y-3">
        {shown.map((m, i) => (
          <Msg key={i} m={m} />
        ))}
      </div>
      {!showAll && all.length > 400 && (
        <button className="btn mx-auto mt-4 block" onClick={() => setShowAll(true)}>
          显示全部 {fmtInt(all.length)} 条（当前前 400 条）
        </button>
      )}
    </div>
  )
}

function Msg({ m }: { m: ChatMessage }): ReactNode {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-sm leading-relaxed text-ink">
          <div className="selectable whitespace-pre-wrap break-words">{m.text}</div>
        </div>
      </div>
    )
  }
  if (m.role === 'assistant') {
    return (
      <div className="flex">
        <div className="max-w-[85%]">
          {m.model && <div className="mb-1 text-[11px] text-faint">{m.model}</div>}
          <div
            className={`rounded-2xl rounded-bl-md border px-4 py-2.5 text-sm leading-relaxed ${
              m.isError ? 'border-bad/40 bg-bad/10 text-bad' : 'border-line bg-panel-2 text-ink'
            }`}
          >
            <div className="selectable whitespace-pre-wrap break-words">{m.text}</div>
            {m.isError && <div className="mt-1 text-xs font-medium">✗ API 错误</div>}
          </div>
        </div>
      </div>
    )
  }
  if (m.role === 'reasoning') {
    return (
      <div className="msg-reasoning ml-6 rounded-xl px-4 py-2.5">
        <div className="mb-1 text-[11px] font-medium text-accent">推理</div>
        <div className="selectable whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">{m.text}</div>
      </div>
    )
  }
  if (m.role === 'tool') {
    return (
      <div className="ml-6">
        <div className="mb-1 flex items-center gap-2">
          <span className="chip font-mono text-[11px]">🔧 {m.toolName || 'tool'}</span>
        </div>
        <pre className="mono selectable max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-panel-2 px-3 py-2 text-xs text-soft">
          {m.text}
        </pre>
      </div>
    )
  }
  // tool_output
  return (
    <div className={`ml-10 rounded-xl border px-3 py-2 ${m.isError ? 'border-bad/40 bg-bad/10' : 'border-line/60 bg-panel/60'}`}>
      {m.isError && <div className="mb-1 text-[11px] font-semibold text-bad">✗ 出错</div>}
      <pre className={`mono selectable max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs ${m.isError ? 'text-bad' : 'text-faint'}`}>
        {m.text}
      </pre>
    </div>
  )
}

// ── 明细：逐响应 token 表 ──

function DetailTab({ info }: { info: SessionInfo }): ReactNode {
  const records = useAsync<UsageRecord[]>(() => window.nexa.sessionRecords(info.agentId, info.sessionId), [info.agentId, info.sessionId])
  if (records.loading && !records.data) return <Empty text="" loading />
  const rs = records.data ?? []
  if (rs.length === 0) return <Empty text="无响应记录" />
  return (
    <table className="data">
      <thead>
        <tr>
          <th>时间</th>
          <th>模型</th>
          <th className="num">输入</th>
          <th className="num">缓存读</th>
          <th className="num">缓存写</th>
          <th className="num">输出</th>
          <th className="num">推理</th>
          <th className="num">合计</th>
          <th className="num">时长</th>
          <th className="num">速度</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody>
        {rs.map((r, i) => (
          <tr key={i}>
            <td className="text-faint">{fmtTimeFull(r.timeMs)}</td>
            <td className="max-w-40 truncate text-soft" title={r.model}>
              {r.model || '—'}
              {r.effort && <span className="ml-1 text-faint">({r.effort})</span>}
            </td>
            <td className="num">{fmtInt(r.inputTokens)}</td>
            <td className="num text-faint">{fmtInt(r.cachedTokens)}</td>
            <td className="num text-faint">{fmtInt(r.cacheWriteTokens)}</td>
            <td className="num">{fmtInt(r.outputTokens)}</td>
            <td className="num">{fmtInt(r.reasoningTokens)}</td>
            <td className="num font-medium">{fmtInt(r.inputTokens + r.outputTokens + r.reasoningTokens)}</td>
            <td className="num text-faint">
              {r.durOk ? fmtMs(r.durationMs) : '—'}
              {r.durApprox ? ' ≈' : ''}
            </td>
            <td className="num font-semibold" style={{ color: r.tpsOk ? speedColor(r.tps) : undefined }}>
              {r.tpsOk ? fmtTps(r.tps) : '—'}
            </td>
            <td>{r.error ? <span className="text-xs text-bad">{r.error}</span> : r.source !== 'main' && r.source ? <span className="chip text-[10px]">{r.source}</span> : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── JSON：每条响应的统一原始记录 ──

function JsonTab({ info }: { info: SessionInfo }): ReactNode {
  const records = useAsync<UsageRecord[]>(() => window.nexa.sessionRecords(info.agentId, info.sessionId), [info.agentId, info.sessionId])
  const [sel, setSel] = useState<UsageRecord | null>(null)
  if (records.loading && !records.data) return <Empty text="" loading />
  const rs = records.data ?? []
  if (rs.length === 0) return <Empty text="无响应记录" />
  return (
    <div>
      <table className="data">
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th className="num">合计</th>
            <th className="num">速度</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rs.map((r, i) => (
            <tr key={i} onClick={() => setSel(r)} className="cursor-pointer">
              <td className="text-faint">{fmtTimeFull(r.timeMs)}</td>
              <td className="max-w-48 truncate text-soft">{r.model || '—'}</td>
              <td className="num">{fmtNumCn(r.inputTokens + r.outputTokens + r.reasoningTokens)}</td>
              <td className="num" style={{ color: r.tpsOk ? speedColor(r.tps) : undefined }}>
                {r.tpsOk ? fmtTps(r.tps) : '—'}
              </td>
              <td className="text-faint">›</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Modal open={!!sel} onClose={() => setSel(null)} wide title={sel ? `${agentName(sel.agentId)} · ${sel.model || '—'} · ${fmtTime(sel.timeMs)}` : ''}>
        {sel && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <AgentTag id={sel.agentId} name={agentName(sel.agentId)} color={agentColor(sel.agentId)} />
              <span className="chip">时长 {sel.durOk ? fmtMs(sel.durationMs) : '—'}{sel.durApprox ? ' ≈' : ''}</span>
              <span className="chip">速度 {sel.tpsOk ? fmtTps(sel.tps) : '—'}</span>
              <span className="chip">输入 {fmtInt(sel.inputTokens)}</span>
              <span className="chip">缓存读 {fmtInt(sel.cachedTokens)}</span>
              <span className="chip">缓存写 {fmtInt(sel.cacheWriteTokens)}</span>
              <span className="chip">输出 {fmtInt(sel.outputTokens)}</span>
              <span className="chip">推理 {fmtInt(sel.reasoningTokens)}</span>
              {sel.error && <span className="chip text-bad">{sel.error}</span>}
            </div>
            <div className="card max-h-[50vh] overflow-auto p-3">
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
