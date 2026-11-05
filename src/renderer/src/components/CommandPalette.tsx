// components/CommandPalette.tsx — ⌘K / Ctrl+K 命令面板：
// 页面跳转 + 会话搜索 + 项目搜索，键盘驱动（↑↓ 选择 / Enter 执行 / Esc 关闭）。

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectStat, SessionInfo } from '@shared/types'
import { agentColor, agentName } from '../lib/colors'
import { Empty } from './ui'

export interface PaletteItem {
  id: string
  group: string
  label: string
  sub?: string
  color?: string
  run: () => void
}

export function CommandPalette({
  open,
  onClose,
  pages
}: {
  open: boolean
  onClose: () => void
  pages: Array<{ id: string; label: string; icon: string; run: () => void }>
}): ReactNode {
  const [q, setQ] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [projects, setProjects] = useState<ProjectStat[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    setActive(0)
    inputRef.current?.focus()
    // 项目列表：打开时取一次（用于匹配）
    void window.nexa.projectStats(0).then(setProjects).catch(() => {})
  }, [open])

  // 会话搜索（防抖）
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      if (!q.trim()) {
        setSessions([])
        return
      }
      void window.nexa
        .sessionList({ agent: '', search: q.trim(), limit: 6 })
        .then(setSessions)
        .catch(() => setSessions([]))
    }, 180)
    return () => clearTimeout(t)
  }, [q, open])

  const ql = q.trim().toLowerCase()
  const pageItems: PaletteItem[] = pages
    .filter((p) => !ql || p.label.toLowerCase().includes(ql))
    .map((p) => ({ id: 'p-' + p.id, group: '页面', label: p.label, sub: '跳转', run: p.run }))

  const sessionItems: PaletteItem[] = sessions.map((s) => ({
    id: 's-' + s.agentId + s.sessionId,
    group: '会话',
    label: s.title || s.sessionId,
    sub: `${agentName(s.agentId)} · ${s.cwd}`,
    color: agentColor(s.agentId),
    run: () => {
      window.dispatchEvent(
        new CustomEvent('nexa:open-session', { detail: { agent: s.agentId, sessionId: s.sessionId } })
      )
    }
  }))

  const projectItems: PaletteItem[] = projects
    .filter((p) => ql && (p.name.toLowerCase().includes(ql) || p.project.toLowerCase().includes(ql)))
    .slice(0, 5)
    .map((p) => ({
      id: 'pr-' + p.project,
      group: '项目',
      label: p.name,
      sub: p.project,
      run: () => {
        window.dispatchEvent(new CustomEvent('nexa:open-page', { detail: 'insights' }))
      }
    }))

  const items: PaletteItem[] = [...pageItems, ...projectItems, ...sessionItems]
  const clamped = Math.min(active, Math.max(0, items.length - 1))

  const exec = (item: PaletteItem | undefined): void => {
    if (!item) return
    item.run()
    onClose()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => Math.min(items.length - 1, a + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => Math.max(0, a - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        exec(items[Math.min(active, Math.max(0, items.length - 1))])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, active])

  if (!open) return null

  let lastGroup = ''
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="card w-[560px] overflow-hidden page-enter">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-faint">🔍</span>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
            placeholder="搜索页面 / 会话 / 项目…（↑↓ 选择，Enter 打开，Esc 关闭）"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
          />
          <span className="chip font-mono text-[10px]">Ctrl+K</span>
        </div>
        <div className="max-h-80 overflow-auto py-1">
          {items.length === 0 ? (
            <div className="py-6">
              <Empty text={ql ? '没有匹配结果' : '输入关键字开始搜索'} />
            </div>
          ) : (
            items.map((it, i) => {
              const showGroup = it.group !== lastGroup
              lastGroup = it.group
              return (
                <div key={it.id}>
                  {showGroup && <div className="px-4 pb-0.5 pt-2 text-[10px] font-medium text-faint">{it.group}</div>}
                  <button
                    className={`flex w-full cursor-pointer items-center gap-2.5 px-4 py-1.5 text-left transition-colors ${
                      i === clamped ? 'bg-accent/15' : 'hover:bg-panel-2'
                    }`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => exec(it)}
                  >
                    {it.color ? (
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: it.color }} />
                    ) : (
                      <span className="w-2 shrink-0" />
                    )}
                    <span className="truncate text-sm text-ink">{it.label}</span>
                    {it.sub && <span className="ml-auto max-w-56 truncate text-[11px] text-faint">{it.sub}</span>}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
