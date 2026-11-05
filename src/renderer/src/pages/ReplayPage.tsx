// pages/ReplayPage.tsx — 一日重放（时间机器）：像看录像一样回放 token 燃烧。
// 两种窗口：「单日」（选某天，当天则止于现在）与「近 24 小时」（now-24h → now，
// 可跨午夜）。绝不播放未来 —— 播放终点 = 数据的最新时刻。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DayReplayRow } from '@shared/types'
import { AGENTS_META } from '@shared/types'
import { useAsync } from '../lib/data'
import { agentColor, agentName, modelColor } from '../lib/colors'
import { Chart, chartTheme } from '../components/Chart'
import { Badge, Card, CardTitle, Empty, KpiCard } from '../components/ui'
import { fmtInt, fmtNumCn, fmtTps } from '../lib/format'
import { useTheme } from '../lib/theme'

const SPEEDS = [
  { label: '60×', v: 60 },
  { label: '600×', v: 600 },
  { label: '3600×', v: 3600 },
  { label: '顶速', v: 86_400_000 }
]

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function clockOf(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function dateStrOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

type RangeMode = 'day' | '24h'

export function ReplayPage(): ReactNode {
  const [mode, setMode] = useState<RangeMode>('24h')
  const [dateStr, setDateStr] = useState(() => dateStrOf(Date.now()))

  // 窗口起止（取数时刻定格 —— 重放的是快照，绝不播放未来）
  const { winStart, winEnd } = useMemo(() => {
    const now = Date.now()
    if (mode === '24h') return { winStart: now - 86_400_000, winEnd: now }
    const t = Date.parse(dateStr + 'T00:00:00') // 无时区后缀 → 本地午夜
    const start = Number.isFinite(t) ? t : now
    return { winStart: start, winEnd: Math.min(start + 86_400_000, now) }
  }, [mode, dateStr])
  const span = Math.max(1000, winEnd - winStart)

  const rows = useAsync<DayReplayRow[]>(() => window.nexa.dayReplay(winStart, winEnd), [winStart, winEnd])
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(600)
  // 虚拟时刻：rAF 里累积在 ref（不打扰 React），每 100ms 节流上屏一次 ——
  // 60fps setState 会让图表时间轴每帧重排，体验卡顿
  const vtRef = useRef(0)
  const [vt, setVtState] = useState(0)
  const setVt = useCallback((v: number): void => {
    vtRef.current = v
    setVtState(v)
  }, [])
  const rafRef = useRef<number | null>(null)
  const emitRef = useRef(0)

  // 窗口变化 → 重置到起点
  useEffect(() => {
    setPlaying(false)
    setVt(0)
  }, [winStart, winEnd, setVt])

  // 播放循环（终点 = 窗口末尾）
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    emitRef.current = 0
    const step = (now: number): void => {
      const dt = now - last
      last = now
      const nv = vtRef.current + dt * speed
      if (nv >= span) {
        vtRef.current = span
        setVtState(span)
        setPlaying(false)
        return
      }
      vtRef.current = nv
      if (now - emitRef.current >= 100) {
        emitRef.current = now
        setVtState(nv)
      }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [playing, speed, span])

  const list = rows.data ?? []
  const times = useMemo(() => list.map((r) => r.timeMs - winStart), [list, winStart])

  // 指针：二分找虚拟时刻已完成的响应数
  const pointer = useMemo(() => {
    let lo = 0
    let hi = times.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (times[mid]! <= vt) lo = mid + 1
      else hi = mid
    }
    return lo
  }, [times, vt])

  // 派生统计（截至指针）
  const stat = useMemo(() => {
    let cum = 0
    let cumOut = 0
    let aborts = 0
    const perModel = new Map<string, number>()
    const abortPoints: Array<[number, number]> = []
    for (let i = 0; i < pointer; i++) {
      const r = list[i]!
      cum += r.inTok + r.outTok + r.reasonTok
      cumOut += r.outTok + r.reasonTok
      perModel.set(r.model, (perModel.get(r.model) ?? 0) + r.outTok + r.reasonTok)
      if (r.error) {
        aborts++
        abortPoints.push([r.timeMs, cum])
      }
    }
    // 燃烧速率：虚拟时刻前 60s 的生成 token / 60
    const cutoff = winStart + vt - 60_000
    let recent = 0
    for (let i = pointer - 1; i >= 0; i--) {
      const r = list[i]!
      if (r.timeMs < cutoff) break
      recent += r.outTok + r.reasonTok
    }
    const burn = vt > 60_000 ? recent / 60 : recent / Math.max(1, vt / 1000)
    const events = list.slice(Math.max(0, pointer - 12), pointer).reverse()
    return { cum, cumOut, aborts, perModel, abortPoints, burn, events }
  }, [pointer, list, winStart, vt])

  // 全日累计曲线（数据到达时一次渲染；可见范围由 xAxisMax 逐帧推进 → 曲线逐步画出）
  const { theme } = useTheme()
  const dark = theme === 'dark'
  const base = useMemo(() => chartTheme(dark), [dark])
  const option = useMemo(() => {
    if (list.length === 0) return null
    let cum = 0
    const pts: Array<[number, number]> = [[winStart, 0]]
    for (const r of list) {
      cum += r.inTok + r.outTok + r.reasonTok
      pts.push([r.timeMs, cum])
    }
    return {
      ...base,
      xAxis: {
        ...base.xAxis,
        type: 'time',
        min: winStart,
        max: winStart + 60_000,
        axisLabel: {
          color: dark ? '#9aa3b5' : '#5b6472',
          fontSize: 11,
          formatter: (v: number) => (mode === '24h' ? `${pad(new Date(v).getHours())}:00` : clockOf(v).slice(0, 5))
        }
      },
      yAxis: {
        ...base.yAxis,
        type: 'value',
        axisLabel: { color: dark ? '#9aa3b5' : '#5b6472', fontSize: 11, formatter: (v: number) => fmtNumCn(v) }
      },
      series: [
        {
          type: 'line',
          step: 'end',
          showSymbol: false,
          data: pts,
          lineStyle: { width: 2, color: '#818cf8' },
          areaStyle: { opacity: 0.15, color: '#818cf8' }
        },
        {
          type: 'scatter',
          data: stat.abortPoints,
          symbolSize: 7,
          itemStyle: { color: '#ef4444' },
          tooltip: { show: false }
        }
      ],
      tooltip: {
        ...base.tooltip,
        trigger: 'axis',
        formatter: (ps: Array<{ value: [number, number] }>) =>
          `${clockOf(ps[0]?.value[0] ?? 0)} · ${fmtNumCn(ps[0]?.value[1] ?? 0)} tokens`
      }
    }
  }, [list, base, dark, winStart, stat.abortPoints, mode])

  const dayTot = list.reduce((s, r) => s + r.inTok + r.outTok + r.reasonTok, 0)
  const dayAborts = list.filter((r) => r.error).length
  const perModelNow = [...stat.perModel.entries()].sort((a, b) => b[1] - a[1])
  const atEnd = vt >= span

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-ink">一日重放</h2>
          <span className="text-xs text-faint">时间机器 —— 像看录像一样回放 token 燃烧，止于最新数据</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="seg">
            <button className={mode === '24h' ? 'on' : ''} onClick={() => setMode('24h')}>
              近 24 小时
            </button>
            <button className={mode === 'day' ? 'on' : ''} onClick={() => setMode('day')}>
              单日
            </button>
          </div>
          {mode === 'day' && (
            <input
              type="date"
              className="input w-40"
              value={dateStr}
              max={dateStrOf(Date.now())}
              onChange={(e) => setDateStr(e.target.value)}
            />
          )}
        </div>
      </div>

      {rows.loading && !rows.data ? (
        <Empty text="" loading />
      ) : list.length === 0 ? (
        <Card>
          <Empty text={mode === '24h' ? '最近 24 小时没有响应记录' : '这一天没有响应记录 —— 换一天试试'} />
        </Card>
      ) : (
        <>
          {/* 控制条 */}
          <Card>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="btn btn-accent h-8 w-20"
                onClick={() => {
                  if (atEnd) setVt(0)
                  setPlaying((p) => !p)
                }}
              >
                {playing ? '⏸ 暂停' : atEnd ? '↻ 重放' : '▶ 播放'}
              </button>
              <div className="seg">
                {SPEEDS.map((s) => (
                  <button key={s.v} className={speed === s.v ? 'on' : ''} onClick={() => setSpeed(s.v)}>
                    {s.label}
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={0}
                max={span}
                step={10_000}
                value={Math.min(vt, span)}
                className="min-w-0 flex-1 accent-[var(--accent-2)]"
                onChange={(e) => {
                  setPlaying(false)
                  setVt(Number(e.target.value))
                }}
              />
              <span className="font-mono text-lg font-bold tabular-nums text-ink">
                {clockOf(winStart + Math.min(vt, span - 1000))}
              </span>
            </div>
          </Card>

          {/* 大数字 */}
          <div className="grid grid-cols-4 gap-3">
            <KpiCard
              label="虚拟时刻累计"
              value={fmtNumCn(stat.cum)}
              accentTop
              large
              sub={`生成 ${fmtNumCn(stat.cumOut)} · 窗口总量 ${fmtNumCn(dayTot)}`}
            />
            <KpiCard
              label="燃烧速率（前 1 分钟）"
              value={fmtTps(stat.burn)}
              sub="截至虚拟时刻的生成速度"
            />
            <KpiCard
              label="已发生请求"
              value={fmtInt(pointer)}
              sub={`打断 ${fmtInt(stat.aborts)} · 窗口 ${fmtInt(dayAborts)}`}
            />
            <KpiCard
              label="各模型已烧"
              large
              value=""
            >
              <div className="mt-1 space-y-1">
                {perModelNow.slice(0, 3).map(([m, v]) => (
                  <div key={m} className="flex items-center gap-1.5 text-xs">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: modelColor(m) }} />
                    <span className="truncate text-muted" title={m}>
                      {m}
                    </span>
                    <span className="ml-auto font-mono text-faint">{fmtNumCn(v)}</span>
                  </div>
                ))}
                {perModelNow.length === 0 && <span className="text-xs text-faint">还没开始</span>}
              </div>
            </KpiCard>
          </div>

          {/* 曲线 */}
          <Card className="h-80">
            <CardTitle
              right={
                <span className="flex items-center gap-1.5 text-xs text-faint">
                  <span className="inline-block h-2 w-2 rounded-full bg-bad" /> 红点 = 打断
                </span>
              }
            >
              累计 Token 曲线（{mode === '24h' ? '近 24 小时' : dateStr}
              {mode === 'day' && dateStr === dateStrOf(winEnd) ? ' · 止于现在' : ''}）
            </CardTitle>
            {option ? (
              <Chart
                option={option}
                className="h-60"
                markLineX={winStart + Math.min(vt, span - 1000)}
                markPointCoord={[winStart + Math.min(vt, span - 1000), stat.cum]}
                // 时间轴上限按整分钟量化（标签每虚拟分钟才重排）+ 右侧呼吸区，圆点完整可见；
                // 硬上限 = 窗口末尾（止于现在，绝不显示未来）
                xAxisMax={winStart + Math.min(Math.ceil(vt / 60_000) * 60_000 + 1_800_000, span)}
              />
            ) : (
              <Empty text="暂无数据" />
            )}
          </Card>

          {/* 事件流 */}
          <Card pad={false} className="overflow-hidden">
            <div className="px-5 pt-4">
              <CardTitle right={<Badge tone="accent">虚拟时刻前 12 条</Badge>}>事件流</CardTitle>
            </div>
            {stat.events.length === 0 ? (
              <div className="pb-6">
                <Empty text="按播放开始回放" />
              </div>
            ) : (
              <table className="data">
                <tbody>
                  {stat.events.map((r, i) => (
                    <tr key={r.timeMs + '-' + i} className={i === 0 ? 'flash-row' : ''}>
                      <td className="w-24 text-faint">{clockOf(r.timeMs)}</td>
                      <td className="w-28">
                        <span
                          className="inline-flex items-center gap-1.5 text-xs font-medium"
                          style={{ color: agentColor(r.agentId) }}
                          title={agentName(r.agentId)}
                        >
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: agentColor(r.agentId) }} />
                          {agentName(r.agentId)}
                        </span>
                      </td>
                      <td className="max-w-48 truncate text-soft" title={r.model}>
                        {r.model || '—'}
                      </td>
                      <td className="num">{fmtInt(r.inTok + r.outTok + r.reasonTok)} tok</td>
                      <td className="num" style={{ color: r.error ? 'var(--bad)' : undefined }}>
                        {r.error ? r.error : r.tps > 0 ? fmtTps(r.tps) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <div className="pb-2 text-center text-[11px] text-faint">
            窗口 {clockOf(winStart)} → {clockOf(winEnd)} ·{' '}
            {dateStrOf(winStart) === dateStrOf(winEnd)
              ? dateStrOf(winStart)
              : `${dateStrOf(winStart)} → ${dateStrOf(winEnd)}`}{' '}
            · 涉及{' '}
            {[
                ...new Set(list.map((r) => r.agentId)).values()
              ]
                .map((a) => AGENTS_META[a]?.name ?? a)
                .join(' · ')}
          </div>
        </>
      )}
    </div>
  )
}
