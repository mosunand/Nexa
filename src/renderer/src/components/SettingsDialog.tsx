// components/SettingsDialog.tsx — 设置：归档保留天数（30–3650）+ 自定义
// agent 数据目录管理（自写 agent 手动登记：目录 + 名称 + 格式模板）。

import { useEffect, useState, type ReactNode } from 'react'
import { Modal } from './ui'
import { useAsync } from '../lib/data'
import { fmtTimeFull } from '../lib/format'
import { CUSTOM_AGENT_FORMATS, type CustomAgentConfig } from '@shared/types'
import type { AppSettings, ArchiveInfo } from '@shared/types'

function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return 'custom-' + (slug || 'agent')
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const [settings, setSettings] = useState<AppSettings>({
    retentionDays: 730,
    theme: 'dark',
    customAgents: [],
    digestEnabled: true,
    digestTime: '21:00'
  })
  const [digestOn, setDigestOn] = useState(true)
  const [digestTime, setDigestTime] = useState('21:00')
  const [mergeMsg, setMergeMsg] = useState('')
  const [days, setDays] = useState(730)
  const [draft, setDraft] = useState<CustomAgentConfig[]>([])
  const [dirty, setDirty] = useState(false)
  const [applied, setApplied] = useState(false)
  const cutoff = Date.now() - days * 86_400_000 // 生效预览
  const archive = useAsync<ArchiveInfo>(() => window.nexa.archiveInfo(), [open], open)

  useEffect(() => {
    if (!open) return
    void window.nexa.getSettings().then((s) => {
      setSettings(s)
      setDays(s.retentionDays)
      setDraft(s.customAgents ?? [])
      setDirty(false)
      setDigestOn(s.digestEnabled !== false)
      setDigestTime(s.digestTime || '21:00')
      setMergeMsg('')
    })
  }, [open])

  const commitDays = (v: number): void => {
    setDays(v)
    void window.nexa.setSettings({ retentionDays: v })
    void archive.reload()
  }

  const applyCustom = (): void => {
    const list = draft.map((d) => ({ ...d, id: slugId(d.name) }))
    void window.nexa.setSettings({ customAgents: list })
    setDraft(list)
    setDirty(false)
    setApplied(true)
    setTimeout(() => setApplied(false), 2500)
  }

  const addAgent = async (replaceIdx?: number): Promise<void> => {
    const dir = await window.nexa.pickDirectory()
    if (!dir) return
    if (replaceIdx !== undefined) {
      patchRow(replaceIdx, { dir })
      return
    }
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || 'my-agent'
    setDraft((d) => [...d, { id: slugId(name), name, dir, format: 'generic' }])
    setDirty(true)
  }

  const patchRow = (idx: number, patch: Partial<CustomAgentConfig>): void => {
    setDraft((d) => d.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
    setDirty(true)
  }

  return (
    <Modal open={open} onClose={onClose} title="设置">
      <div className="space-y-5">
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <label className="text-sm font-medium text-ink">历史归档保留天数</label>
            <span className="font-mono text-lg font-semibold text-accent">{days}</span>
          </div>
          <input
            type="range"
            min={30}
            max={3650}
            step={10}
            value={days}
            className="w-full accent-[var(--accent)]"
            onChange={(e) => setDays(Number(e.target.value))}
            onMouseUp={(e) => commitDays(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commitDays(Number((e.target as HTMLInputElement).value))}
          />
          <div className="mt-1 flex justify-between text-[11px] text-faint">
            <span>30 天</span>
            <span>3650 天</span>
          </div>
          <p className="mt-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
            生效后将保留 <span className="font-medium text-ink">{fmtTimeFull(cutoff)}</span>{' '}
            之后的数据；更早的归档条目在下次合并时清除（默认 730 天）。
          </p>
        </div>

        {/* ── 自定义 agent ── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-ink">自定义 agent</label>
            <button className="btn h-7 px-2.5 text-xs" onClick={() => void addAgent()}>
              ＋ 选择目录添加
            </button>
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-faint">
            自写 agent 的数据目录无法自动探测 —— 在这里登记。递归扫描目录下的
            .jsonl / .json / .zst 文件；格式选「通用 JSONL」会自动识别各家 usage
            字段（in/out、input_tokens/output_tokens 等），识别不到用量的文件不计入统计。
          </p>
          {draft.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-xs text-faint">
              还没有自定义 agent —— 点上方按钮选择数据目录
            </div>
          ) : (
            <div className="space-y-2">
              {draft.map((row, idx) => (
                <div key={idx} className="rounded-lg border border-line bg-panel-2 p-2.5">
                  <div className="flex items-center gap-2">
                    <div className="min-w-[200px] flex-1">
                      <input
                        className="input h-7 w-full text-xs"
                        value={row.name}
                        placeholder="显示名"
                        onChange={(e) => patchRow(idx, { name: e.target.value })}
                      />
                    </div>
                    <select
                      className="input h-7 w-44 shrink-0 text-xs"
                      value={row.format}
                      onChange={(e) => patchRow(idx, { format: e.target.value as CustomAgentConfig['format'] })}
                    >
                      {CUSTOM_AGENT_FORMATS.map((fm) => (
                        <option key={fm.id} value={fm.id}>
                          {fm.label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn h-7 shrink-0 whitespace-nowrap px-2 text-xs text-bad"
                      onClick={() => {
                        setDraft((d) => d.filter((_, i) => i !== idx))
                        setDirty(true)
                      }}
                    >
                      删除
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{row.dir}</span>
                    <button className="btn h-6 shrink-0 whitespace-nowrap px-2 text-[11px]" onClick={() => void addAgent(idx)}>
                      换目录
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            {applied && <span className="text-xs text-ok">已应用，下一拍自动扫描 ✓</span>}
            <button className="btn btn-accent h-7 px-3 text-xs" disabled={!dirty} onClick={applyCustom}>
              应用自定义 agent
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-xs text-muted">
          <div className="mb-1 font-medium text-ink">自有归档</div>
          <div>
            条目数：<span className="font-mono text-ink">{archive.data?.entries ?? '…'}</span>
          </div>
          <div className="mt-0.5 break-all">
            路径：<span className="font-mono">{archive.data?.path ?? '…'}</span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              className="btn h-7 px-2.5 text-xs"
              onClick={async () => {
                const p = await window.nexa.pickArchive()
                if (!p) return
                const r = await window.nexa.mergeArchiveFile(p)
                setMergeMsg(`已合并 ${r.added} 条新条目，归档现共 ${r.total} 条`)
                void archive.reload()
              }}
            >
              合并另一台机器的归档
            </button>
            {mergeMsg && <span className="text-[11px] text-ok">{mergeMsg}</span>}
          </div>
        </div>

        {/* ── 托盘日报 ── */}
        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="shrink-0 whitespace-nowrap text-xs font-medium text-ink">托盘日报</div>
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted">
              <input
                type="checkbox"
                checked={digestOn}
                className="accent-[var(--accent)]"
                onChange={(e) => {
                  setDigestOn(e.target.checked)
                  void window.nexa.setSettings({ digestEnabled: e.target.checked })
                }}
              />
              每日推送
            </label>
            <input
              type="time"
              className="input h-7 w-24 text-xs"
              value={digestTime}
              disabled={!digestOn}
              onChange={(e) => {
                setDigestTime(e.target.value)
                void window.nexa.setSettings({ digestTime: e.target.value })
              }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-faint">
            每天到点弹一条本地通知：今天多少 token、较昨日涨跌、主力模型占多少（纯本地，零网络）。
          </p>
        </div>

        <p className="text-xs leading-relaxed text-faint">
          全程只读、全程离线：Nexa 只读解析各 agent 的本地会话数据，不修改任何文件、
          不发起任何网络请求。仅写入三处自有数据：缓存库（cache.sqlite）、历史归档
          （usage-archive.bin）与设置文件，全部可随时删除并自动重建。
        </p>
      </div>
    </Modal>
  )
}
