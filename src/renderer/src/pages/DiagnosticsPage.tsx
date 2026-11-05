// pages/DiagnosticsPage.tsx — 体检 · ZCode 源库深检：
//   ① 首字延迟（TTFT）体检 —— P50/P90 按模型排行
//   ② 安全审计 —— 破坏性操作 / 失败调用 / 最近危险清单
//   ③ 重试账单 —— 重试次数与白烧的 token
// 数据直读 ZCode 源库（源库自带保留期 —— 这里看的是现状诊断，不是历史统计）。

import { useState, type ReactNode } from 'react'
import type { TimeWindow, ZcodeDiagnostics } from '@shared/types'
import { useAsync, useDataTick } from '../lib/data'
import { modelColor } from '../lib/colors'
import { Badge, Card, CardTitle, Empty, KpiCard, RatioBar } from '../components/ui'
import { fmtInt, fmtMs, fmtNumCn, fmtTimeFull } from '../lib/format'

const WINDOWS: Array<{ id: TimeWindow; label: string; ms: number }> = [
  { id: '7d', label: '近 7 天', ms: 7 * 86_400_000 },
  { id: '30d', label: '近 30 天', ms: 30 * 86_400_000 },
  { id: 'all', label: '全部', ms: 0 }
]

export function DiagnosticsPage(): ReactNode {
  const [win, setWin] = useState(WINDOWS[0]!)
  const tick = useDataTick()
  const since = win.ms > 0 ? Date.now() - win.ms : 0
  const diag = useAsync<ZcodeDiagnostics>(() => window.nexa.zcodeDiagnostics(since), [win.id, tick])

  const d = diag.data
  const maxTtft = d ? Math.max(1, ...d.ttft.map((t) => t.p90Ms)) : 1
  const totalToolCalls = d ? d.tools.reduce((s, t) => s + t.calls, 0) : 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-ink">体检</h2>
          <span className="text-xs text-faint">ZCode 源库深检 · 首字延迟 / 安全审计 / 重试账单</span>
        </div>
        <div className="seg">
          {WINDOWS.map((w) => (
            <button key={w.id} className={win.id === w.id ? 'on' : ''} onClick={() => setWin(w)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {diag.loading && !d ? (
        <Empty text="" loading />
      ) : !d?.available ? (
        <Card>
          <Empty text="未检测到 ZCode 源库 —— 装好 ZCode 跑一次后自动可用" />
        </Card>
      ) : (
        <>
          {/* ① 首字延迟 */}
          <Card pad={false} className="overflow-hidden">
            <div className="px-5 pt-4">
              <CardTitle right={<Badge tone="accent">越低越好</Badge>}>
                首字延迟（TTFT）· 按模型
              </CardTitle>
            </div>
            {d.ttft.length === 0 ? (
              <div className="pb-6">
                <Empty text="窗口内没有 TTFT 样本" />
              </div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th className="num">样本</th>
                    <th className="num">均值</th>
                    <th className="num">P50</th>
                    <th className="num">P90</th>
                    <th className="w-52">P90 分布</th>
                  </tr>
                </thead>
                <tbody>
                  {d.ttft.map((t) => (
                    <tr key={t.model}>
                      <td className="max-w-56 truncate font-medium text-ink" title={t.model}>
                        <span
                          className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ background: modelColor(t.model) }}
                        />
                        {t.model}
                      </td>
                      <td className="num">{fmtInt(t.count)}</td>
                      <td className="num">{fmtMs(t.avgMs)}</td>
                      <td className="num font-semibold">{fmtMs(t.p50Ms)}</td>
                      <td className="num" style={{ color: t.p90Ms > 5000 ? 'var(--warn)' : undefined }}>
                        {fmtMs(t.p90Ms)}
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <RatioBar ratio={t.p90Ms} total={maxTtft} color="#22d3ee" />
                          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-faint">
                            {Math.round((t.p90Ms / maxTtft) * 100)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="px-5 pb-3 text-[11px] text-faint">
              P90 &gt; 5s 标黄 —— 首字慢通常不是生成慢，是排队/冷启动。买车看零百，用模型看首字。
            </div>
          </Card>

          {/* ② 安全审计 */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-bold text-ink">安全审计</h3>
              <span className="text-xs text-faint">你的 agent 替你执行过什么危险操作、失败过几次</span>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <KpiCard
                label="破坏性操作"
                value={fmtInt(d.destructiveCalls)}
                sub={`共 ${fmtInt(totalToolCalls)} 次工具调用`}
                bar={{ ratio: totalToolCalls > 0 ? d.destructiveCalls / totalToolCalls : 0, color: 'var(--bad)' }}
              />
              <KpiCard
                label="失败调用（exit≠0）"
                value={fmtInt(d.failedCalls)}
                sub="工具退出码非零的调用次数"
                bar={{ ratio: totalToolCalls > 0 ? d.failedCalls / totalToolCalls : 0, color: 'var(--warn)' }}
              />
              <KpiCard label="上下文超限" value={fmtInt(d.contextExceeded)} sub="context_exceeded 标记的响应" />
              <KpiCard
                label="重试请求"
                value={fmtInt(d.retriedCalls)}
                sub={`重试 ${fmtInt(d.retryCount)} 次 · 烧掉 ${fmtNumCn(d.wastedTokens)} tok`}
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-4">
              <Card pad={false} className="overflow-hidden">
                <div className="px-5 pt-4">
                  <CardTitle>工具安全画像（Top 12）</CardTitle>
                </div>
                {d.tools.length === 0 ? (
                  <div className="pb-6">
                    <Empty text="窗口内没有工具调用" />
                  </div>
                ) : (
                  <table className="data">
                    <thead>
                      <tr>
                        <th>工具</th>
                        <th className="num">调用</th>
                        <th className="num">破坏性</th>
                        <th className="num">失败</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.tools.map((t) => (
                        <tr key={t.tool}>
                          <td className="font-mono text-xs text-soft">{t.tool}</td>
                          <td className="num">{fmtInt(t.calls)}</td>
                          <td className="num">{t.destructive > 0 ? <span className="font-semibold text-bad">{fmtInt(t.destructive)}</span> : '0'}</td>
                          <td className="num">{t.failed > 0 ? <span className="text-warn">{fmtInt(t.failed)}</span> : '0'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              <Card pad={false} className="overflow-hidden">
                <div className="px-5 pt-4">
                  <CardTitle right={<Badge tone="bad">最近 20 条</Badge>}>危险调用清单</CardTitle>
                </div>
                {d.recentDangerous.length === 0 ? (
                  <div className="pb-6">
                    <Empty text="✓ 窗口内没有破坏性或失败的调用" />
                  </div>
                ) : (
                  <div className="max-h-64 overflow-auto">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>时间</th>
                          <th>工具</th>
                          <th>状态</th>
                          <th className="num">exit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.recentDangerous.map((r, i) => (
                          <tr key={i}>
                            <td className="text-faint">{fmtTimeFull(r.timeMs)}</td>
                            <td className="font-mono text-xs">{r.tool}</td>
                            <td className="text-xs text-warn">{r.status}</td>
                            <td className="num">{r.exitCode !== 0 ? <span className="text-bad">{r.exitCode}</span> : '0'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          </div>

          {/* ③ 重试账单 */}
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardTitle right={<Badge tone="warn">白烧的 token</Badge>}>重试账单</CardTitle>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-muted">重试请求数</div>
                  <div className="mt-0.5 text-2xl font-bold text-ink">{fmtInt(d.retriedCalls)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">重试总次数</div>
                  <div className="mt-0.5 text-2xl font-bold text-ink">{fmtInt(d.retryCount)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">重试消耗</div>
                  <div className="mt-0.5 text-2xl font-bold text-warn">{fmtNumCn(d.wastedTokens)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">占窗口请求比</div>
                  <div className="mt-0.5 text-2xl font-bold text-ink">
                    {d.retriedCalls > 0 ? ((d.retriedCalls / Math.max(1, d.retriedCalls + d.ttft.reduce((s, t) => s + t.count, 0))) * 100).toFixed(1) + '%' : '0%'}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-faint">
                重试 = 同一请求至少发起两次 —— 第一次白烧。这个数字是网络抖动/服务降级/上下文超限的诚实账单。
              </p>
            </Card>
            <Card pad={false} className="overflow-hidden">
              <div className="px-5 pt-4">
                <CardTitle>错误类型分布</CardTitle>
              </div>
              {d.topErrors.length === 0 ? (
                <div className="pb-6">
                  <Empty text="窗口内没有错误记录" />
                </div>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>错误类型</th>
                      <th className="num">次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.topErrors.map((e) => (
                      <tr key={e.type}>
                        <td className="font-mono text-xs text-soft">{e.type}</td>
                        <td className="num font-semibold text-bad">{fmtInt(e.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <div className="pb-2 text-center text-[11px] text-faint">
            数据直读 ZCode 源库（只读）· 源库自带保留期，窗口外的历史可能已被 ZCode 自身清理
          </div>
        </>
      )}
    </div>
  )
}
