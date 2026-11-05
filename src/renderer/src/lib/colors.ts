// lib/colors.ts — agent 品牌色 + 模型大类 / 模型配色的稳定分配。

import { AGENTS_META } from '@shared/types'

// 自定义 agent 的名称/颜色（App 在健康状态刷新时注册进来）
const dynamicMeta = new Map<string, { name: string; color: string }>()

export function registerAgentMeta(id: string, name: string, color: string): void {
  if (AGENTS_META[id]) return
  dynamicMeta.set(id, { name, color })
}

export function agentName(id: string): string {
  return AGENTS_META[id]?.name ?? dynamicMeta.get(id)?.name ?? id
}

export function agentColor(id: string): string {
  return AGENTS_META[id]?.color ?? dynamicMeta.get(id)?.color ?? '#8b93a7'
}

// 图表用调色板（亮而柔，深浅主题都可读）
const PALETTE = [
  '#818cf8', // indigo
  '#22d3ee', // cyan
  '#f472b6', // pink
  '#34d399', // emerald
  '#fbbf24', // amber
  '#a78bfa', // violet
  '#fb923c', // orange
  '#4ade80', // green
  '#38bdf8', // sky
  '#f87171', // red
  '#e879f9', // fuchsia
  '#2dd4bf' // teal
]

const familyColorMap = new Map<string, string>()
const modelColorMap = new Map<string, string>()

function stableIndex(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function familyColor(family: string): string {
  let c = familyColorMap.get(family)
  if (!c) {
    c = PALETTE[stableIndex(family) % PALETTE.length] as string
    familyColorMap.set(family, c)
  }
  return c
}

export function modelColor(model: string, order?: number): string {
  if (order !== undefined) {
    const c = PALETTE[order % PALETTE.length] as string
    modelColorMap.set(model, c)
    return c
  }
  let c = modelColorMap.get(model)
  if (!c) {
    c = PALETTE[stableIndex(model) % PALETTE.length] as string
    modelColorMap.set(model, c)
  }
  return c
}
