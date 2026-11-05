// components/Heatmap.tsx — GitHub / Duolingo 风格 Token 活动热力图（一年日历）。
// 亮度按分位定级：活跃日中最小的 25% 为最暗档、前 25% 直接满格 —— 与绝对
// 量级无关（对应老项目 UsageHeatmap 的分位逻辑）。视觉：绿色系大格子 +
// 紧凑网格，空日保留隐约底色，周一/周三/周五行标 + 月份列标。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { fmtNumCn, fmtTimeFull } from '../lib/format'
import { useTheme } from '../lib/theme'
import type { DailyTotal } from '@shared/types'

interface Props {
  data: DailyTotal[]
  mode: 'day' | 'week' | 'cum' // 日 / 每周 / 累计 三档口径
}

// 网格几何：格子动态撑满容器宽度（11~30px，ZCode 同款胖格子），深度 7 行不变；
// 窄窗口下限 11px 并横向滚动。
const PAD_L = 42
const PAD_T = 22
const WEEKS = 53

// 绿色系分位色阶：亮度随用量单调递增（深色背景上"越亮=越多"，一眼可读）。
// 5 档：最高档近白薄荷绿 —— 重度日（亿级）必须一眼炸出来。
// 深浅主题各一套（浅色主题相反：越深=越多）。
const LEVELS_DARK = [
  'color-mix(in oklab, #39d353 3%, var(--panel-2))', // 空日：几乎隐形，让数据自己浮出来
  '#14532d',
  '#1f7a3d',
  '#2ea043',
  '#3fcc66',
  '#63e08a' // 满：明显亮于 L4，但不刺眼
]
const LEVELS_LIGHT = [
  'color-mix(in oklab, #216e39 3%, var(--panel-2))',
  '#d3f4de',
  '#9be9a8',
  '#52d473',
  '#2bb35a',
  '#127a3f' // 满：最深
]

function localMidnight(now = Date.now()): number {
  const tz = -new Date(now).getTimezoneOffset() * 60_000
  return Math.floor((now + tz) / 86_400_000) * 86_400_000 - tz
}

