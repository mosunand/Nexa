// components/ui.tsx — 共享 UI 原语：卡片、KPI 卡、比例条、徽章、空态、对话框。

import { useEffect, type ReactNode } from 'react'
import { fmtInt } from '../lib/format'

// ── 卡片 ──

export function Card({ children, className = '', pad = true }: { children: ReactNode; className?: string; pad?: boolean }): ReactNode {
  return <div className={`card ${pad ? 'card-pad' : ''} ${className}`}>{children}</div>
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-ink">{children}</h3>
      {right}
    </div>
  )
}

// ── 渐变数字（大卡 KPI 值的质感） ──

export function GradientNum({ children }: { children: ReactNode }): ReactNode {
  return (
    <span
      className="bg-clip-text text-transparent"
      style={{ backgroundImage: 'linear-gradient(120deg, var(--accent) 20%, var(--accent-2))' }}
    >
      {children}
    </span>
  )
}

// ── KPI 卡 ──

export function KpiCard({
  label,
  value,
  sub,
  bar,
  accentTop = false,
  large = false,
  children,
  title,
  className = ''
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  bar?: { ratio: number; color?: string } // 0..1 进度条
  accentTop?: boolean
  large?: boolean
  children?: ReactNode
  title?: string
  className?: string
}): ReactNode {
  return (
    <div className={`card relative overflow-hidden px-4 py-3.5 ${className}`} title={title}>
      {accentTop && (
        <div
          className="absolute inset-x-0 top-0 h-[3px]"
          style={{ background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' }}
        />
      )}
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 font-semibold tabular-nums ${large ? 'text-3xl' : 'text-xl'} text-ink`}>{value}</div>
      {bar && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(100, Math.max(2, bar.ratio * 100))}%`,
              background: bar.color ?? 'linear-gradient(90deg, var(--accent), var(--accent-2))'
            }}
          />
        </div>
      )}
      {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
      {children}
    </div>
  )
}

// ── 比例条（条长即占比） ──

export function RatioBar({ ratio, color, total = 1 }: { ratio: number; color: string; total?: number }): ReactNode {
  const pct = total > 0 ? (ratio / total) * 100 : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/70">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(1.5, pct))}%`, background: color, opacity: 0.85 }}
      />
    </div>
  )
}

// ── agent 色点 + 名称 ──

export function AgentTag({ id, name, color, size = 8 }: { id?: string; name: string; color: string; size?: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5" title={id}>
      <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color }} />
      <span className="text-xs font-medium" style={{ color }}>
        {name}
      </span>
    </span>
  )
}

// ── 徽章（数值胶囊） ──

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'bad' | 'accent' }): ReactNode {
  const tones: Record<string, string> = {
    default: 'border-line bg-panel-2 text-muted',
    ok: 'border-ok/30 bg-ok/10 text-ok',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    bad: 'border-bad/30 bg-bad/10 text-bad',
    accent: 'border-accent/30 bg-accent/10 text-accent'
  }
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
}

// ── 空态 / 加载态 ──

export function Empty({ text, loading = false }: { text: string; loading?: boolean }): ReactNode {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-sm text-faint">
      {loading ? (
        <>
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-accent" />
          <span>加载中…</span>
        </>
      ) : (
        <>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="opacity-40">
            <path d="M3 12h4l2-6 4 12 2-6h6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{text}</span>
        </>
      )}
    </div>
  )
}

// ── 模态对话框 ──

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  wide?: boolean
}): ReactNode {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-8 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`card flex max-h-full flex-col overflow-hidden ${wide ? 'w-[860px]' : 'w-[620px]'} page-enter`}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="min-w-0 text-sm font-semibold text-ink">{title}</div>
          <button
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint transition-colors hover:bg-panel-2 hover:text-ink"
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
      </div>
    </div>
  )
}

// ── 复制按钮 ──

export function CopyBtn({ text, label = '复制' }: { text: string; label?: string }): ReactNode {
  return (
    <button
      className="btn h-7 px-2 text-xs"
      onClick={() => {
        void navigator.clipboard.writeText(text).catch(() => {
          /* 剪贴板权限被拒 —— 静默忽略，不产生未处理 rejection */
        })
        const el = document.activeElement as HTMLButtonElement
        if (el) {
          const old = el.textContent
          el.textContent = '已复制 ✓'
          setTimeout(() => {
            el.textContent = old
          }, 1200)
        }
      }}
    >
      {label}
    </button>
  )
}

// ── 数字动画（KPI 值滚动） ──

export function Rolling({ value, fmt = fmtInt }: { value: number; fmt?: (n: number) => string }): ReactNode {
  return (
    <span key={value} className="inline-block animate-[page-in_.5s_ease]">
      {fmt(value)}
    </span>
  )
}
