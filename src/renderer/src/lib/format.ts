// lib/format.ts — 数字/时间/速度的中文口径格式化。
// 从老项目 util/Format.cpp 1:1 移植（含先取整再拆分等细节）。

export function fmtNum(n: number): string {
  if (Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  if (Number.isInteger(n)) return String(n)
  return String(n)
}

export function fmtNumCn(n: number): string {
  if (Number.isNaN(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + '兆'
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (abs >= 1e4) return (n / 1e4).toFixed(1) + '万'
  if (Number.isInteger(n)) return String(n)
  return String(n)
}

export function fmtInt(n: number): string {
  if (Number.isNaN(n)) return '—'
  return Math.round(n).toLocaleString('zh-CN')
}

export function fmtMs(ms: number): string {
  if (Number.isNaN(ms)) return '—'
  if (ms < 999.5) return Math.round(ms) + 'ms'
  const decimals = ms < 10000 ? 1 : 0
  return (ms / 1000).toFixed(decimals) + 's'
}

export function fmtDur(sec: number): string {
  if (Number.isNaN(sec)) return '—'
  // 先取整再拆分，否则 59.6 会显示成 "60s"、3599.6 会显示成 "59m"
  const s = Math.round(sec)
  if (s < 60) return s + 's'
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const r = s % 60
    return m + 'm' + (r ? r + 's' : '')
  }
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h + 'h' + m + 'm'
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

export function fmtTime(ms: number): string {
  if (ms <= 0) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 图表两行刻度：第一行时刻（无秒），第二行月/日
export function fmtTimeTick(ms: number): string {
  if (ms <= 0) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}\n${d.getMonth() + 1}/${d.getDate()}`
}

export function fmtDayTick(ms: number): string {
  if (ms <= 0) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function fmtTimeFull(ms: number): string {
  if (ms <= 0) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function relTime(ms: number): string {
  if (ms <= 0) return '—'
  const diff = (Date.now() - ms) / 1000
  if (diff < 60) return Math.round(diff) + 's 前'
  if (diff < 3600) return Math.floor(diff / 60) + 'm 前'
  if (diff < 86400) return Math.floor(diff / 3600) + 'h 前'
  return Math.floor(diff / 86400) + 'd 前'
}

export function shortId(id: string, n = 8): string {
  return id ? id.slice(0, n) : '—'
}

export function truncateWs(s: string, n: number): string {
  if (!s) return ''
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// 速度分层着色：<20 红 / 20–100 黄 / >100 绿；0 = 无效
export function speedTier(tps: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(tps)) return 0
  if (tps < 20) return 1
  if (tps <= 100) return 2
  return 3
}

export const TIER_COLOR = ['', '#ef4444', '#eab308', '#22c55e'] as const

export function speedColor(tps: number): string {
  return TIER_COLOR[speedTier(tps)]
}

export function fmtTps(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return '—'
  return (tps >= 100 ? Math.round(tps) : tps.toFixed(1)) + ' t/s'
}
