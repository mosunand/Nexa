// components/Chart.tsx — ECharts 的 React 薄封装（按需引入，砍掉 3.5MB 全量包）。
// 主题切换时以基础主题重建实例；option 变化时全量 setOption；
// 容器尺寸变化自动 resize（ResizeObserver）。

import { useEffect, useRef, type ReactNode } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, TreemapChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useTheme } from '../lib/theme'

// 本应用只用到 柱/线/饼/矩形树图 + 网格/提示/图例/视觉映射/标线 —— 按需注册
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  TreemapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  MarkLineComponent,
  CanvasRenderer
])

export interface ChartProps {
  option: Record<string, unknown>
  className?: string
  markLineX?: number // 移动指针（时间轴竖线，部分合并不重建整图）
  markPointCoord?: [number, number] // 曲线笔头圆点（部分合并）
  xAxisMax?: number // 时间轴可见上限（重放 reveal：曲线随虚拟时刻从左往右画出）
}

// chartTheme 的返回形状（页面会展开 base 及其子对象）
export interface ChartBase {
  backgroundColor: string
  textStyle: Record<string, unknown>
  tooltip: Record<string, unknown>
  grid: Record<string, unknown>
  xAxis: Record<string, unknown>
  yAxis: Record<string, unknown>
}

// 与主题联动的公共样式片段
export function chartTheme(dark: boolean): ChartBase {
  const ink = dark ? '#9aa3b5' : '#5b6472'
  const line = dark ? 'rgba(154,163,181,0.14)' : 'rgba(70,80,97,0.14)'
  const tipBg = dark ? '#171c27' : '#ffffff'
  return {
    backgroundColor: 'transparent', // 卡片已有底色，ECharts dark 主题自带近黑画布必须透明化
    textStyle: { fontFamily: "'Segoe UI', 'Microsoft YaHei UI', sans-serif" },
    tooltip: {
      backgroundColor: tipBg,
      borderColor: dark ? '#2e3648' : '#dde3ec',
      borderWidth: 1,
      textStyle: { color: dark ? '#e7ebf3' : '#1a2332', fontSize: 12 },
      extraCssText: 'border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.25); user-select: text;'
    },
    grid: { left: 8, right: 14, top: 28, bottom: 4, containLabel: true },
    xAxis: {
      axisLine: { lineStyle: { color: line } },
      axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 11 },
      splitLine: { show: false }
    },
    yAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 11 },
      splitLine: { lineStyle: { color: line } }
    }
  }
}

export function Chart({ option, className, markLineX, markPointCoord, xAxisMax }: ChartProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const instRef = useRef<echarts.ECharts | null>(null)
  const { theme } = useTheme()
  const dark = theme === 'dark'

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, dark ? 'dark' : undefined, { renderer: 'canvas' })
    instRef.current = chart
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      chart.dispose()
      instRef.current = null
    }
    // 主题切换 → 重建实例（基础主题是实例级的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark])

  useEffect(() => {
    instRef.current?.setOption(option as echarts.EChartsCoreOption, true)
  }, [option, dark])

  // 移动指针：部分合并，避免整图重建（重放动画每帧调用）
  useEffect(() => {
    if (markLineX === undefined) return
    instRef.current?.setOption({
      series: [
        {
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#22d3ee', width: 2 },
            label: { show: false },
            data: [{ xAxis: markLineX }]
          }
        }
      ]
    })
  }, [markLineX, option])

  // 曲线笔头圆点
  useEffect(() => {
    if (!markPointCoord) return
    instRef.current?.setOption({
      series: [
        {
          markPoint: {
            silent: true,
            symbol: 'circle',
            symbolSize: 9,
            itemStyle: { color: '#818cf8', borderColor: '#22d3ee', borderWidth: 2 },
            label: { show: false },
            data: [{ coord: markPointCoord }]
          }
        }
      ]
    })
  }, [markPointCoord, option])

  // 时间轴可见上限：部分合并 → 曲线随虚拟时刻逐步"画出"
  useEffect(() => {
    if (xAxisMax === undefined) return
    instRef.current?.setOption({ xAxis: { max: xAxisMax } })
  }, [xAxisMax, option])

  return <div ref={ref} className={className} style={{ minHeight: 120 }} />
}
