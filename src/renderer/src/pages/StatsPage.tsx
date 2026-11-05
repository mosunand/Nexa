// pages/StatsPage.tsx — ◎ 使用统计：累计口径的"总账"，数据来自程序自有的
// 二进制归档 —— 即使删掉 agent 原始数据，这里的历史依然保留。
// 5 张统计卡 + 一年热力图（日/周/累计三档）+ 每日多线趋势 + 模型环形图 +
// 按 agent 分布表；右上角全局筛选（agent + 模型大类）作用于整页。

import { useMemo, useState, type ReactNode } from 'react'
import type { AgentTotal, DailyTotal, ModelDayPoint } from '@shared/types'
import { useAsync, useDataTick } from '../lib/data'
import { agentColor, agentName, familyColor, modelColor } from '../lib/colors'
import { Chart, chartTheme } from '../components/Chart'
import { Heatmap } from '../components/Heatmap'
import { AgentTag, Card, CardTitle, Empty, GradientNum, KpiCard, RatioBar } from '../components/ui'
import { fmtDayTick, fmtDur, fmtInt, fmtNumCn } from '../lib/format'
import { useTheme } from '../lib/theme'

export function StatsPage(): ReactNode {
  const [agent, setAgent] = useState('')
  const [family, setFamily] = useState('')
  const [trendRange, setTrendRange] = useState<7 | 30>(30)
  const [heatMode, setHeatMode] = useState<'day' | 'week' | 'cum'>('day')
  const tick = useDataTick()
  const { theme } = useTheme()
  const dark = theme === 'dark'
  const base = useMemo(() => chartTheme(dark), [dark])

  const f = { agent, family }
  const totals = useAsync<DailyTotal[]>(() => window.nexa.dailyTotals(f), [agent, family, tick])
  const agents = useAsync<string[]>(() => window.nexa.archiveAgentIds(), [tick])
  const families = useAsync<Array<{ key: string; display: string }>>(() => window.nexa.archiveModelFamilies() as never, [tick])
  const agentTotalsQ = useAsync<AgentTotal[]>(() => window.nexa.agentTotals(f), [agent, family, tick])
  const longest = useAsync<number>(() => window.nexa.longestSessionActiveMs(f), [agent, family, tick])
  const trend = useAsync<ModelDayPoint[]>(() => window.nexa.dailyTokensByModel(Date.now() - trendRange * 86_400_000, 5, f), [agent, family, trendRange, tick])
  // 环形图窗口跟随热力图的 每日/每周/累计 档位：今日 / 近 7 天 / 全部累计
  const donutSince = heatMode === 'day' ? localMidnight() : heatMode === 'week' ? Date.now() - 7 * 86_400_000 : 0
  const donutLabel = heatMode === 'day' ? '今日' : heatMode === 'week' ? '近 7 天' : '累计'
  const donut = useAsync<ModelDayPoint[]>(() => window.nexa.dailyTokensByModel(donutSince, 8, f), [agent, family, donutSince, tick])
  // 按模型累加（逐天点 → 总量），Top 5 + 其他
  const donutAgg = new Map<string, number>()
  for (const p of donut.data ?? []) {
    donutAgg.set(p.model, (donutAgg.get(p.model) ?? 0) + p.genTok)
  }
  const donutSorted = [...donutAgg.entries()].sort((a, b) => b[1] - a[1])
  const donutTop5 = donutSorted.slice(0, 5)
  const otherTok = donutSorted.slice(5).reduce((s, [, v]) => s + v, 0)
  const donutItems: Array<[string, number]> =
    otherTok > 0 ? [...donutTop5, ['其他', otherTok] as [string, number]] : donutTop5
  const donutTotal = donutSorted.reduce((s, [, v]) => s + v, 0)

  const daily = totals.data ?? []

  // ── 统计卡口径 ──
  const cumulative = daily.reduce((s, d) => s + d.tokens, 0)
  const peak = daily.reduce((m, d) => Math.max(m, d.tokens), 0)
  const streaks = useMemo(() => {
    // 连续天数（本地日历天连续）
    const days = new Set(daily.filter((d) => d.tokens > 0).map((d) => d.dayMs))
    let cur = 0
    let best = 0
    let day = localMidnight()
    // 当前连续：从今天往回（今天没数据不算断，从昨天起算）
    if (!days.has(day)) day -= 86_400_000
    while (days.has(day)) {
      cur++
      day -= 86_400_000
    }
    // 最长连续：扫描排序后的活跃日
    const sorted = [...days].sort((a, b) => a - b)
    let run = 0
    let prev = 0
    for (const d of sorted) {
      run = prev && d - prev === 86_400_000 ? run + 1 : 1
      best = Math.max(best, run)
      prev = d
    }
    return { cur, best }
  }, [daily])

  // ── 趋势图（日历天补零） ──
  const trendOpt = useMemo(() => {
    const pts = trend.data ?? []
    if (pts.length === 0) return null
    // 按 model 分线；日历天补零
    const models = [...new Set(pts.map((p) => p.model))]
    const dayStart = localMidnight() - (trendRange - 1) * 86_400_000
    const allDays: number[] = []
    for (let i = 0; i < trendRange; i++) allDays.push(dayStart + i * 86_400_000)
    const byModelDay = new Map<string, Map<number, number>>()
    for (const p of pts) {
      const m = byModelDay.get(p.model) ?? new Map<number, number>()
      m.set(p.dayMs, (m.get(p.dayMs) ?? 0) + p.genTok)
      byModelDay.set(p.model, m)
    }
    return {
      ...base,
      xAxis: { ...base.xAxis, type: 'category', data: allDays.map((d) => fmtDayTick(d)) },
      yAxis: { ...base.yAxis, type: 'value' },
      legend: { show: true, top: 0, right: 0, textStyle: { color: dark ? '#9aa3b5' : '#5b6472', fontSize: 11 }, itemWidth: 14 },
      series: models.map((m, i) => ({
        name: m,
        type: 'line' as const,
        smooth: true,
        symbol: 'none',
        stack: 'total',
        areaStyle: { opacity: 0.12 },
        lineStyle: { width: 1.6, color: modelColor(m, i) },
        itemStyle: { color: modelColor(m, i) },
        data: allDays.map((d) => byModelDay.get(m)?.get(d) ?? 0)
      })),
      tooltip: { ...base.tooltip, trigger: 'axis' }
    } as const
  }, [trend.data, base, dark, trendRange])

  // ── 环形图（Top 5 + 其他，与图例同源） ──
  const donutOpt = useMemo(() => {
    if (donutItems.length === 0) return null
    return {
      ...base,
      tooltip: { ...base.tooltip, trigger: 'item', formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/>${fmtNumCn(p.value ?? 0)} tokens · ${p.percent}%` },
      legend: { show: false },
      series: [
        {
          type: 'pie',
          radius: ['62%', '88%'],
          center: ['50%', '52%'],
          avoidLabelOverlap: true,
          // ZCode 同款：直角扇区，仅 1px 底色缝
          itemStyle: { borderRadius: 0, borderColor: dark ? '#12161f' : '#ffffff', borderWidth: 1 },
          label: { show: false },
          emphasis: { label: { show: false }, scaleSize: 5 },
          animationType: 'scale',
          animationEasing: 'elasticOut',
          data: donutItems.map(([m, v], i) => ({
            name: m,
            value: v,
            itemStyle: { color: m === '其他' ? 'var(--faint)' : modelColor(m, i) }
          }))
        }
      ]
    } as const
  }, [donutItems, base, dark])

  const loading = totals.loading && !totals.data
  if (loading) return <Empty text="" loading />
  if (totals.err) return <Empty text={totals.err} />

  const at = agentTotalsQ.data ?? []
  const atTotal = at.reduce((s, a) => s + a.inTok + a.outTok + a.reasonTok, 0)

  return (
    <div className="space-y-4">
      {/* 标题 + 全局筛选 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-ink">使用统计</h2>
          <span className="text-xs text-faint">累计口径 · 自有归档 · 删除源数据后历史保留</span>
        </div>
        <div className="flex items-center gap-2">
          <select className="input w-32" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">全部 Agent</option>
            {(agents.data ?? []).map((a) => (
              <option key={a} value={a}>
                {agentName(a)}
              </option>
            ))}
          </select>
          <select className="input w-32" value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="">全部模型大类</option>
            {(families.data ?? []).map((fm) => (
              <option key={fm.key} value={fm.key}>
                {fm.display}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 5 张统计卡 */}
      <div className="grid grid-cols-5 gap-3">
        <KpiCard
          label="累计 Token"
          value={<GradientNum>{fmtNumCn(cumulative)}</GradientNum>}
          accentTop
          large
          title={fmtInt(cumulative) + ' tokens'}
        />
        <KpiCard label="峰值 Token（单日）" value={fmtNumCn(peak)} sub={peak > 0 ? fmtInt(peak) : '—'} />
        <KpiCard label="最长聊天时长" value={longest.data !== undefined && longest.data > 0 ? fmtDur(longest.data / 1000) : '—'} sub="最活跃单会话" />
        <KpiCard label="当前连续天数" value={streaks.cur + ' 天'} sub="今天没数据从昨天起算" />
        <KpiCard label="最长连续天数" value={streaks.best + ' 天'} />
      </div>

      {/* 热力图 —— 头部版式 1:1 抄 ZCode 用量面板：标题 / 大数字统计 / 琥珀切换钮 */}
      <Card>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div className="pb-0.5">
              <div className="text-sm font-semibold text-ink">Token 活动 · 近一年</div>
            </div>
            <div>
              <div className="text-[11px] leading-4 text-faint">最长连续天数</div>
              <div className="text-2xl font-bold leading-7 text-ink">
                {streaks.best}
                <span className="ml-1 text-sm font-semibold text-muted">天</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] leading-4 text-faint">当前连续天数</div>
              <div className="text-2xl font-bold leading-7 text-ink">
                {streaks.cur}
                <span className="ml-1 text-sm font-semibold text-muted">天</span>
              </div>
            </div>
          </div>
          <div className="seg seg-amber">
            {(
              [
                ['day', '每日'],
                ['week', '每周'],
                ['cum', '累计']
              ] as const
            ).map(([m, label]) => (
              <button key={m} className={heatMode === m ? 'on' : ''} onClick={() => setHeatMode(m)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <Heatmap data={daily} mode={heatMode} />
      </Card>

      <div className="grid grid-cols-5 gap-4">
        {/* 每日趋势 */}
        <Card className="col-span-3 h-80">
          <CardTitle
            right={
              <div className="seg">
                <button className={trendRange === 7 ? 'on' : ''} onClick={() => setTrendRange(7)}>
                  近 7 日
                </button>
                <button className={trendRange === 30 ? 'on' : ''} onClick={() => setTrendRange(30)}>
                  近 30 日
                </button>
              </div>
            }
          >
            每日 Token 趋势（按模型 · Top 5 · 日历天补零）
          </CardTitle>
          {trendOpt ? <Chart option={trendOpt} className="h-60" /> : <Empty text="范围内暂无数据" />}
        </Card>

        {/* 模型用量环形图（窗口跟随热力图档位，Top 5 + 其他） */}
        <Card className="col-span-2 h-80 overflow-hidden">
          <CardTitle>模型用量分布（{donutLabel} · Top 5 + 其他）</CardTitle>
          {donutOpt ? (
            <div className="flex h-60 items-center gap-4">
              <div className="relative h-60 flex-1">
                <Chart option={donutOpt} className="h-60" />
                {/* 中心总量（ZCode 同款） */}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <div className="text-xl font-bold text-ink">{fmtNumCn(donutTotal)}</div>
                  <div className="text-[11px] text-faint">tokens</div>
                </div>
              </div>
              <div className="w-52 overflow-hidden pr-1">
                {donutItems.map(([m, v], i) => (
                  <div key={m} className="border-b border-line/60 py-1 first:pt-0 last:border-b-0">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: m === '其他' ? 'var(--faint)' : modelColor(m, i) }}
                      />
                      <span className="truncate text-soft" title={m}>
                        {m}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-faint">
                        {donutTotal > 0 ? ((v / donutTotal) * 100).toFixed(0) + '%' : ''}
                      </span>
                    </div>
                    <div className="pl-3.5 text-[11px] leading-4 text-faint">{fmtNumCn(v)} tokens</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Empty text={`${donutLabel}暂无数据`} />
          )}
        </Card>
      </div>

      {/* 按 agent 分布 */}
      <Card pad={false} className="overflow-x-auto">
        <div className="px-5 pt-4">
          <CardTitle>按 Agent 分布（累计）</CardTitle>
        </div>
        {at.length === 0 ? (
          <div className="pb-6">
            <Empty text="归档中暂无记录 —— 装好 agent 跑一次就有" />
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="num">请求数</th>
                <th className="num">输入</th>
                <th className="num">输出</th>
                <th className="num">推理</th>
                <th className="num">合计</th>
                <th className="w-40">占比</th>
              </tr>
            </thead>
            <tbody>
              {at.map((a) => {
                const tot = a.inTok + a.outTok + a.reasonTok
                return (
                  <tr key={a.agent}>
                    <td>
                      <AgentTag id={a.agent} name={agentName(a.agent)} color={agentColor(a.agent)} />
                    </td>
                    <td className="num">{fmtInt(a.requests)}</td>
                    <td className="num">{fmtNumCn(a.inTok)}</td>
                    <td className="num">{fmtNumCn(a.outTok)}</td>
                    <td className="num">{fmtNumCn(a.reasonTok)}</td>
                    <td className="num font-medium">{fmtNumCn(tot)}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <RatioBar ratio={tot} total={Math.max(1, atTotal)} color={agentColor(a.agent)} />
                        <span className="w-11 shrink-0 text-right font-mono text-[11px] text-faint">
                          {atTotal > 0 ? ((tot / atTotal) * 100).toFixed(1) + '%' : ''}
                        </span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function localMidnight(now = Date.now()): number {
  const tz = -new Date(now).getTimezoneOffset() * 60_000
  return Math.floor((now + tz) / 86_400_000) * 86_400_000 - tz
}
