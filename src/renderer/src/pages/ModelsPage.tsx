// pages/ModelsPage.tsx — ◇ 模型用量：按模型（含 effort 变体）聚合的全量视图：
// 每日生成 token 趋势（Top 5）+ 汇总表（token 列带比例条）。

import { useMemo, useState, type ReactNode } from 'react'
import type { ModelBreakdown, ModelDayPoint } from '@shared/types'
import { useAsync, useDataTick } from '../lib/data'
import { exportCsv } from '../lib/csv'
import { agentColor, agentName, modelColor } from '../lib/colors'
import { Chart, chartTheme } from '../components/Chart'
import { Card, CardTitle, Empty, RatioBar } from '../components/ui'
import { fmtDayTick, fmtInt, fmtMs, fmtNumCn, fmtTps, relTime, speedColor } from '../lib/format'
import { useTheme } from '../lib/theme'

export function ModelsPage(): ReactNode {
  const tick = useDataTick()
  const { theme } = useTheme()
  const dark = theme === 'dark'
  const base = useMemo(() => chartTheme(dark), [dark])

  const breakdown = useAsync<ModelBreakdown[]>(() => window.nexa.modelBreakdown(0), [tick])
  const daily = useAsync<ModelDayPoint[]>(() => window.nexa.modelDailySeries(0, 5), [tick])

  const trendOpt = useMemo(() => {
    const pts = daily.data ?? []
    if (pts.length === 0) return null
    const models = [...new Set(pts.map((p) => p.model))]
    const days = [...new Set(pts.map((p) => p.dayMs))].sort((a, b) => a - b)
    const byModelDay = new Map<string, Map<number, number>>()
    for (const p of pts) {
      const m = byModelDay.get(p.model) ?? new Map<number, number>()
      m.set(p.dayMs, (m.get(p.dayMs) ?? 0) + p.genTok)
      byModelDay.set(p.model, m)
    }
    return {
      ...base,
      xAxis: { ...base.xAxis, type: 'category', data: days.map((d) => fmtDayTick(d)) },
      yAxis: { ...base.yAxis, type: 'value' },
      legend: { show: true, top: 0, right: 0, textStyle: { color: dark ? '#9aa3b5' : '#5b6472', fontSize: 11 }, itemWidth: 14 },
      series: models.map((m, i) => ({
        name: m,
        type: 'line' as const,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2, color: modelColor(m, i) },
        itemStyle: { color: modelColor(m, i) },
        data: days.map((d) => byModelDay.get(m)?.get(d) ?? 0)
      })),
      tooltip: { ...base.tooltip, trigger: 'axis' }
    } as const
  }, [daily.data, base, dark])

  if (breakdown.loading && !breakdown.data) return <Empty text="" loading />
  if (breakdown.err) return <Empty text={breakdown.err} />
  const rows = breakdown.data ?? []
  const total = rows.reduce((s, m) => s + m.inTok + m.outTok + m.reasonTok, 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-ink">模型用量</h2>
          <span className="text-xs text-faint">全量累计 · 含 effort 变体</span>
        </div>
        <button
          className="btn h-7 px-2.5 text-xs"
          onClick={() =>
            exportCsv(
              `nexa-models-${new Date().toISOString().slice(0, 10)}.csv`,
              ['模型', 'Agent', '请求数', '输入', '缓存读', '输出', '推理', '总量', '均时长ms', '加权TPS', '最近使用'],
              rows.map((m) => [
                m.model,
                agentName(m.agentId),
                m.requests,
                m.inTok,
                m.cachedTok,
                m.outTok,
                m.reasonTok,
                m.inTok + m.outTok + m.reasonTok,
                m.avgDurOk ? Math.round(m.avgDurMs) : '',
                m.tpsOk ? m.weightedTps.toFixed(1) : '',
                new Date(m.lastMs).toLocaleString('zh-CN', { hour12: false })
              ])
            )
          }
        >
          导出 CSV
        </button>
      </div>

      <Card className="h-72">
        <CardTitle>每日生成 Token 趋势（按生成量 Top 5 模型）</CardTitle>
        {trendOpt ? <Chart option={trendOpt} className="h-56" /> : <Empty text="暂无数据" />}
      </Card>

      <Card pad={false} className="overflow-x-auto">
        {rows.length === 0 ? (
          <div className="py-8">
            <Empty text="暂无模型用量记录" />
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>模型</th>
                <th>Agent</th>
                <th className="num">请求数</th>
                <th className="num">输入</th>
                <th className="num">缓存读</th>
                <th className="num">输出</th>
                <th className="num">推理</th>
                <th className="num">总量</th>
                <th className="w-36">占比</th>
                <th className="num">均时长</th>
                <th className="num">加权速度</th>
                <th className="num">最近使用</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const tot = m.inTok + m.outTok + m.reasonTok
                return (
                  <tr key={m.agentId + m.model + m.effort}>
                    <td className="max-w-48 truncate font-medium text-ink" title={m.model + (m.effort ? ` (${m.effort})` : '')}>
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: modelColor(m.model) }} />
                      {m.model || '—'}
                      {m.effort && <span className="ml-1 text-[11px] text-faint">{m.effort}</span>}
                    </td>
                    <td>
                      <span className="text-xs" style={{ color: agentColor(m.agentId) }}>
                        {agentName(m.agentId)}
                      </span>
                    </td>
                    <td className="num">{fmtInt(m.requests)}</td>
                    <td className="num">{fmtNumCn(m.inTok)}</td>
                    <td className="num text-faint">{fmtNumCn(m.cachedTok)}</td>
                    <td className="num">{fmtNumCn(m.outTok)}</td>
                    <td className="num">{fmtNumCn(m.reasonTok)}</td>
                    <td className="num font-semibold">{fmtNumCn(tot)}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <RatioBar ratio={tot} total={Math.max(1, total)} color={modelColor(m.model)} />
                        <span className="w-11 shrink-0 text-right font-mono text-[11px] text-faint">
                          {total > 0 ? ((tot / total) * 100).toFixed(1) + '%' : ''}
                        </span>
                      </div>
                    </td>
                    <td className="num text-faint">{m.avgDurOk ? fmtMs(m.avgDurMs) : '—'}</td>
                    <td className="num font-medium" style={{ color: m.tpsOk ? speedColor(m.weightedTps) : undefined }}>
                      {m.tpsOk ? fmtTps(m.weightedTps) : '—'}
                    </td>
                    <td className="num text-faint" title={relTime(m.lastMs)}>
                      {relTime(m.lastMs)}
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
