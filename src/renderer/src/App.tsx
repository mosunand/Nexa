// App.tsx — 应用外壳：标题栏（拖拽区 + 品牌 + 导航 + 健康状态 + 实时胶囊 +
// 设置/主题/氛围开关）、页面栈、快捷键、扫描错误 toast。

import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import logoUrl from './assets/logo.ico'
import { agentColor, agentName, registerAgentMeta } from './lib/colors'
import { fmtTps, relTime } from './lib/format'
import { useNexaEvent } from './lib/data'
import { useTheme } from './lib/theme'
import { Badge } from './components/ui'
import { OverviewPage } from './pages/OverviewPage'
import { StatsPage } from './pages/StatsPage'
import { ReplayPage } from './pages/ReplayPage'
import { SessionsPage } from './pages/SessionsPage'
import { InsightsPage } from './pages/InsightsPage'
import { DiagnosticsPage } from './pages/DiagnosticsPage'
import { ModelsPage } from './pages/ModelsPage'
import { RawPage } from './pages/RawPage'
import { SourcesPage } from './pages/SourcesPage'
import { SettingsDialog } from './components/SettingsDialog'
import { CommandPalette } from './components/CommandPalette'
import type { AgentStatus, UsageRecord } from '@shared/types'

type PageId = 'overview' | 'stats' | 'replay' | 'sessions' | 'insights' | 'diagnostics' | 'models' | 'raw' | 'sources'

// 页面组件全部 memo：健康状态每 2s 刷新时只有顶栏重渲染，页面树归零
const MemoPages: Record<PageId, React.ComponentType> = {
  overview: memo(OverviewPage),
  stats: memo(StatsPage),
  replay: memo(ReplayPage),
  sessions: memo(SessionsPage),
  insights: memo(InsightsPage),
  diagnostics: memo(DiagnosticsPage),
  models: memo(ModelsPage),
  raw: memo(RawPage),
  sources: memo(SourcesPage)
}

const NAV: Array<{ id: PageId; icon: string; label: string }> = [
  { id: 'overview', icon: '◉', label: '实时监控' },
  { id: 'stats', icon: '◎', label: '使用统计' },
  { id: 'replay', icon: '▷', label: '一日重放' },
  { id: 'sessions', icon: '▤', label: '会话' },
  { id: 'insights', icon: '✦', label: '项目洞察' },
  { id: 'diagnostics', icon: '◈', label: '体检' },
  { id: 'models', icon: '◇', label: '模型用量' },
  { id: 'raw', icon: '≡', label: '原始数据' },
  { id: 'sources', icon: '▦', label: '数据源' }
]

