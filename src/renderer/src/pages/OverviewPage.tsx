// pages/OverviewPage.tsx — ◉ 实时监控（主仪表盘）。
// 对应老项目 OverviewPage：窗口选择（今天/24h/7d/30d/全部）+ 双 token 大卡
// + 9 张 KPI 卡 + 3 张图表（请求柱状 / token 三线 / 速度折线逐点着色）+
// 最近请求速度表（按模型大类筛选）+ 实时活动流 + 按模型/agent/工具三张表。

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { OverviewData, SpeedRow, TimeWindow, UsageRecord } from '@shared/types'
import { useAsync, useDataTick, useNexaEvent } from '../lib/data'
import { agentColor, agentName, modelColor } from '../lib/colors'
import { Chart, chartTheme } from '../components/Chart'
import { AgentTag, Badge, Card, CardTitle, Empty, GradientNum, KpiCard, RatioBar } from '../components/ui'
import {
  fmtDur,
  fmtInt,
  fmtMs,
  fmtNumCn,
  fmtTime,
  fmtTimeFull,
  fmtTimeTick,
  fmtTps,
  relTime,
  speedColor
} from '../lib/format'
import { useTheme } from '../lib/theme'

const WINDOWS: Array<{ id: TimeWindow; label: string }> = [
  { id: 'today', label: '今天' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: '全部' }
]