export function Heatmap({ data, mode }: Props): ReactNode {
  const [hover, setHover] = useState<{ x: number; y: number; dayMs: number; tokens: number } | null>(null)
  const { theme } = useTheme()
  const LEVEL_COLORS = theme === 'dark' ? LEVELS_DARK : LEVELS_LIGHT

  // 容器宽度 → 格子尺寸（撑满，11~30px 自适应）。
  // 注意：gap 随 cell 升档（≥22 → 4px）后必须用它重解一次 cell，
  // 否则公式与实际 gap 不一致会导致整行溢出、末列被裁。
  const wrapRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(1100)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail(el.clientWidth))
    ro.observe(el)
    setAvail(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const usable = Math.max(300, avail - PAD_L - 8)
  let gap = 3
  let cell = Math.floor((usable - gap * (WEEKS - 1)) / WEEKS)
  if (cell >= 22) {
    gap = 4
    cell = Math.floor((usable - gap * (WEEKS - 1)) / WEEKS)
  }
  cell = Math.max(11, Math.min(30, cell))
  const step = cell + gap

  const { weeks, thresholds, activeDays } = useMemo(() => {
    const byDay = new Map<number, number>()
    for (const d of data) byDay.set(d.dayMs, d.tokens)

    const today = localMidnight()
    const start = today - 364 * 86_400_000
    const startDow = (new Date(start).getDay() + 6) % 7 // 0=周一
    const startAligned = start - startDow * 86_400_000

    const cols: Array<{ dayMs: number; tokens: number }[]> = []
    for (let w = 0; w < 53; w++) {
      const col: Array<{ dayMs: number; tokens: number }> = []
      for (let d = 0; d < 7; d++) {
        const dayMs = startAligned + (w * 7 + d) * 86_400_000
        if (dayMs > today || dayMs < start - 7 * 86_400_000) {
          col.push({ dayMs: 0, tokens: -1 }) // 越界占位
          continue
        }
        col.push({ dayMs, tokens: byDay.get(dayMs) ?? 0 })
      }
      cols.push(col)
    }

    // 分位定级（只看活跃日，5 档：20/40/60/80 分位）
    const active = data.filter((d) => d.tokens > 0).map((d) => d.tokens).sort((a, b) => a - b)
    const th = [0.2, 0.4, 0.6, 0.8].map((p) => {
      if (active.length === 0) return 0
      return active[Math.min(active.length - 1, Math.floor(active.length * p))] ?? 0
    })
    return { weeks: cols, thresholds: th, activeDays: active.length }
  }, [data])

  // mode: week/cum 改变单元格值
  const valueOf = (dayMs: number, tokens: number, wIdx: number): number => {
    if (tokens < 0) return -1
    if (mode === 'day') return tokens
    if (mode === 'week') {
      let s = 0
      for (const c of weeks[wIdx] ?? []) s += Math.max(0, c.tokens)
      return s
    }
    // cum：从年初累计到该日
    let s = 0
    for (let w = 0; w <= wIdx; w++) {
      for (const c of weeks[w] ?? []) {
        if (c.dayMs && c.dayMs <= dayMs) s += Math.max(0, c.tokens)
      }
    }
    return s
  }

  const levelOf = (v: number): number => {
    if (v <= 0) return 0
    let lv = 1
    thresholds.forEach((t, i) => {
      if (v >= t) lv = i + 2 // 阈值 4 个 → 档位 2..5（1 档 = 最低活跃档）
    })
    return lv
  }

  const monthLabels = useMemo(() => {
    const out: Array<{ col: number; label: string }> = []
    let lastMonth = -1
    weeks.forEach((col, w) => {
      const first = col.find((c) => c.dayMs > 0)
      if (!first) return
      const m = new Date(first.dayMs).getMonth()
      if (m !== lastMonth) {
        lastMonth = m
        out.push({ col: w, label: `${m + 1}月` })
      }
    })
    return out
  }, [weeks])

  const gridW = weeks.length * step
  const gridH = 7 * step

  return (
    <div className="relative select-none" ref={wrapRef}>
      <div className="overflow-x-auto pb-1">
        <svg width={PAD_L + gridW + 8} height={PAD_T + gridH + 4} className="block">
          {/* 月份列标 */}
          {monthLabels.map((m) => (
            <text key={m.col} x={PAD_L + m.col * step} y={12} fontSize={11} fill="var(--muted)">
              {m.label}
            </text>
          ))}
          {/* 周一行标 */}
          {(
            [
              [1, '周一'],
              [3, '周三'],
              [5, '周五']
            ] as const
          ).map(([row, label]) => (
            <text
              key={label}
              x={PAD_L - 8}
              y={PAD_T + row * step + cell - 3}
              fontSize={11}
              fill="var(--muted)"
              textAnchor="end"
            >
              {label}
            </text>
          ))}
          {weeks.map((col, w) =>
            col.map((cellData, d) => {
              if (!cellData.dayMs) return null
              const v = valueOf(cellData.dayMs, cellData.tokens, w)
              const lv = levelOf(Math.max(0, v))
              return (
                <rect
                  key={cellData.dayMs}
                  x={PAD_L + w * step}
                  y={PAD_T + d * step}
                  width={cell}
                  height={cell}
                  rx={cell >= 20 ? 5 : 3.5}
                  fill={LEVEL_COLORS[lv]}
                  stroke={hover?.dayMs === cellData.dayMs ? 'var(--ink)' : 'transparent'}
                  strokeWidth={1.5}
                  style={{ cursor: v < 0 ? 'default' : 'pointer', transition: 'fill .2s' }}
                  onMouseEnter={() => {
                    if (v < 0) return
                    setHover({
                      x: PAD_L + w * step,
                      y: PAD_T + d * step,
                      dayMs: cellData.dayMs,
                      tokens: Math.max(0, v)
                    })
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              )
            })
          )}
        </svg>
      </div>

      {/* 底部：汇总 + 图例 */}
      <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
        <span>
          {data.length > 0 ? (
            <>
              近一年累计 <span className="font-medium text-soft">{fmtNumCn(data.reduce((s, d) => s + d.tokens, 0))}</span>{' '}
              tokens · 活跃 {activeDays} 天
            </>
          ) : (
            '暂无活动数据'
          )}
        </span>
        <span className="flex items-center gap-1.5">
          少
          {[1, 2, 3, 4, 5].map((l) => (
            <span key={l} className="inline-block h-3 w-3 rounded-[3px]" style={{ background: LEVEL_COLORS[l] }} />
          ))}
          多
        </span>
      </div>

      {hover && (
        <div
          className="pointer-events-none absolute z-30 rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: Math.max(0, hover.x - 30), top: hover.y + 22 }}
        >
          <div className="font-medium text-ink">{fmtNumCn(hover.tokens)} tokens</div>
          <div className="text-faint">{fmtTimeFull(hover.dayMs).split(' ')[0]}</div>
        </div>
      )}
    </div>
  )
}
