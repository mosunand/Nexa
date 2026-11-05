// main/index.ts — Electron 主进程：窗口（无边框 + 原生控制按钮）、
// 设置持久化（JSON）、worker RPC ↔ 渲染端 IPC 的双向枢纽。
// 网络承诺延续老项目：零网络请求，观测器不是代理。

import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell, Tray } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { CustomAgentConfig } from '@shared/types'

// ── 设置（userData/nexa-settings.json —— 全部自有数据的三处写点之一） ──

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface Settings {
  retentionDays: number
  bounds: WindowBounds | null
  theme: 'dark' | 'light'
  customAgents: CustomAgentConfig[]
  digestEnabled: boolean
  digestTime: string // 'HH:MM'
}

const DEFAULTS: Settings = {
  retentionDays: 730,
  bounds: null,
  theme: 'dark',
  customAgents: [],
  digestEnabled: true,
  digestTime: '21:00'
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'nexa-settings.json')
}

function loadSettings(): Settings {
  try {
    if (existsSync(settingsPath())) {
      const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
      return { ...DEFAULTS, ...raw }
    }
  } catch {
    /* 坏设置文件 —— 用默认值 */
  }
  return { ...DEFAULTS }
}

function saveSettings(s: Settings): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* 写失败不致命 */
  }
}

let settings = loadSettings()

// ── Worker（数据层宿主） ──

interface PendingRpc {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

const pending = new Map<number, PendingRpc>()
let rpcSeq = 1
let worker: Worker | null = null
let workerRestarts = 0
let quitting = false

interface WorkerMsg {
  type: string
  id?: number
  ok?: boolean
  result?: unknown
  error?: string
  event?: string
  payload?: unknown
}

function spawnWorker(): Promise<void> {
  return new Promise((resolve) => {
    const w = new Worker(join(__dirname, 'worker.js'), {
      workerData: {
        userData: app.getPath('userData'),
        retentionDays: settings.retentionDays,
        customAgents: settings.customAgents
      }
    })
    worker = w
    w.on('message', (msg: WorkerMsg) => {
      if (msg.type === 'rpc-reply' && typeof msg.id === 'number') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error ?? 'worker 错误'))
      } else if (msg.type === 'event') {
        broadcast(msg.event!, msg.payload)
      }
    })
    w.on('error', (e) => console.error('[nexa] worker error:', e))
    w.on('exit', (code) => {
      if (worker === w) worker = null
      // 崩溃瞬间所有挂起 RPC 立即失败 —— 否则 UI 会无限等待
      for (const [, p] of pending) p.reject(new Error(`数据服务已退出（code ${code}）`))
      pending.clear()
      if (quitting) return
      if (workerRestarts < 3) {
        workerRestarts++
        console.warn(`[nexa] worker exited (code ${code}) — 1 秒后重启（第 ${workerRestarts}/3 次）`)
        setTimeout(() => {
          void spawnWorker()
        }, 1000)
      } else {
        console.error('[nexa] worker 重试已达上限，数据服务不可用')
        broadcast('workerDead')
      }
    })
    setImmediate(resolve)
  })
}

function callWorker<T>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('数据服务未启动'))
      return
    }
    const id = rpcSeq++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker.postMessage({ type: 'rpc', id, method, args })
  })
}

// ── 窗口 ──

let win: BrowserWindow | null = null