export default function App(): ReactNode {
  const { theme, aurora, toggleTheme, toggleAurora } = useTheme()
  const [page, setPage] = useState<PageId>('overview')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [statuses, setStatuses] = useState<AgentStatus[]>([])
  const [scanErr, setScanErr] = useState('')
  const [scanMs, setScanMs] = useState(0)
  const [toast, setToast] = useState('')

  // 健康状态：每拍扫描后刷新（内容没变就不 setState，避免无谓重渲染）
  const refreshHealth = useCallback((): void => {
    void window.nexa.agentStatuses().then((next) => {
      setStatuses((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (p, i) =>
              p.id === next[i]?.id &&
              p.found === next[i]?.found &&
              p.sessions === next[i]?.sessions &&
              p.note === next[i]?.note &&
              p.lastActivityMs === next[i]?.lastActivityMs &&
              p.dataDir === next[i]?.dataDir
          )
        ) {
          return prev
        }
        // 自定义 agent 的名称/颜色注册进查找表（各页面 agentName/agentColor 用）
        for (const s of next) registerAgentMeta(s.id, s.name, s.color)
        return next
      })
    })
  }, [])

  useNexaEvent('scanFinished', (r) => {
    setScanMs(r.scanMs)
    setScanErr(r.ok ? '' : r.err)
    refreshHealth()
  })

  // 数据服务不可用（worker 重试耗尽）—— 全局提示
  useNexaEvent('workerDead', () => {
    setToast('数据服务异常退出（已自动重试 3 次）—— 请重启应用；本地数据不受影响')
  })

  // 扫描失败 → 顶栏红色徽章 + toast（与老项目同语义：下一拍自动重试）
  useEffect(() => {
    if (scanErr) setToast('扫描失败：' + scanErr + '（下一拍自动重试）')
  }, [scanErr])
  // toast 自动消失，不留常驻遮挡
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 6000)
    return () => clearTimeout(t)
  }, [toast])

  // 实时速度胶囊：有新响应时浮现
  const [capsule, setCapsule] = useState<{ tps: number; agent: string; time: number } | null>(null)
  useNexaEvent('newRecords', (records: UsageRecord[]) => {
    const measurable = records.filter((r) => r.tpsOk)
    if (measurable.length === 0) return
    // 加权均速
    const gen = measurable.reduce((s, r) => s + r.outputTokens + r.reasoningTokens, 0)
    const dur = measurable.reduce((s, r) => s + r.durationMs, 0)
    if (dur <= 0) return
    setCapsule({ tps: gen / (dur / 1000), agent: measurable[measurable.length - 1]!.agentId, time: Date.now() })
    refreshHealth()
  })
  useEffect(() => {
    if (!capsule) return
    const t = setTimeout(() => setCapsule(null), 4000)
    return () => clearTimeout(t)
  }, [capsule])

  // 快捷键 Ctrl+1..9 / Ctrl+K 命令面板 / T 主题
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        setPage(NAV[Number(e.key) - 1]!.id)
      } else if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 't' || e.key === 'T')) {
        // 输入框/下拉聚焦时不切主题
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') toggleTheme()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleTheme])

  // 命令面板/外部事件跳转
  useEffect(() => {
    const onOpenSession = (): void => setPage('sessions')
    const onOpenPage = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail as PageId
      if (NAV.some((n) => n.id === id)) setPage(id)
    }
    window.addEventListener('nexa:open-session', onOpenSession)
    window.addEventListener('nexa:open-page', onOpenPage)
    return () => {
      window.removeEventListener('nexa:open-session', onOpenSession)
      window.removeEventListener('nexa:open-page', onOpenPage)
    }
  }, [])

  useEffect(refreshHealth, [refreshHealth])

  const detected = useMemo(() => statuses.filter((s) => s.found), [statuses])
  const totalSessions = useMemo(() => detected.reduce((s, x) => s + x.sessions, 0), [detected])
  const lastActivity = useMemo(() => Math.max(0, ...statuses.map((s) => s.lastActivityMs)), [statuses])

  return (
    <div className="relative flex h-full flex-col">
      {aurora && (
        <div className="aurora">
          <div className="blob" />
        </div>
      )}

      {/* ── 标题栏（右侧预留原生最小化/最大化/关闭按钮区，避免内容顶到系统控件下面） ── */}
      <header className="drag relative z-20 flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel/60 pl-3 pr-[148px] backdrop-blur-xl">
        {/* 品牌 */}
        <div className="mr-2 flex items-center gap-2">
          <img src={logoUrl} alt="Nexa" className="h-4 w-4" draggable={false} />
          <span className="text-sm font-bold tracking-wide text-ink">
            Nexa
            <span className="ml-1.5 text-[10px] font-medium text-faint">agent monitor</span>
          </span>
        </div>

        {/* 导航（激活态渐变胶囊 + 辉光） */}
        <nav className="no-drag flex items-center gap-1">
          {NAV.map((n) => {
            const on = page === n.id
            return (
              <button
                key={n.id}
                onClick={() => setPage(n.id)}
                className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
                  on ? 'text-white shadow-[0_2px_12px_-2px_rgb(129_140_248/0.5)]' : 'text-muted hover:bg-panel-2/60 hover:text-soft'
                }`}
                style={on ? { background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' } : undefined}
                title={`Ctrl+${NAV.indexOf(n) + 1}`}
              >
                <span className="mr-1 text-[11px]" style={{ color: on ? 'rgb(255 255 255 / 0.85)' : 'var(--faint)' }}>
                  {n.icon}
                </span>
                {n.label}
              </button>
            )
          })}
        </nav>

        <div className="flex-1" />

        {/* 健康状态 */}
        <div
          className="no-drag mr-1 hidden shrink-0 items-center gap-2 text-[11px] text-faint 2xl:flex"
          title={statuses
            .map((s) => `${s.name}：${s.found ? `${s.sessions} 会话 · ${relTime(s.lastActivityMs)}` : '未检测'}`)
            .join('\n')}
        >
          <span>
            {detected.length}/{statuses.length} agent · {totalSessions} 会话
          </span>
          <span className="text-line-strong">|</span>
          <span>扫描 {scanMs}ms</span>
        </div>

        {/* 实时速度胶囊 */}
        {capsule && (
          <div className="no-drag page-enter mr-1 flex shrink-0 items-center gap-1.5 rounded-full border border-ok/30 bg-ok/10 px-2.5 py-1">
            <span className="pulse-dot" />
            <span className="font-mono text-xs font-semibold" style={{ color: 'var(--ok)' }}>
              {fmtTps(capsule.tps)}
            </span>
            <span className="text-[10px]" style={{ color: agentColor(capsule.agent) }}>
              {agentName(capsule.agent)}
            </span>
          </div>
        )}

        {scanErr && <span className="shrink-0"><Badge tone="bad">扫描失败</Badge></span>}

        {/* 操作区（SVG 图标 —— 不依赖系统字形，杜绝豆腐块） */}
        <div className="no-drag flex shrink-0 items-center gap-1.5 pr-2">
          <IconBtn label="设置（归档保留期）" onClick={() => setSettingsOpen(true)}>
            <Icon d={ICON_GEAR} />
          </IconBtn>
          <IconBtn label={aurora ? '氛围光晕：开' : '氛围光晕：关'} onClick={toggleAurora} on={aurora}>
            <Icon d={ICON_FROST} />
          </IconBtn>
          <IconBtn label="切换深/浅主题（T）" onClick={toggleTheme}>
            <Icon d={theme === 'dark' ? ICON_MOON : ICON_SUN} />
          </IconBtn>
        </div>
      </header>

      {/* ── 页面栈（key 切换重挂载，滚动自然归零；切勿用内联 ref 归零 —— 每次 App 重渲染都会把用户按回顶部） ── */}
      <main className="no-drag relative z-10 min-h-0 flex-1 overflow-hidden">
        <div key={page} className="page-enter h-full overflow-auto p-4">
          {(() => {
            const Page = MemoPages[page]
            return <Page />
          })()}
        </div>
      </main>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        pages={NAV.map((n) => ({ id: n.id, label: n.label, icon: n.icon, run: () => setPage(n.id) }))}
      />

      {/* toast */}
      {toast && (
        <div
          className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 cursor-pointer rounded-xl border border-bad/30 bg-panel px-4 py-2.5 text-sm text-bad shadow-lg backdrop-blur"
          onClick={() => setToast('')}
        >
          {toast}
        </div>
      )}
    </div>
  )
}

// ── 内联 SVG 图标（stroke 风格，避免系统字体缺字形的豆腐块） ──

function Icon({ d, size = 14 }: { d: string; size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

const ICON_GEAR =
  'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6'
const ICON_FROST =
  'M2 12h20 M12 2v20 M20 16l-4-4 4-4 M4 8l4 4-4 4 M16 4l-4 4-4-4 M8 20l4-4 4 4'
const ICON_MOON = 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'
const ICON_SUN =
  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M6.34 17.66l-1.41 1.41 M19.07 4.93l-1.41 1.41'

function IconBtn({ children, label, onClick, on = true }: { children: ReactNode; label: string; onClick: () => void; on?: boolean }): ReactNode {
  return (
    <button
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-panel-2 hover:text-ink"
      style={{ opacity: on ? 1 : 0.4 }}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
