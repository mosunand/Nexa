// pages/InsightsPage.tsx — 项目洞察：项目排行榜 / 急刹车指数 / 深度扫描
// （重试环 + 代码文件热点图）。全部现有数据直接推导，深度扫描为有界
// 重放（80 会话 / 8s 预算）。

import { useMemo, useState, type ReactNode } from 'react'
import type { BrakeStats, DeepScanResult, ProjectStat, TimeWindow } from '@shared/types'
import { useAsync, useDataTick } from '../lib/data'
import { agentColor, agentName, modelColor } from '../lib/colors'
import { Chart, chartTheme } from '../components/Chart'
import { Badge, Card, CardTitle, Empty, KpiCard, RatioBar } from '../components/ui'
import { fmtInt, fmtNumCn, fmtTps, relTime, speedColor } from '../lib/format'
import { useTheme } from '../lib/theme'

const WINDOWS: Array<{ id: TimeWindow; label: string; ms: number }> = [
  { id: '7d', label: '近 7 天', ms: 7 * 86_400_000 },
  { id: '30d', label: '近 30 天', ms: 30 * 86_400_000 },
  { id: 'all', label: '全部', ms: 0 }
]

export function InsightsPage(): ReactNode {
  const [win, setWin] = useState(WINDOWS[1]!)
  const tick = useDataTick()
  const since = win.ms > 0 ? Date.now() - win.ms : 0

  const projects = useAsync<ProjectStat[]>(() => window.nexa.projectStats(since), [win.id, tick])
  const brake = useAsync<BrakeStats>(() => window.nexa.brakeStats(since), [win.id, tick])

  const [selected, setSelected] = useState<string>('')
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<DeepScanResult | null>(null)

  const { theme } = useTheme()
  const dark = theme === 'dark'
  const base = useMemo(() => chartTheme(dark), [dark])

  const runScan = async (): Promise<void> => {
    setScanning(true)
    try {
      const r = await window.nexa.deepScan(since)
      setScan(r)
    } finally {
      setScanning(false)
    }
  }

  // 急刹车按小时分布图
  const brakeOpt = useMemo(() => {
    const b = brake.data
    if (!b) return null
    return {
      ...base,
      xAxis: {
        ...base.xAxis,
        type: 'category',
        data: b.byHour.map((h) => `${String(h.hour).padStart(2, '0')}时`)
      },
      yAxis: { ...base.yAxis, type: 'value' },
      series: [
        {
          name: '请求',
          type: 'bar' as const,
          data: b.byHour.map((h) => h.requests),
          barMaxWidth: 14,
          itemStyle: { color: '#818cf8', borderRadius: [3, 3, 0, 0], opacity: 0.55 }
        },
        {
          name: '打断',
          type: 'bar' as const,
          data: b.byHour.map((h) => h.aborts),
          barMaxWidth: 14,
          itemStyle: { color: '#ef4444', borderRadius: [3, 3, 0, 0] }
        }
      ],
      legend: { show: true, top: 0, right: 0, textStyle: { color: dark ? '#9aa3b5' : '#5b6472', fontSize: 11 }, itemWidth: 14 },
      tooltip: { ...base.tooltip, trigger: 'axis' }
    }
  }, [brake.data, base, dark])

  // 文件热点 treemap
  const hotOpt = useMemo(() => {
    if (!scan || scan.hotspots.length === 0) return null
    return {
      ...base,
      tooltip: {
        ...base.tooltip,
        formatter: (p: { name: string; value: number[] }) =>
          `${p.name}<br/>${fmtNumCn(p.value[0] ?? 0)} tokens · ${p.value[1] ?? 0} 次编辑`
      },
      series: [
        {
          type: 'treemap',
          data: scan.hotspots.map((h) => ({ name: h.file, value: [h.tokens, h.edits] })),
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          itemStyle: { borderColor: dark ? '#12161f' : '#fff', borderWidth: 2, gapWidth: 2 },
          label: { fontSize: 10, overflow: 'truncate', width: 90 },
          upperLabel: { show: false }
        }
      ]
    }
  }, [scan, base, dark])

  const list = projects.data ?? []
  const totalTok = list.reduce((s, p) => s + p.inTok + p.outTok + p.reasonTok, 0)
  const b = brake.data
  const brakeRate = b && b.requests > 0 ? b.aborts / b.requests : 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-ink">项目洞察</h2>
          <span className="text-xs text-faint">算力去向 · 急刹车指数 · 浪费检测</span>
        </div>
        <div className="seg">
          {WINDOWS.map((w) => (
            <button key={w.id} className={win.id === w.id ? 'on' : ''} onClick={() => setWin(w)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 项目排行榜 ── */}
      <Card pad={false} className="overflow-hidden">
        <div className="px-5 pt-4">
          <CardTitle right={<Badge tone="accent">按会话目录聚合</Badge>}>项目排行榜</CardTitle>
        </div>
        {projects.loading && !projects.data ? (
          <div className="py-8">
            <Empty text="" loading />
          </div>
        ) : list.length === 0 ? (
          <div className="py-8">
            <Empty text="窗口内暂无项目数据" />
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>项目</th>
                <th>Agent</th>
                <th className="num">会话</th>
                <th className="num">请求</th>
                <th className="num">Token</th>
                <th className="w-44">占比</th>
                <th className="num">错误</th>
                <th className="num">打断</th>
                <th className="num">速度</th>
                <th className="num">最近</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const tot = p.inTok + p.outTok + p.reasonTok
                const sel = selected === p.project
                return (
                  <tr
                    key={p.project}
                    className="cursor-pointer"
                    style={sel ? { background: 'rgb(129 140 248 / 0.08)' } : undefined}
                    onClick={() => setSelected(sel ? '' : p.project)}
                    title={p.project}
                  >
                    <td className="max-w-56 truncate font-medium text-ink">
                      {p.name}
                      <span className="ml-1.5 text-[11px] text-faint">{p.project.match(/[\\/](?:[^\\/]+[\\/]){1}[^\\/]+$/)?.[0] ?? ''}</span>
                    </td>
                    <td>
                      <span className="flex gap-1">
                        {p.agents.map((a) => (
                          <span
                            key={a}
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: agentColor(a) }}
                            title={agentName(a)}
                          />
                        ))}
                      </span>
                    </td>
                    <td className="num">{fmtInt(p.sessions)}</td>
                    <td className="num">{fmtInt(p.requests)}</td>
                    <td className="num font-semibold">{fmtNumCn(tot)}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <RatioBar ratio={tot} total={Math.max(1, totalTok)} color="#818cf8" />
                        <span className="w-11 shrink-0 text-right font-mono text-[11px] text-faint">
                          {totalTok > 0 ? ((tot / totalTok) * 100).toFixed(1) + '%' : ''}
                        </span>
                      </div>
                    </td>
                    <td className="num">{p.errors > 0 ? <span className="text-warn">{fmtInt(p.errors)}</span> : '0'}</td>
                    <td className="num">{p.aborts > 0 ? <span className="text-bad">{fmtInt(p.aborts)}</span> : '0'}</td>
                    <td className="num" style={{ color: p.tpsOk ? speedColor(p.weightedTps) : undefined }}>
                      {p.tpsOk ? fmtTps(p.weightedTps) : '—'}
                    </td>
                    <td className="num text-faint">{relTime(p.lastMs)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* ── 急刹车指数 ── */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-bold text-ink">急刹车指数</h3>
          <span className="text-xs text-faint">
            你在 agent 答到一半时主动取消的比例 —— 被打断最多的模型/时段 = 最不耐烦的时刻
          </span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <KpiCard
            label="打断次数"
            value={b ? fmtInt(b.aborts) : '—'}
            sub={b ? `共 ${fmtInt(b.requests)} 次请求` : ''}
          />
          <KpiCard
            label="急刹车率"
            value={b ? (brakeRate * 100).toFixed(2) + '%' : '—'}
            bar={b ? { ratio: Math.min(1, brakeRate * 10), color: 'var(--bad)' } : undefined}
            sub="打断 ÷ 总请求（条长按 10% 满格）"
          />
          <KpiCard
            label="被打断烧掉"
            value={b ? fmtNumCn(b.abortedTok) : '—'}
            sub="取消时已消耗的 token（保留在统计里）"
          />
          <KpiCard
            label="最常被打断的模型"
            value={b && b.byModel.length > 0 ? (b.byModel.find((m) => m.aborts > 0)?.model.split('-')[0] ?? '—') : '—'}
            sub={b?.byModel.find((m) => m.aborts > 0)
              ? `${b.byModel.find((m) => m.aborts > 0)!.aborts} 次 · ${fmtNumCn(b.byModel.find((m) => m.aborts > 0)!.abortedTok)} tokens`
              : '暂无打断记录'}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <Card className="h-64">
            <CardTitle>按小时分布（本地时间）</CardTitle>
            {brakeOpt ? <Chart option={brakeOpt} className="h-48" /> : <Empty text="暂无数据" />}
          </Card>
          <Card pad={false} className="overflow-hidden">
            <div className="px-5 pt-4">
              <CardTitle>按模型 · 打断排行</CardTitle>
            </div>
            {!b || b.byModel.filter((m) => m.aborts > 0).length === 0 ? (
              <div className="pb-8">
                <Empty text="窗口内没有打断记录 —— 和所有模型都相处融洽" />
              </div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th className="num">请求</th>
                    <th className="num">打断</th>
                    <th className="num">打断率</th>
                    <th className="num">烧掉</th>
                  </tr>
                </thead>
                <tbody>
                  {b.byModel
                    .filter((m) => m.aborts > 0)
                    .sort((x, y) => y.aborts / Math.max(1, y.requests) - x.aborts / Math.max(1, x.requests))
                    .map((m) => (
                      <tr key={m.model}>
                        <td className="max-w-48 truncate">
                          <span
                            className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                            style={{ background: modelColor(m.model) }}
                          />
                          {m.model}
                        </td>
                        <td className="num">{fmtInt(m.requests)}</td>
                        <td className="num font-semibold text-bad">{fmtInt(m.aborts)}</td>
                        <td className="num">{((m.aborts / Math.max(1, m.requests)) * 100).toFixed(1)}%</td>
                        <td className="num">{fmtNumCn(m.abortedTok)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

      {/* ── 深度扫描：重试环 + 文件热点 ── */}
      <Card>
        <CardTitle
          right={
            <div className="flex items-center gap-2">
              {scan && (
                <Badge tone={scan.truncated ? 'warn' : 'ok'}>
                  已扫 {scan.scannedSessions} 会话{scan.truncated ? '（达预算上限）' : ''}
                </Badge>
              )}
              <button className="btn btn-accent h-7 px-3 text-xs" disabled={scanning} onClick={() => void runScan()}>
                {scanning ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    扫描中…
                  </>
                ) : (
                  '深度扫描'
                )}
              </button>
            </div>
          }
        >
          深度扫描 · 浪费检测 + 代码文件热点
          <span className="ml-2 text-xs font-normal text-faint">
            重放最近会话的对话流（zcode/claude/codex，最多 80 个 / 8 秒预算）
          </span>
        </CardTitle>

        {!scan ? (
          <Empty text="点击「深度扫描」开始：解析最近会话的对话重放，检测卡死重试环、统计代码文件热点" />
        ) : (
          <div className="space-y-4">
            {/* 重试环 */}
            <div>
              <div className="mb-2 text-xs font-medium text-muted">
                重试环（同参数同工具连续 ≥3 次 = 卡死烧钱信号）
              </div>
              {scan.loops.length === 0 ? (
                <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-ok">
                  ✓ 未发现卡死环 —— agent 没有在同一处反复打转
                </div>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>会话</th>
                      <th>Agent</th>
                      <th>工具</th>
                      <th className="num">重复</th>
                      <th>参数摘要</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scan.loops.map((l, i) => (
                      <tr key={i}>
                        <td className="font-mono text-xs text-faint">{l.sessionId.slice(0, 12)}…</td>
                        <td>
                          <span className="text-xs" style={{ color: agentColor(l.agentId) }}>
                            {agentName(l.agentId)}
                          </span>
                        </td>
                        <td className="chip font-mono text-[11px]">{l.tool}</td>
                        <td className="num font-semibold text-bad">×{l.repeats}</td>
                        <td className="max-w-72 truncate font-mono text-[11px] text-soft" title={l.args}>
                          {l.args}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* 文件热点 */}
            <div>
              <div className="mb-2 text-xs font-medium text-muted">
                代码文件热点（响应生成 token 归因到其后的文件编辑）
              </div>
              {hotOpt ? (
                <div className="grid grid-cols-2 gap-4">
                  <div className="h-64">
                    <Chart option={hotOpt} className="h-64" />
                  </div>
                  <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
                    {scan.hotspots.slice(0, 15).map((h) => (
                      <div key={h.file} className="flex items-center gap-2 text-xs">
                        <span className="w-14 shrink-0 text-right font-mono text-faint">{fmtNumCn(h.tokens)}</span>
                        <RatioBar ratio={h.tokens} total={Math.max(1, scan.hotspots[0]?.tokens ?? 1)} color="#22d3ee" />
                        <span className="w-12 shrink-0 text-right text-faint">{h.edits} 次</span>
                        <span className="w-44 shrink-0 truncate font-mono text-[11px] text-soft" title={h.file}>
                          {h.file}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-faint">
                  未提取到文件路径 —— 这批会话没有携带文件参数的工具调用
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