function createWindow(): void {
  // bounds 防御：异常值丢弃，合法值夹回工作区（防窗口开在屏幕外）
  const b = settings.bounds
  const boundsOk =
    !!b && Number.isFinite(b.width) && Number.isFinite(b.height) && b.width >= 400 && b.height >= 300
  const area = screen.getPrimaryDisplay().workArea
  const w0 = boundsOk ? b!.width : 1685
  const h0 = boundsOk ? b!.height : 1050
  const x0 = boundsOk && Number.isFinite(b!.x) ? b!.x : undefined
  const y0 = boundsOk && Number.isFinite(b!.y) ? b!.y : undefined
  win = new BrowserWindow({
    width: Math.min(w0, area.width),
    height: Math.min(h0, area.height),
    x: x0 !== undefined ? Math.min(Math.max(x0, area.x), area.x + Math.max(0, area.width - 200)) : undefined,
    y: y0 !== undefined ? Math.min(Math.max(y0, area.y), area.y + Math.max(0, area.height - 100)) : undefined,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#8b93a7',
      height: 40
    },
    icon: join(app.getAppPath(), 'build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true, // preload 只用 contextBridge + ipcRenderer —— 可完整沙箱化
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 渲染进程防劫持：拒绝一切页面内导航与新窗口（应用自身 loadURL/loadFile 不受影响）
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.once('ready-to-show', () => {
    if (settings.bounds?.maximized) win?.maximize()
    win?.show()
  })

  // 窗口几何记忆
  const saveBounds = (): void => {
    if (!win || win.isDestroyed()) return
    settings.bounds = {
      x: win.getBounds().x,
      y: win.getBounds().y,
      width: win.getBounds().width,
      height: win.getBounds().height,
      maximized: win.isMaximized()
    }
    saveSettings(settings)
  }
  win.on('close', saveBounds)

  // 最小化暂停 2s 轮询（恢复后下一拍续上）
  win.on('minimize', () => void callWorker('setPollPaused', true).catch(() => {}))
  win.on('restore', () => void callWorker('setPollPaused', false).catch(() => {}))

  win.on('closed', () => {
    win = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function broadcast(event: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send('nexa:event', event, payload)
}

// ── IPC ──

function registerIpc(): void {
  // 所有数据查询走 worker RPC
  ipcMain.handle('nexa:invoke', (_e, method: string, args: unknown[]) => {
    return callWorker(method, ...(Array.isArray(args) ? args : []))
  })

  // 设置
  ipcMain.handle('nexa:getSettings', () => settings)
  ipcMain.handle('nexa:setSettings', (_e, patch: Partial<Settings>) => {
    const prevRetention = settings.retentionDays
    const prevCustom = JSON.stringify(settings.customAgents ?? [])
    settings = { ...settings, ...patch }
    saveSettings(settings)
    if (patch.retentionDays !== undefined && patch.retentionDays !== prevRetention) {
      void callWorker('setRetentionDays', patch.retentionDays).catch(() => {})
      broadcast('settingsChanged', settings)
    }
    if (patch.customAgents !== undefined && JSON.stringify(patch.customAgents) !== prevCustom) {
      void callWorker('setCustomAgents', patch.customAgents).catch(() => {})
      broadcast('settingsChanged', settings)
    }
    if (patch.digestEnabled !== undefined || patch.digestTime !== undefined) scheduleDigest()
    if (patch.theme) applyOverlayTheme(patch.theme)
    return settings
  })

  // 归档文件选择（多机合并）
  ipcMain.handle('nexa:pickArchive', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: '选择另一台机器的归档文件（usage-archive.bin）',
      properties: ['openFile'],
      filters: [{ name: 'Nexa 归档', extensions: ['bin'] }]
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!
  })

  // 目录选择（自定义 agent 数据目录）
  ipcMain.handle('nexa:pickDirectory', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: '选择 agent 数据目录',
      properties: ['openDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!
  })

  // 主题切换时更新原生控制按钮配色
  ipcMain.handle('nexa:applyOverlay', (_e, theme: 'dark' | 'light') => {
    applyOverlayTheme(theme)
    return true
  })

  // 外链只经用户点击离开（隐私承诺：程序自身零网络请求）
  ipcMain.handle('nexa:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return true
  })
}

function applyOverlayTheme(theme: 'dark' | 'light'): void {
  if (!win || win.isDestroyed()) return
  try {
    win.setTitleBarOverlay(
      theme === 'dark'
        ? { color: '#00000000', symbolColor: '#8b93a7' }
        : { color: '#00000000', symbolColor: '#5b6472' }
    )
  } catch {
    /* 非 Windows 平台无 overlay —— 忽略 */
  }
}

// ── 托盘 + 每日摘要（本地通知，零网络） ──

let tray: Tray | null = null
let digestTimer: NodeJS.Timeout | null = null

function createTray(): void {
  try {
    const iconPath = join(app.getAppPath(), 'build/icon.ico')
    tray = new Tray(iconPath)
    tray.setToolTip('Nexa — AI Agent 用量监控')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => showWindow() },
        { type: 'separator' },
        { label: '退出 Nexa', click: () => app.quit() }
      ])
    )
    tray.on('click', () => showWindow())
  } catch {
    /* 托盘不可用（图标缺失等）—— 忽略 */
  }
}

function showWindow(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function scheduleDigest(): void {
  if (digestTimer) clearTimeout(digestTimer)
  digestTimer = null
  if (!settings.digestEnabled) return
  const [hh, mm] = settings.digestTime.split(':').map((v) => Number(v) || 0)
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  const delay = next.getTime() - now.getTime()
  digestTimer = setTimeout(() => {
    void fireDigest()
    scheduleDigest() // 明日再来
  }, Math.min(delay, 24 * 3600 * 1000))
}

async function fireDigest(): Promise<void> {
  try {
    const d = await callWorker<{
      tokens: number
      requests: number
      yesterdayTokens: number
      topModel: string
      topModelPct: number
    }>('dailyDigest')
    const fmt = (n: number): string => {
      if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
      if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
      return String(Math.round(n))
    }
    const pct = d.yesterdayTokens > 0 ? ((d.tokens - d.yesterdayTokens) / d.yesterdayTokens) * 100 : 0
    const trend = d.yesterdayTokens > 0 ? `（较昨日 ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%）` : ''
    const model = d.topModel ? `主力 ${d.topModel} 占 ${d.topModelPct.toFixed(0)}%` : ''
    new Notification({
      title: 'Nexa 日报',
      body: `今天 ${fmt(d.tokens)} tokens · ${d.requests} 次请求${trend}${model ? ' · ' + model : ''}`,
      icon: join(app.getAppPath(), 'build/icon.ico')
    }).show()
  } catch {
    /* 日报失败不影响使用 */
  }
}

// 允许用独立 userData 起第二个实例（验证/多开），须在单实例锁之前生效
const userDataOverride = process.env['NEXA_USER_DATA']
if (userDataOverride && userDataOverride.trim()) {
  app.setPath('userData', userDataOverride.trim())
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    registerIpc()
    await spawnWorker()
    createWindow()
    createTray()
    scheduleDigest()
    applyOverlayTheme(settings.theme)
  })

  app.on('before-quit', () => {
    quitting = true
    if (digestTimer) clearTimeout(digestTimer)
  })

  app.on('window-all-closed', () => {
    app.quit() // 监控面板 —— 关窗即退出
  })
}