export function OverviewPage(): ReactNode {
  const [win, setWin] = useState<TimeWindow>('24h')
  const [family, setFamily] = useState('')
  const tick = useDataTick()
  const { theme } = useTheme()
  const dark = theme === 'dark'

  const data = useAsync<OverviewData>(() => window.nexa.overview(win), [win, tick])
  const families = useAsync<Array<{ key: string; display: string }>>(() => window.nexa.archiveModelFamilies() as never, [tick])

  // 实时活动流：新响应 2 秒内推入，保留最近 60 条
  const [feed, setFeed] = useState<UsageRecord[]>([])
  useNexaEvent('newRecords', (records) => {
    setFeed((prev) => [...records, ...prev].slice(0, 60))
  })

  const k = data.data
  const families2 = useMemo(() => families.data ?? [], [families.data])

  // ── 图表 options ──
  const base = useMemo(() => chartTheme(dark), [dark])

  const requestsOpt = useMemo(() => {
    if (!k) return null
    return {
      ...base,
      xAxis: { ...base.xAxis, type: 'category', data: k.series.map((p) => fmtTimeTick(p.bucketMs)) },
      yAxis: { ...base.yAxis, type: 'value' },
      series: [
        {
          type: 'bar',
          name: '模型请求',
          data: k.series.map((p) => p.requests),
          barMaxWidth: 18,
          itemStyle: { borderRadius: [4, 4, 0, 0], color: '#818cf8' }
        }
      ],
      tooltip: { ...base.tooltip, trigger: 'axis' }
    } as const
  }, [k, base])

  const tokensOpt = useMemo(() => {
    if (!k) return null
    const mk = (field: 'input' | 'output' | 'reasoning', name: string, color: string) => ({
      name,
      type: 'line' as const,
      smooth: true,
      symbol: 'none',
      lineStyle: { width: 2, color },
      itemStyle: { color },
      areaStyle: { opacity: 0.06, color },
      data: k.series.map((p) => p[field])
    })
    return {
      ...base,
      xAxis: { ...base.xAxis, type: 'category', data: k.series.map((p) => fmtTimeTick(p.bucketMs)) },
      yAxis: { ...base.yAxis, type: 'value' },
      legend: { show: true, top: 0, right: 0, textStyle: { color: dark ? '#9aa3b5' : '#5b6472', fontSize: 11 }, itemWidth: 14 },
      series: [mk('input', '输入', '#38bdf8'), mk('output', '输出', '#34d399'), mk('reasoning', '推理', '#c084fc')],
      tooltip: { ...base.tooltip, trigger: 'axis' }
    } as const
  }, [k, base, dark])

  const speedOpt = useMemo(() => {
    if (!k) return null
    const pts = k.recentSpeed.filter((r) => r.tpsOk).slice().reverse()
    return {
      ...base,
      xAxis: { ...base.xAxis, type: 'category', data: pts.map((r) => fmtTimeTick(r.timeMs)) },
      yAxis: { ...base.yAxis, type: 'value', name: 't/s', nameTextStyle: { color: dark ? '#9aa3b5' : '#5b6472' } },
      visualMap: {
        show: false,
        dimension: 1,
        pieces: [
          { max: 20, color: '#ef4444' },
          { min: 20, max: 100, color: '#eab308' },
          { min: 100, color: '#22c55e' }
        ]
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          connectNulls: true,
          data: pts.map((r) => Number(r.tps.toFixed(1))),
          lineStyle: { width: 2 },
          markLine: pts.length
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: '#818cf8', type: 'dashed', width: 1 },
                label: { formatter: '加权 {c}', fontSize: 10, color: dark ? '#9aa3b5' : '#5b6472' },
                data: [{ yAxis: k.kpis.weightedTps }]
              }
            : undefined
        }
      ],
      tooltip: { ...base.tooltip, trigger: 'axis', valueFormatter: (v: unknown) => fmtTps(Number(v)) }
    } as const
  }, [k, base, dark])

  if (data.loading && !k) return <Empty text="" loading />
  if (data.err) return <Empty text={data.err} />
  if (!k) return null

  const todayK = k.todayKpis
  const winK = k.kpis
  const genToday = todayK.outTok + todayK.reasonTok
  const todayTop = k.todayByModel.slice(0, 5)
  const genTotal = winK.outTok + winK.reasonTok
  const totalTok = winK.inTok + winK.outTok + winK.reasonTok
  const cacheTotal = winK.cacheRead + winK.cacheWrite
  const cacheHit = winK.inTok + cacheTotal > 0 ? winK.cacheRead / (winK.inTok + cacheTotal) : 0
  const reasonRatio = totalTok > 0 ? winK.reasonTok / totalTok : 0
  const errRate = winK.requests > 0 ? winK.errors / winK.requests : 0

  const byAgentTotal = k.byAgent.reduce((s, a) => s + a.inTok + a.outTok + a.reasonTok, 0)
  const modelTotal = k.byModel.reduce((s, m) => s + m.inTok + m.outTok + m.reasonTok, 0)

  return (
    <div className="space-y-4">
      {/* ── 标题行：窗口选择 ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-ink">实时监控</h2>
          <span className="text-xs text-faint">{k.window === 'all' ? '全部时间' : `自 ${fmtTimeFull(k.sinceMs)}`}</span>
        </div>
        <div className="seg">
          {WINDOWS.map((w) => (
            <button key={w.id} className={win === w.id ? 'on' : ''} onClick={() => setWin(w.id)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 双 token 大卡 ── */}
      <div className="grid grid-cols-2 gap-4">
        <KpiCard
          label="总 Token（今日）"
          value={<GradientNum>{fmtNumCn(todayK.inTok + todayK.outTok + todayK.reasonTok)}</GradientNum>}
          accentTop
          large
          sub={
            <span>
              生成 <span className="font-medium text-ink">{fmtNumCn(genToday)}</span>
              {todayK.inTok + todayK.outTok + todayK.reasonTok > 0 && (
                <span className="text-faint">
                  {' '}
                  · 占比 {((genToday / (todayK.inTok + todayK.outTok + todayK.reasonTok)) * 100).toFixed(1)}%
                </span>
              )}
            </span>
          }
          bar={
            todayK.inTok + todayK.outTok + todayK.reasonTok > 0
              ? { ratio: genToday / (todayK.inTok + todayK.outTok + todayK.reasonTok) }
              : undefined
          }
        >
          {todayTop.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {todayTop.map((m, i) => {
                const tot = m.inTok + m.outTok + m.reasonTok
                return (
                  <div key={m.agentId + m.model + m.effort} className="flex items-center gap-2 text-xs">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: modelColor(m.model, i) }} />
                    <span className="truncate font-medium text-soft" title={m.model}>
                      {m.model}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-faint">{fmtNumCn(tot)}</span>
                    <span className="w-10 shrink-0 text-right text-faint">
                      {todayK.inTok + todayK.outTok + todayK.reasonTok > 0
                        ? ((tot / (todayK.inTok + todayK.outTok + todayK.reasonTok)) * 100).toFixed(0) + '%'
                        : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </KpiCard>

        <KpiCard
          label={`总 Token（${WINDOWS.find((w) => w.id === win)?.label}）`}
          value={<GradientNum>{fmtNumCn(totalTok)}</GradientNum>}
          large
          sub={
            <span>
              输入 {fmtNumCn(winK.inTok)} · 输出 {fmtNumCn(winK.outTok)} · 推理 {fmtNumCn(winK.reasonTok)}
              <span className="text-faint"> · 缓存读写 {fmtNumCn(cacheTotal)}</span>
            </span>
          }
        >
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            {[
              ['输入', winK.inTok, '#38bdf8'],
              ['输出', winK.outTok, '#34d399'],
              ['推理', winK.reasonTok, '#c084fc']
            ].map(([name, v, c]) => (
              <div key={String(name)}>
                <div className="mb-1 flex justify-between">
                  <span className="text-muted">{String(name)}</span>
                  <span className="font-mono text-faint">
                    {totalTok > 0 ? ((Number(v) / totalTok) * 100).toFixed(0) + '%' : ''}
                  </span>
                </div>
                <RatioBar ratio={Number(v)} total={Math.max(1, totalTok)} color={String(c)} />
              </div>
            ))}
          </div>
        </KpiCard>
      </div>

      {/* ── 9 张 KPI 卡（末行三张跨双列，行不缺角） ── */}
      <div className="grid grid-cols-6 gap-3">
        <KpiCard label="模型请求" value={fmtInt(winK.requests)} sub={`${fmtInt(winK.sessions)} 个会话`} />
        <KpiCard
          label="平均流式时长"
          value={winK.avgDurOk ? fmtMs(winK.avgDurMs) : '—'}
          sub={winK.avgDurOk ? 'dur_ok 样本均值' : '无可测样本'}
        />
        <KpiCard
          label="输入"
          value={fmtNumCn(winK.inTok)}
          bar={{ ratio: cacheHit, color: '#38bdf8' }}
          sub={`缓存命中 ${(cacheHit * 100).toFixed(1)}%`}
        />
        <KpiCard label="输出" value={fmtNumCn(winK.outTok)} sub={`生成合计 ${fmtNumCn(genTotal)}`} />
        <KpiCard
          label="推理占比"
          value={(reasonRatio * 100).toFixed(1) + '%'}
          bar={{ ratio: reasonRatio, color: '#c084fc' }}
          sub={fmtNumCn(winK.reasonTok) + ' tokens'}
        />
        <KpiCard
          label="缓存命中率"
          value={(cacheHit * 100).toFixed(1) + '%'}
          bar={{ ratio: cacheHit, color: '#22d3ee' }}
          sub={`读 ${fmtNumCn(winK.cacheRead)} / 写 ${fmtNumCn(winK.cacheWrite)}`}
        />
        <KpiCard className="col-span-2" label="活跃会话" value={fmtInt(winK.sessions)} sub="窗口内出现过响应" />
        <KpiCard
          className="col-span-2"
          label="错误 · 中止率"
          value={(errRate * 100).toFixed(1) + '%'}
          sub={`${fmtInt(winK.errors)} / ${fmtInt(winK.requests)}`}
          bar={{ ratio: errRate, color: errRate > 0.05 ? 'var(--bad)' : 'var(--ok)' }}
        />
        <KpiCard
          className="col-span-2"
          label="平均 Token 速度（加权）"
          value={fmtTps(winK.weightedTps)}
          sub={`Σtoken ÷ Σ秒 · ${fmtInt(winK.tpsSamples)} 个可测样本`}
        />
      </div>

      {/* ── 3 张图表 ── */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="h-64">
          <CardTitle>模型请求</CardTitle>
          {requestsOpt ? <Chart option={requestsOpt} className="h-48" /> : <Empty text="暂无数据" />}
        </Card>
        <Card className="h-64">
          <CardTitle>Token 构成</CardTitle>
          {tokensOpt ? <Chart option={tokensOpt} className="h-48" /> : <Empty text="暂无数据" />}
        </Card>
        <Card className="h-64">
          <CardTitle right={<Badge tone="accent">阈值着色</Badge>}>Token 速度</CardTitle>
          {speedOpt ? <Chart option={speedOpt} className="h-48" /> : <Empty text="暂无可测响应" />}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* ── 最近请求速度表 ── */}
        <Card pad={false} className="overflow-hidden">
          <div className="flex items-center justify-between px-5 pt-4">
            <CardTitle>最近请求速度</CardTitle>
            <div className="seg mb-3">
              <button className={family === '' ? 'on' : ''} onClick={() => setFamily('')}>
                全部模型
              </button>
              {families2.map((f) => (
                <button key={f.key} className={family === f.key ? 'on' : ''} onClick={() => setFamily(f.key)}>
                  {f.display}
                </button>
              ))}
            </div>
          </div>
          <SpeedTable win={win} family={family} />
        </Card>

        {/* ── 实时活动流 ── */}
        <Card pad={false} className="overflow-hidden">
          <div className="px-5 pt-4">
            <CardTitle
              right={
                feed.length > 0 ? (
                  <span className="flex items-center gap-1.5 text-xs text-ok">
                    <span className="pulse-dot" /> 实时
                  </span>
                ) : undefined
              }
            >
              实时活动流
            </CardTitle>
          </div>
          <div className="h-[336px] overflow-auto">
            {feed.length === 0 ? (
              <Empty text="等待新的模型响应…（2 秒轮询）" />
            ) : (
              <table className="data">
                <tbody>
                  {feed.map((r, i) => (
                    <tr key={r.agentId + r.sessionId + r.timeMs + i} className={i === 0 ? 'flash-row' : ''}>
                      <td className="w-24">
                        <AgentTag id={r.agentId} name={agentName(r.agentId)} color={agentColor(r.agentId)} />
                      </td>
                      <td className="max-w-40 truncate text-soft" title={r.model}>
                        {r.model || '—'}
                      </td>
                      <td className="num">{fmtInt(r.outputTokens + r.reasoningTokens)} tok</td>
                      <td className="num" style={{ color: r.tpsOk ? speedColor(r.tps) : undefined }}>
                        {r.tpsOk ? fmtTps(r.tps) : '—'}
                      </td>
                      <td className="num text-faint">{fmtTime(r.timeMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>

      {/* ── 算力分布三张表 ── */}
      <div className="grid grid-cols-3 gap-4">
        {/* 按模型 */}
        <Card pad={false} className="overflow-hidden">
          <div className="px-5 pt-4">
            <CardTitle>按模型（前 12）</CardTitle>
          </div>
          <div className="max-h-72 overflow-auto">
            {k.byModel.length === 0 ? (
              <Empty text="窗口内暂无请求" />
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th className="num">请求</th>
                    <th className="num">Token</th>
                    <th className="num">速度</th>
                  </tr>
                </thead>
                <tbody>
                  {k.byModel.map((m) => (
                    <tr key={m.agentId + m.model + m.effort}>
                      <td className="max-w-36 truncate" title={`${agentName(m.agentId)} · ${m.model}${m.effort ? ` (${m.effort})` : ''}`}>
                        <AgentTag id={m.agentId} name={m.model || '—'} color={agentColor(m.agentId)} size={6} />
                      </td>
                      <td className="num">{fmtInt(m.requests)}</td>
                      <td className="num">{fmtNumCn(m.inTok + m.outTok + m.reasonTok)}</td>
                      <td className="num" style={{ color: m.tpsOk ? speedColor(m.weightedTps) : undefined }}>
                        {m.tpsOk ? fmtTps(m.weightedTps) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        {/* 按 agent */}
        <Card pad={false} className="overflow-hidden">
          <div className="px-5 pt-4">
            <CardTitle>按 Agent</CardTitle>
          </div>
          <div className="max-h-72 overflow-auto">
            {k.byAgent.length === 0 ? (
              <Empty text="窗口内暂无请求" />
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th className="num">请求</th>
                    <th className="num">Token</th>
                    <th className="w-24">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {k.byAgent.map((a) => (
                    <tr key={a.agentId}>
                      <td>
                        <AgentTag id={a.agentId} name={agentName(a.agentId)} color={agentColor(a.agentId)} />
                      </td>
                      <td className="num">{fmtInt(a.requests)}</td>
                      <td className="num">{fmtNumCn(a.inTok + a.outTok + a.reasonTok)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <RatioBar
                            ratio={a.inTok + a.outTok + a.reasonTok}
                            total={Math.max(1, byAgentTotal)}
                            color={agentColor(a.agentId)}
                          />
                          <span className="w-10 shrink-0 text-right font-mono text-[11px] text-faint">
                            {byAgentTotal > 0 ? ((a.inTok / Math.max(1, byAgentTotal)) * 100).toFixed(0) + '%' : ''}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        {/* 按工具 */}
        <Card pad={false} className="overflow-hidden">
          <div className="px-5 pt-4">
            <CardTitle right={<Badge>按工具自身时间过滤</Badge>}>按工具（前 30）</CardTitle>
          </div>
          <div className="max-h-72 overflow-auto">
            {k.byTool.length === 0 ? (
              <Empty text="窗口内暂无工具调用" />
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>工具</th>
                    <th className="num">调用</th>
                    <th className="num">会话</th>
                  </tr>
                </thead>
                <tbody>
                  {k.byTool.map((t) => (
                    <tr key={t.agentId + t.toolName}>
                      <td className="max-w-44 truncate font-mono text-xs" title={`${agentName(t.agentId)} · ${t.toolName}`}>
                        <AgentTag id={t.agentId} name={t.toolName} color={agentColor(t.agentId)} size={6} />
                      </td>
                      <td className="num">{fmtInt(t.calls)}</td>
                      <td className="num">{fmtInt(t.sessions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>

      <div className="pb-2 text-center text-[11px] text-faint">
        窗口内模型用量合计 {fmtNumCn(modelTotal)} tokens · 轮询 2s · 全程只读离线 ·{' '}
        <span className="font-mono">v{__APP_VERSION__}</span>
      </div>
    </div>
  )
}

// ── 速度表（独立组件：大类筛选时重新查询） ──

function SpeedTable({ win, family }: { win: TimeWindow; family: string }): ReactNode {
  const tick = useDataTick()
  const [since, setSince] = useState(0)
  useEffect(() => {
    // 与窗口联动：窗口变化时重新计算 since
    const now = Date.now()
    setSince(win === 'today' ? new Date().setHours(0, 0, 0, 0) : win === '24h' ? now - 86400000 : win === '7d' ? now - 7 * 86400000 : win === '30d' ? now - 30 * 86400000 : 0)
  }, [win])

  const rows = useAsync<SpeedRow[]>(() => window.nexa.recentSpeed(since, family, 60), [since, family, tick])

  if (rows.loading && !rows.data) return <Empty text="" loading />
  const list = rows.data ?? []
  if (list.length === 0) return <Empty text="窗口内没有可测的流式响应" />

  // 页脚汇总加权均速
  const gen = list.reduce((s, r) => s + r.output + r.reasoning, 0)
  const dur = list.reduce((s, r) => s + r.durationMs, 0)
  const weighted = dur > 0 ? gen / (dur / 1000) : 0

  return (
    <div className="h-[336px] overflow-auto">
      <table className="data">
        <thead>
          <tr>
            <th>时间</th>
            <th>Agent</th>
            <th>模型</th>
            <th className="num">生成</th>
            <th className="num">时长</th>
            <th className="num">速度</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r, i) => (
            <tr key={r.agentId + r.sessionId + r.timeMs + '-' + i}>
              <td className="text-faint">{fmtTime(r.timeMs)}</td>
              <td>
                <AgentTag id={r.agentId} name={agentName(r.agentId)} color={agentColor(r.agentId)} size={6} />
              </td>
              <td className="max-w-40 truncate text-soft" title={r.model}>
                {r.model || '—'}
              </td>
              <td className="num">{fmtInt(r.output + r.reasoning)}</td>
              <td className="num text-faint">
                {fmtDur(r.durationMs / 1000)}
              </td>
              <td className="num font-semibold" style={{ color: speedColor(r.tps) }}>
                {fmtTps(r.tps)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6} className="border-t border-line-strong px-3 py-2 text-right text-xs text-muted">
              加权均速
              <span className="ml-2 font-mono font-semibold" style={{ color: speedColor(weighted) }}>
                {fmtTps(weighted)}
              </span>
              <span className="ml-2 text-faint">（Σtoken ÷ Σ秒 · 最近 {relTime(list[list.length - 1]?.timeMs ?? 0)}~）</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
