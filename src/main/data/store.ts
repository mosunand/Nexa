// main/data/store.ts — 中央数据服务（运行在 worker 线程，同步执行）。
// 从老项目 Store.cpp 1:1 移植：
//   · 持有全部适配器
//   · 增量扫描器：mtime/size 探测，只重解析新/变过的文件进 SQLite 缓存
//     （responses + sessions + files + tools 表，WAL）
//   · 全部概览/会话/模型查询以 SQL 跑在缓存库上
//   · 每 2 秒一拍重扫，把真正新完成的响应推给实时流
//   · 自有二进制归档（AGMON v2，与老项目逐字节兼容）：合并写入、永不删除
//     —— 删掉 agent 原始数据也抹不掉已记录的历史

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type {
  AgentBreakdown,
  AgentStatus,
  AgentTotal,
  ArchiveInfo,
  ArchiveMergeResult,
  BrakeStats,
  BrakeModelRow,
  DailyDigest,
  DailyTotal,
  DayReplayRow,
  DeepScanResult,
  FileHotspot,
  HourBucket,
  Kpis,
  LoopHit,
  ModelBreakdown,
  ModelDayPoint,
  OverviewData,
  ProjectStat,
  ScanResult,
  SeriesPoint,
  SessionInfo,
  SpeedRow,
  TimeWindow,
  ToolBreakdown,
  UsageRecord,
  ZcodeDiagnostics
} from '@shared/types'
import { ABORT_ERRORS } from '@shared/types'
import { createAdapters, type AgentAdapter, type ParseResult } from '../core/adapters/adapter'
import { buildCustomAdapter, CUSTOM_ID_PREFIX, customAgentColor } from '../core/adapters/customAgent'
import type { CustomAgentConfig } from '@shared/types'
import { cacheDbPath, archivePath, zcodeDbPath } from '../core/paths'
import { dropReadonly, openReadonly } from '../core/adapters/sqliteUtil'
import {
  archiveKey,
  deserializeArchive,
  familyDisplay,
  localMidnight,
  modelFamily,
  serializeArchive,
  sha256Hex,
  tzOffsetMs,
  type ArchiveEntry,
  type SessionFile,
  type ToolStat
} from '../core/util'

const K_SCHEMA_VERSION = 4
const K_RETENTION_DEFAULT = 730

interface ParsedQuery {
  where: string[]
  params: Record<string, unknown>
}

export class Store {
  adapters: AgentAdapter[] = createAdapters()
  customConfigs: CustomAgentConfig[] = []

  // 用户自定义 agent：重建动态适配器 + 清理已移除 agent 的历史行
  setCustomAgents(list: CustomAgentConfig[]): void {
    const built: AgentAdapter[] = []
    const seenIds = new Set<string>() // 同名 agent 撞 id 会互相覆盖缓存行 —— 强制去重
    for (const cfg of list) {
      let id = cfg.id.startsWith(CUSTOM_ID_PREFIX) ? cfg.id : CUSTOM_ID_PREFIX + cfg.id
      while (seenIds.has(id)) id += '-2'
      seenIds.add(id)
      const ad = buildCustomAdapter({ ...cfg, id }, customAgentColor(id))
      if (ad) built.push(ad)
    }
    const builtin = this.adapters.filter((a) => !a.id.startsWith(CUSTOM_ID_PREFIX))
    const staleIds = this.adapters
      .filter((a) => a.id.startsWith(CUSTOM_ID_PREFIX))
      .filter((a) => !built.some((b) => b.id === a.id))
      .map((a) => a.id)

    if (staleIds.length > 0) {
      try {
        const db = this.connection()
        for (const id of staleIds) {
          db.prepare('DELETE FROM responses WHERE agent = ?').run(id)
          db.prepare('DELETE FROM sessions WHERE agent = ?').run(id)
          db.prepare('DELETE FROM tools WHERE agent = ?').run(id)
          db.prepare('DELETE FROM files WHERE agent = ?').run(id)
        }
      } catch {
        /* 清理失败不致命 */
      }
    }

    this.adapters = [...builtin, ...built]
    this.customConfigs = list
    this.statusCache = this.statusCache.filter((s) => !s.id.startsWith(CUSTOM_ID_PREFIX))
  }

  private db: Database.Database | null = null
  private watermarkInit = false
  private watermarkMs = 0
  private scanBusy = false
  private pollPaused = false
  private pollTimer: NodeJS.Timeout | null = null

  private statusCache: AgentStatus[] = []
  private m_lastScanMs = 0

  private archive = new Map<string, ArchiveEntry>()
  private archiveLoaded = false
  private archiveHash = ''
  private retentionDays = K_RETENTION_DEFAULT

  // ── 生命周期 ──

  setRetentionDays(days: number): void {
    this.retentionDays = Math.max(30, days)
    this.mergeArchiveFromCache()
  }

  getRetentionDays(): number {
    return this.retentionDays
  }

  setPollPaused(paused: boolean): void {
    this.pollPaused = paused
  }

  // ── 缓存库 ──

  private connection(): Database.Database {
    if (this.db?.open) return this.db
    const path = cacheDbPath()
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 3000')
    this.db = db
    return db
  }

  openCache(): { ok: boolean; err: string } {
    try {
      const db = this.connection()
      this.createSchema(db)
      this.loadArchive()
      return { ok: true, err: '' }
    } catch (e) {
      return { ok: false, err: String((e as Error).message) }
    }
  }

  private createSchema(db: Database.Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`)
    // schema 迁移：过期的缓存是一次性的 —— 重建
    const vrow = db.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).get() as
      | { v: string }
      | undefined
    const version = Number(vrow?.v ?? 0)
    if (version !== K_SCHEMA_VERSION) {
      db.exec(`DROP TABLE IF EXISTS responses`)
      db.exec(`DROP TABLE IF EXISTS sessions`)
      db.exec(`DROP TABLE IF EXISTS files`)
      db.exec(`DROP TABLE IF EXISTS tools`)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS files(
      path TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      mtime INTEGER, size INTEGER)`)
    db.exec(`CREATE TABLE IF NOT EXISTS sessions(
      agent TEXT NOT NULL, session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT, cwd TEXT, model TEXT, originator TEXT,
      started INTEGER, updated INTEGER,
      responses INTEGER, tool_calls INTEGER, errors INTEGER,
      in_tok INTEGER, cached_tok INTEGER,
      cache_write_tok INTEGER, out_tok INTEGER,
      reason_tok INTEGER, context_window INTEGER,
      PRIMARY KEY(agent, session_id))`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated DESC)`)
    db.exec(`CREATE TABLE IF NOT EXISTS tools(
      agent TEXT NOT NULL, session_id TEXT NOT NULL,
      name TEXT NOT NULL, calls INTEGER NOT NULL,
      first_ms INTEGER, last_ms INTEGER)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(agent, name)`)
    db.exec(`CREATE TABLE IF NOT EXISTS responses(
      agent TEXT NOT NULL, session_id TEXT NOT NULL,
      turn_id TEXT, response_id TEXT,
      time_ms INTEGER NOT NULL,
      dur_ok INTEGER, dur_approx INTEGER, dur_ms REAL,
      model TEXT, effort TEXT, source TEXT,
      in_tok INTEGER, cached_tok INTEGER,
      cache_write_tok INTEGER, out_tok INTEGER,
      reason_tok INTEGER,
      tps_ok INTEGER, tps REAL, error TEXT)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_resp_time ON responses(time_ms)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_resp_session ON responses(agent, session_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_resp_model ON responses(agent, model)`)
    db.prepare(`INSERT OR REPLACE INTO meta VALUES('schema_version', ?)`).run(String(K_SCHEMA_VERSION))
  }

  // ───────────────────────── 老版缓存迁移 ─────────────────────────
  // 老项目（C++/Qt Agent-Monitor）的历史数据只存在它的缓存库里 —— 它的
  // 二进制归档因"装进 Program Files 不落盘"的已知限制往往从未写出，而
  // agent 源数据会被自身保留策略清理（mtime 未变 → 增量扫描永不重解析，
  // 老缓存因此独占历史）。此迁移把新缓存缺失响应的老会话一次性搬进来，
  // 只补零响应的会话 → 绝不与新鲜解析重复计数。幂等（meta 里留标记）。

  migrateLegacyCache(): { sessions: number; rows: number } {
    const candidates: string[] = []
    const env = process.env['AGENT_MONITOR_CACHE']
    if (env && env.trim()) candidates.push(env.trim())
    const local = process.env['LOCALAPPDATA'] ?? ''
    if (local) {
      candidates.push(join(local, 'zhipucode', 'agent-monitor', 'cache.sqlite'))
      candidates.push(join(local, 'zhipucode', 'agent-monitor', 'agent-monitor', 'cache.sqlite'))
    }

    const db = this.connection()
    const done = new Set(
      (db.prepare("SELECT v FROM meta WHERE k LIKE 'legacy_import:%'").all() as Array<{ v: string }>).map(
        (r) => r.v
      )
    )
    let sessions = 0
    let rows = 0

    for (const p of candidates) {
      if (done.has(p) || !existsSync(p)) continue
      try {
        const legacy = new Database(p, { readonly: true, fileMustExist: true })
        const haveCount = db.prepare('SELECT COUNT(*) AS c FROM responses WHERE agent = ? AND session_id = ?')
        const oldRespRows = legacy.prepare(
          `SELECT agent, session_id, turn_id, response_id, time_ms, dur_ok, dur_approx, dur_ms,
                  model, effort, source, in_tok, cached_tok, cache_write_tok, out_tok, reason_tok,
                  tps_ok, tps, error
           FROM responses WHERE agent = ? AND session_id = ?`
        )
        const oldToolRows = legacy.prepare(
          'SELECT agent, session_id, name, calls, first_ms, last_ms FROM tools WHERE agent = ? AND session_id = ?'
        )
        const insSession = db.prepare(
          `INSERT OR REPLACE INTO sessions(agent, session_id, path, title, cwd, model, originator,
             started, updated, responses, tool_calls, errors, in_tok, cached_tok,
             cache_write_tok, out_tok, reason_tok, context_window)
           VALUES(@agent,@session_id,@path,@title,@cwd,@model,@originator,
             @started,@updated,@responses,@tool_calls,@errors,@in_tok,@cached_tok,
             @cache_write_tok,@out_tok,@reason_tok,@context_window)`
        )
        const insResponse = db.prepare(
          `INSERT INTO responses(agent, session_id, turn_id, response_id, time_ms, dur_ok,
             dur_approx, dur_ms, model, effort, source, in_tok, cached_tok, cache_write_tok,
             out_tok, reason_tok, tps_ok, tps, error)
           VALUES(@agent,@session_id,@turn_id,@response_id,@time_ms,@dur_ok,@dur_approx,@dur_ms,
             @model,@effort,@source,@in_tok,@cached_tok,@cache_write_tok,@out_tok,@reason_tok,
             @tps_ok,@tps,@error)`
        )
        const insTool = db.prepare(
          'INSERT INTO tools(agent, session_id, name, calls, first_ms, last_ms) VALUES(@agent,@session_id,@name,@calls,@first_ms,@last_ms)'
        )
        // 逐源库幂等（meta 里留标记）。行数据先从 legacy 读出再写入 ——
        // 两个库不能靠一条 INSERT...SELECT 交叉复制（未限定库名会读到目标库自身）。
        const importOne = db.transaction((path: string): void => {
          const oldSessions = legacy
            .prepare(
              `SELECT agent, session_id, path, title, cwd, model, originator, started, updated,
                      responses, tool_calls, errors, in_tok, cached_tok, cache_write_tok,
                      out_tok, reason_tok, context_window FROM sessions`
            )
            .all() as Array<Record<string, unknown>>
          for (const s of oldSessions) {
            const agent = String(s.agent ?? '')
            const sid = String(s.session_id ?? '')
            if (!agent || !sid) continue
            const respRows = oldRespRows.all(agent, sid) as Array<Record<string, unknown>>
            if (respRows.length === 0) continue // 老缓存也没数据 —— 没什么可搬
            const have = Number((haveCount.get(agent, sid) as { c: number }).c)
            if (have > 0) continue // 新缓存已解析过该会话 —— 新鲜数据优先，绝不重复计数
            insSession.run(s)
            for (const r of respRows) insResponse.run(r)
            for (const t of oldToolRows.all(agent, sid) as Array<Record<string, unknown>>) insTool.run(t)
            sessions++
            rows += respRows.length
          }
          db.prepare("INSERT OR REPLACE INTO meta VALUES('legacy_import_v2:' || ?, 'done')").run(path)
        })
        importOne(p)
        legacy.close()
      } catch {
        /* 旧库损坏/被锁 —— 跳过，不阻塞启动 */
      }
    }

    if (rows > 0) this.mergeArchiveFromCache()
    return { sessions, rows }
  }

  // ───────────────────────── 扫描 ─────────────────────────

  scan(): { result: ScanResult; fresh: UsageRecord[] } {
    const t0 = Date.now()
    const res: ScanResult = { ok: false, err: '', totalFiles: 0, changedFiles: 0, freshCount: 0, scanMs: 0 }
    const fresh: UsageRecord[] = []
    const opened = this.openCache()
    if (!opened.ok) {
      res.err = opened.err
      res.scanMs = Date.now() - t0
      return { result: res, fresh }
    }
    const db = this.connection()
    const statusNext: AgentStatus[] = []

    try {
      for (const ad of this.adapters) {
        const agent = ad.id
        const listed = ad.listSessionFiles()
        const files = listed.files
        res.totalFiles += files.length
        if (files.length === 0 && listed.note) res.err = listed.note

        // 状态直接由本轮已枚举的文件构造 —— 不再额外走一遍完整文件树
        const present = ad.dataPresent()
        const st: AgentStatus = {
          id: agent,
          name: ad.displayName,
          color: ad.color,
          found: present.found,
          dataDir: present.dir,
          sessions: present.found ? files.length : 0,
          note: !present.found
            ? '未检测到本地数据目录'
            : listed.note || '数据正常（只读观测）',
          lastActivityMs: 0
        }
        for (const f of files) st.lastActivityMs = Math.max(st.lastActivityMs, f.mtimeMs)
        statusNext.push(st)

        // 该 agent 已知文件状态
        const known = new Map<string, { mtime: number; size: number }>()
        for (const r of db.prepare('SELECT path, mtime, size FROM files WHERE agent = ?').all(agent) as Array<{
          path: string
          mtime: number
          size: number
        }>) {
          known.set(r.path, { mtime: Number(r.mtime) || 0, size: Number(r.size) || 0 })
        }

        const listedPaths = new Set<string>()
        const insertSession = db.prepare(`INSERT INTO sessions(
            agent, session_id, path, title, cwd, model, originator,
            started, updated, responses, tool_calls, errors,
            in_tok, cached_tok, cache_write_tok, out_tok, reason_tok, context_window)
          VALUES(@agent,@sessionId,@path,@title,@cwd,@model,@originator,
            @started,@updated,@responses,@toolCalls,@errors,
            @inTok,@cachedTok,@cacheWriteTok,@outTok,@reasonTok,@contextWindow)`)
        const insertResponse = db.prepare(`INSERT INTO responses(
            agent, session_id, turn_id, response_id, time_ms, dur_ok, dur_approx,
            dur_ms, model, effort, source, in_tok, cached_tok, cache_write_tok,
            out_tok, reason_tok, tps_ok, tps, error)
          VALUES(@agent,@sessionId,@turnId,@responseId,@timeMs,@durOk,@durApprox,
            @durMs,@model,@effort,@source,@inTok,@cachedTok,@cacheWriteTok,
            @outTok,@reasonTok,@tpsOk,@tps,@error)`)
        const insertTool = db.prepare(
          'INSERT INTO tools(agent, session_id, name, calls, first_ms, last_ms) VALUES(?,?,?,?,?,?)'
        )
        const deleteResponses = db.prepare('DELETE FROM responses WHERE agent = ? AND session_id = ?')
        const deleteSessions = db.prepare('DELETE FROM sessions WHERE agent = ? AND session_id = ?')
        const deleteTools = db.prepare('DELETE FROM tools WHERE agent = ? AND session_id = ?')
        const upsertFile = db.prepare('INSERT OR REPLACE INTO files(path, agent, mtime, size) VALUES(?,?,?,?)')
        const begin = db.prepare('BEGIN IMMEDIATE TRANSACTION')
        const commit = db.prepare('COMMIT')

        for (const f of files) {
          listedPaths.add(f.path)
          const k = known.get(f.path)
          if (k && k.mtime === f.mtimeMs && k.size === f.size) continue // 未变

          const parsed = ad.parseFile(f)
          if (!parsed) continue // 读不了 —— 跳过（不入缓存）

          begin.run()
          deleteResponses.run(agent, parsed.meta.sessionId)
          deleteSessions.run(agent, parsed.meta.sessionId)
          deleteTools.run(agent, parsed.meta.sessionId)
          insertSession.run({
            agent,
            sessionId: parsed.meta.sessionId,
            path: parsed.meta.filePath,
            title: parsed.meta.title,
            cwd: parsed.meta.cwd,
            model: parsed.meta.model,
            originator: parsed.meta.originator,
            started: parsed.meta.startedMs,
            updated: parsed.meta.updatedMs,
            responses: parsed.meta.responses,
            toolCalls: parsed.meta.toolCalls,
            errors: parsed.meta.errors,
            inTok: parsed.meta.inputTokens,
            cachedTok: parsed.meta.cachedTokens,
            cacheWriteTok: parsed.meta.cacheWriteTokens,
            outTok: parsed.meta.outputTokens,
            reasonTok: parsed.meta.reasoningTokens,
            contextWindow: parsed.meta.contextWindow
          })
          for (const r of parsed.records) insertResponse.run(this.recordToRow(agent, r))
          const toolNames = Object.keys(parsed.tools)
          if (toolNames.length > 0) {
            for (const name of toolNames) {
              const t = parsed.tools[name] as ToolStat
              if (t.calls > 0) insertTool.run(agent, parsed.meta.sessionId, name, t.calls, t.firstMs, t.lastMs)
            }
          }
          upsertFile.run(f.path, agent, f.mtimeMs, f.size)
          commit.run()
          res.changedFiles++ // 解析 + 入库 —— 现在才计数
        }

        // 上一轮以来消失的文件（被清理的会话）。
        // 防御：源目录在但我们此前已知文件而本轮列表为空，说明枚举失败
        // （如 zcode 库被锁）—— 绝不能因此批量删除。
        const trustListing = !(files.length === 0 && ad.dataPresent().found && known.size > 0)
        if (!trustListing) continue
        const findSessionsByPath = db.prepare('SELECT session_id FROM sessions WHERE agent = ? AND path = ?')
        for (const [path] of known) {
          if (listedPaths.has(path)) continue
          for (const s of findSessionsByPath.all(agent, path) as Array<{ session_id: string }>) {
            deleteResponses.run(agent, s.session_id)
            deleteSessions.run(agent, s.session_id)
            deleteTools.run(agent, s.session_id)
          }
          db.prepare('DELETE FROM files WHERE path = ?').run(path)
          res.changedFiles++
        }
      }

      // 实时流 diff：水位之后的记录。首拍只设水位（绝不回放历史）。
      if (!this.watermarkInit) {
        const row = db.prepare('SELECT MAX(time_ms) AS m FROM responses').get() as { m: number | null }
        this.watermarkMs = Number(row?.m ?? 0) || 0
        this.watermarkInit = true
      } else if (this.watermarkMs > 0) {
        const rows = db
          .prepare(
            `SELECT agent, session_id, turn_id, response_id, time_ms, dur_ok, dur_approx,
                    dur_ms, model, effort, source, in_tok, cached_tok, cache_write_tok,
                    out_tok, reason_tok, tps_ok, tps, error
             FROM responses WHERE time_ms > ? ORDER BY time_ms LIMIT 200`
          )
          .all(this.watermarkMs) as Array<Record<string, unknown>>
        for (const row of rows) {
          const r = this.rowToRecord(row)
          fresh.push(r)
          res.freshCount++
          this.watermarkMs = Math.max(this.watermarkMs, r.timeMs)
        }
      }

      // 扫描合并进自有归档 —— merge-only，绝不删除已记录历史。
      // 空转的一拍不应每 2s 都跑整个 GROUP BY + 序列化 + SHA256；
      // 空归档也要合并（被删的 bin 文件得以重建）。
      if (res.changedFiles > 0 || this.archive.size === 0) this.mergeArchiveFromCache()
      res.ok = true
    } catch (e) {
      res.err = String((e as Error).message)
    }

    this.statusCache = statusNext
    this.m_lastScanMs = Date.now() - t0
    res.scanMs = this.m_lastScanMs
    return { result: res, fresh }
  }

  private recordToRow(agent: string, r: UsageRecord): Record<string, unknown> {
    return {
      agent,
      sessionId: r.sessionId,
      turnId: r.turnId,
      responseId: r.responseId,
      timeMs: r.timeMs,
      durOk: r.durOk ? 1 : 0,
      durApprox: r.durApprox ? 1 : 0,
      durMs: r.durationMs,
      model: r.model,
      effort: r.effort,
      source: r.source,
      inTok: r.inputTokens,
      cachedTok: r.cachedTokens,
      cacheWriteTok: r.cacheWriteTokens,
      outTok: r.outputTokens,
      reasonTok: r.reasoningTokens,
      tpsOk: r.tpsOk ? 1 : 0,
      tps: r.tps,
      error: r.error
    }
  }

  private rowToRecord(row: Record<string, unknown>): UsageRecord {
    return {
      agentId: String(row.agent ?? ''),
      sessionId: String(row.session_id ?? ''),
      turnId: String(row.turn_id ?? ''),
      responseId: String(row.response_id ?? ''),
      timeMs: Number(row.time_ms ?? 0) || 0,
      durOk: !!row.dur_ok,
      durApprox: !!row.dur_approx,
      durationMs: Number(row.dur_ms ?? 0) || 0,
      model: String(row.model ?? ''),
      effort: String(row.effort ?? ''),
      source: String(row.source ?? ''),
      inputTokens: Number(row.in_tok ?? 0) || 0,
      cachedTokens: Number(row.cached_tok ?? 0) || 0,
      cacheWriteTokens: Number(row.cache_write_tok ?? 0) || 0,
      outputTokens: Number(row.out_tok ?? 0) || 0,
      reasoningTokens: Number(row.reason_tok ?? 0) || 0,
      error: String(row.error ?? ''),
      tpsOk: !!row.tps_ok,
      tps: Number(row.tps ?? 0) || 0
    }
  }

  // ───────────────────────── 轮询（timer 由 worker 持有） ─────────────────────────

  get busy(): boolean {
    return this.scanBusy
  }

  // ───────────────────────── 查询 ─────────────────────────

  windowSince(window: TimeWindow): number {
    const now = Date.now()
    if (window === 'today') return localMidnight(now)
    if (window === '24h') return now - 24 * 3600 * 1000
    if (window === '7d') return now - 7 * 24 * 3600 * 1000
    if (window === '30d') return now - 30 * 24 * 3600 * 1000
    return 0
  }

  overview(window: TimeWindow): OverviewData {
    const db = this.connection()
    const d: OverviewData = {
      window,
      sinceMs: this.windowSince(window),
      kpis: emptyKpis(),
      todayKpis: emptyKpis(),
      todayByModel: [],
      series: [],
      byModel: [],
      byAgent: [],
      byTool: [],
      recentSpeed: []
    }

    const runKpis = (since: number, k: Kpis): void => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS requests, COUNT(DISTINCT session_id) AS sessions,
                  SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) AS errors,
                  SUM(in_tok) AS in_tok, SUM(out_tok) AS out_tok, SUM(reason_tok) AS reason_tok,
                  SUM(cached_tok) AS cache_read, SUM(cache_write_tok) AS cache_write,
                  AVG(CASE WHEN dur_ok=1 THEN dur_ms END) AS avg_dur,
                  SUM(CASE WHEN tps_ok=1 THEN out_tok + reason_tok ELSE 0 END) AS gen,
                  SUM(CASE WHEN tps_ok=1 THEN dur_ms ELSE 0 END) AS dur,
                  SUM(CASE WHEN tps_ok=1 THEN 1 ELSE 0 END) AS samples
           FROM responses WHERE time_ms >= ?`
        )
        .get(since > 0 ? since : 0) as Record<string, unknown>
      if (!row) return
      k.requests = Number(row.requests ?? 0)
      k.sessions = Number(row.sessions ?? 0)
      k.errors = Number(row.errors ?? 0)
      k.inTok = Number(row.in_tok ?? 0)
      k.outTok = Number(row.out_tok ?? 0)
      k.reasonTok = Number(row.reason_tok ?? 0)
      k.cacheRead = Number(row.cache_read ?? 0)
      k.cacheWrite = Number(row.cache_write ?? 0)
      k.avgDurOk = row.avg_dur !== null && row.avg_dur !== undefined
      k.avgDurMs = Number(row.avg_dur ?? 0)
      const gen = Number(row.gen ?? 0)
      const durMs = Number(row.dur ?? 0)
      k.tpsSamples = Number(row.samples ?? 0)
      k.tpsOk = durMs > 0
      k.weightedTps = k.tpsOk ? gen / (durMs / 1000) : 0
    }
    runKpis(d.sinceMs, d.kpis)
    runKpis(this.windowSince('today'), d.todayKpis)

    // 序列（bucket 大小按窗口）
    let bucket = 3600 * 1000
    if (window === '7d') bucket = 6 * 3600 * 1000
    else if (window === '30d' || window === 'all') bucket = 24 * 3600 * 1000
    {
      // 本地对齐 bucket（与日聚合同一 tz 偏移）：UTC 对齐的 24h bucket 在
      // UTC+8 会从当地 08:00 开始，把每个本地日劈成两半
      const tz = tzOffsetMs()
      const sql =
        d.sinceMs > 0
          ? `SELECT ((time_ms + ${tz}) / ${bucket}) * ${bucket} - ${tz} AS b, COUNT(*) AS requests,
                    SUM(in_tok) AS input, SUM(out_tok) AS output, SUM(reason_tok) AS reasoning
             FROM responses WHERE time_ms >= ? GROUP BY b ORDER BY b`
          : `SELECT ((time_ms + ${tz}) / ${bucket}) * ${bucket} - ${tz} AS b, COUNT(*) AS requests,
                    SUM(in_tok) AS input, SUM(out_tok) AS output, SUM(reason_tok) AS reasoning
             FROM responses GROUP BY b ORDER BY b`
      const rows = db.prepare(sql).all(d.sinceMs > 0 ? d.sinceMs : 0) as Array<Record<string, unknown>>
      for (const r of rows) {
        d.series.push({
          bucketMs: Number(r.b ?? 0),
          requests: Number(r.requests ?? 0),
          input: Number(r.input ?? 0),
          output: Number(r.output ?? 0),
          reasoning: Number(r.reasoning ?? 0)
        })
      }
    }

    // 按模型（+effort）—— 总 token 取前 12；跑两遍（窗口 + 固定 today）
    const fetchByModel = (since: number): ModelBreakdown[] => {
      const out: ModelBreakdown[] = []
      const rows = db
        .prepare(
          `SELECT agent, model, effort, COUNT(*) AS requests, SUM(in_tok) AS in_tok,
                  SUM(cached_tok) AS cached_tok, SUM(out_tok) AS out_tok, SUM(reason_tok) AS reason_tok,
                  AVG(CASE WHEN dur_ok=1 THEN dur_ms END) AS avg_dur,
                  SUM(CASE WHEN tps_ok=1 THEN out_tok + reason_tok ELSE 0 END) AS gen,
                  SUM(CASE WHEN tps_ok=1 THEN dur_ms ELSE 0 END) AS dur,
                  MAX(time_ms) AS last_ms, SUM(in_tok + out_tok + reason_tok) AS tot
           FROM responses WHERE time_ms >= ?
           GROUP BY agent, model, effort ORDER BY tot DESC LIMIT 12`
        )
        .all(since > 0 ? since : 0) as Array<Record<string, unknown>>
      for (const r of rows) {
        const durMs = Number(r.dur ?? 0)
        const tpsOk = durMs > 0
        out.push({
          agentId: String(r.agent ?? ''),
          model: String(r.model ?? ''),
          effort: String(r.effort ?? ''),
          requests: Number(r.requests ?? 0),
          inTok: Number(r.in_tok ?? 0),
          cachedTok: Number(r.cached_tok ?? 0),
          outTok: Number(r.out_tok ?? 0),
          reasonTok: Number(r.reason_tok ?? 0),
          avgDurOk: r.avg_dur !== null && r.avg_dur !== undefined,
          avgDurMs: Number(r.avg_dur ?? 0),
          tpsOk,
          weightedTps: tpsOk ? Number(r.gen ?? 0) / (durMs / 1000) : 0,
          lastMs: Number(r.last_ms ?? 0)
        })
      }
      return out
    }
    d.byModel = fetchByModel(d.sinceMs)
    d.todayByModel = fetchByModel(this.windowSince('today'))

    // 按 agent
    {
      const rows = db
        .prepare(
          `SELECT agent, COUNT(*) AS requests, SUM(in_tok) AS in_tok, SUM(cached_tok) AS cached_tok,
                  SUM(out_tok) AS out_tok, SUM(reason_tok) AS reason_tok
           FROM responses WHERE time_ms >= ? GROUP BY agent`
        )
        .all(d.sinceMs > 0 ? d.sinceMs : 0) as Array<Record<string, unknown>>
      for (const r of rows) {
        d.byAgent.push({
          agentId: String(r.agent ?? ''),
          requests: Number(r.requests ?? 0),
          inTok: Number(r.in_tok ?? 0),
          cachedTok: Number(r.cached_tok ?? 0),
          outTok: Number(r.out_tok ?? 0),
          reasonTok: Number(r.reason_tok ?? 0)
        })
      }
    }

    // 按工具（前 30）—— 按工具自身发生时间过滤，而不是按会话归属：
    // 长会话否则会把全部历史工具调用计入每个窗口
    {
      const rows = db
        .prepare(
          `SELECT t.agent, t.name, SUM(t.calls) AS calls, COUNT(DISTINCT t.session_id) AS sessions
           FROM tools t WHERE t.last_ms >= ?
           GROUP BY t.agent, t.name ORDER BY calls DESC LIMIT 30`
        )
        .all(d.sinceMs > 0 ? d.sinceMs : 0) as Array<Record<string, unknown>>
      for (const r of rows) {
        d.byTool.push({
          agentId: String(r.agent ?? ''),
          toolName: String(r.name ?? ''),
          calls: Number(r.calls ?? 0),
          sessions: Number(r.sessions ?? 0)
        })
      }
    }

    // 最近完成的请求（速度表）—— 全部大类；页面再按大类重新查询
    d.recentSpeed = this.recentSpeed(d.sinceMs, '')
    return d
  }

  recentSpeed(sinceMs: number, family: string, limit = 60): SpeedRow[] {
    const db = this.connection()
    const base = `SELECT time_ms, agent, model, session_id, out_tok, reason_tok,
                         dur_ok, dur_ms, tps_ok, tps
                  FROM responses WHERE tps_ok = 1 AND time_ms >= :since`
    let sql: string
    const params: Record<string, unknown> = { since: sinceMs > 0 ? sinceMs : 0, lim: limit }
    if (!family) {
      sql = base + ' ORDER BY time_ms DESC LIMIT :lim'
    } else {
      // 大类过滤：lower(model) LIKE 'deepseek-%' 覆盖该大类下所有具体型号；
      // 恰好等于大类名的裸模型（无 - 变体）走 OR 精确匹配
      sql = base + " AND (lower(model) LIKE :famPat OR lower(model) = :fam) ORDER BY time_ms DESC LIMIT :lim"
      params.famPat = family + '-%'
      params.fam = family
    }
    const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      timeMs: Number(r.time_ms ?? 0),
      agentId: String(r.agent ?? ''),
      model: String(r.model ?? ''),
      sessionId: String(r.session_id ?? ''),
      output: Number(r.out_tok ?? 0),
      reasoning: Number(r.reason_tok ?? 0),
      durOk: !!r.dur_ok,
      durationMs: Number(r.dur_ms ?? 0),
      tpsOk: !!r.tps_ok,
      tps: Number(r.tps ?? 0)
    }))
  }

  sessionList(agent: string, search: string, limit = 500): SessionInfo[] {
    const db = this.connection()
    const { where, params } = sessionFilter(agent, search)
    let sql = `SELECT agent, session_id, path, title, cwd, model, originator,
                      started, updated, responses, tool_calls, errors, in_tok, cached_tok,
                      cache_write_tok, out_tok, reason_tok, context_window FROM sessions`
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY updated DESC LIMIT @lim'
    params.lim = limit
    const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToSession(r))
  }

  sessionInfo(agent: string, sessionId: string): SessionInfo {
    const db = this.connection()
    const row = db
      .prepare(
        `SELECT agent, session_id, path, title, cwd, model, originator,
                started, updated, responses, tool_calls, errors, in_tok, cached_tok,
                cache_write_tok, out_tok, reason_tok, context_window FROM sessions
         WHERE agent = ? AND session_id = ?`
      )
      .get(agent, sessionId) as Record<string, unknown> | undefined
    if (!row) return { ...emptySession(), agentId: agent, sessionId }
    const s = this.rowToSession(row)
    if (!s.title) s.title = sessionId.slice(0, 12)
    return s
  }

  private rowToSession(r: Record<string, unknown>): SessionInfo {
    return {
      agentId: String(r.agent ?? ''),
      sessionId: String(r.session_id ?? ''),
      filePath: String(r.path ?? ''),
      title: String(r.title ?? ''),
      cwd: String(r.cwd ?? ''),
      model: String(r.model ?? ''),
      originator: String(r.originator ?? ''),
      startedMs: Number(r.started ?? 0) || 0,
      updatedMs: Number(r.updated ?? 0) || 0,
      responses: Number(r.responses ?? 0) || 0,
      toolCalls: Number(r.tool_calls ?? 0) || 0,
      errors: Number(r.errors ?? 0) || 0,
      inputTokens: Number(r.in_tok ?? 0) || 0,
      cachedTokens: Number(r.cached_tok ?? 0) || 0,
      cacheWriteTokens: Number(r.cache_write_tok ?? 0) || 0,
      outputTokens: Number(r.out_tok ?? 0) || 0,
      reasoningTokens: Number(r.reason_tok ?? 0) || 0,
      contextWindow: Number(r.context_window ?? 0) || 0
    }
  }

  sessionRecords(agent: string, sessionId: string): UsageRecord[] {
    const db = this.connection()
    const rows = db
      .prepare(
        `SELECT * FROM responses WHERE agent = ? AND session_id = ? ORDER BY time_ms`
      )
      .all(agent, sessionId) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToRecord(r))
  }

  parseSessionMessages(agent: string, sessionId: string): { ok: boolean; err: string; messages: import('@shared/types').ChatMessage[] } {
    const info = this.sessionInfo(agent, sessionId)
    if (!info.filePath) return { ok: false, err: '会话不存在', messages: [] }
    const ad = this.adapters.find((a) => a.id === agent)
    if (!ad?.parseMessages) return { ok: false, err: '该 agent 暂不支持对话重放', messages: [] }
    const f: SessionFile = { path: info.filePath, mtimeMs: 0, size: 0 }
    try {
      const messages = ad.parseMessages(f)
      if (!messages) return { ok: false, err: '该 agent 暂不支持对话重放', messages: [] }
      return { ok: true, err: '', messages }
    } catch {
      return { ok: false, err: '解析失败', messages: [] }
    }
  }

  modelBreakdown(sinceMs: number): ModelBreakdown[] {
    const db = this.connection()
    const rows = db
      .prepare(
        `SELECT agent, model, effort, COUNT(*) AS requests, SUM(in_tok) AS in_tok,
                SUM(cached_tok) AS cached_tok, SUM(out_tok) AS out_tok, SUM(reason_tok) AS reason_tok,
                AVG(CASE WHEN dur_ok=1 THEN dur_ms END) AS avg_dur,
                SUM(CASE WHEN tps_ok=1 THEN out_tok + reason_tok ELSE 0 END) AS gen,
                SUM(CASE WHEN tps_ok=1 THEN dur_ms ELSE 0 END) AS dur,
                MAX(time_ms) AS last_ms, SUM(in_tok + out_tok + reason_tok) AS tot
         FROM responses WHERE time_ms >= ?
         GROUP BY agent, model, effort ORDER BY tot DESC`
      )
      .all(sinceMs > 0 ? sinceMs : 0) as Array<Record<string, unknown>>
    return rows.map((r) => {
      const durMs = Number(r.dur ?? 0)
      const tpsOk = durMs > 0
      return {
        agentId: String(r.agent ?? ''),
        model: String(r.model ?? ''),
        effort: String(r.effort ?? ''),
        requests: Number(r.requests ?? 0),
        inTok: Number(r.in_tok ?? 0),
        cachedTok: Number(r.cached_tok ?? 0),
        outTok: Number(r.out_tok ?? 0),
        reasonTok: Number(r.reason_tok ?? 0),
        avgDurOk: r.avg_dur != null,
        avgDurMs: Number(r.avg_dur ?? 0),
        tpsOk,
        weightedTps: tpsOk ? Number(r.gen ?? 0) / (durMs / 1000) : 0,
        lastMs: Number(r.last_ms ?? 0)
      }
    })
  }

  agentBreakdown(sinceMs: number): AgentBreakdown[] {
    const db = this.connection()
    const rows = db
      .prepare(
        `SELECT agent, COUNT(*) AS requests, SUM(in_tok) AS in_tok, SUM(cached_tok) AS cached_tok,
                SUM(out_tok) AS out_tok, SUM(reason_tok) AS reason_tok
         FROM responses WHERE time_ms >= ?
         GROUP BY agent ORDER BY SUM(in_tok + out_tok + reason_tok) DESC`
      )
      .all(sinceMs > 0 ? sinceMs : 0) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      agentId: String(r.agent ?? ''),
      requests: Number(r.requests ?? 0),
      inTok: Number(r.in_tok ?? 0),
      cachedTok: Number(r.cached_tok ?? 0),
      outTok: Number(r.out_tok ?? 0),
      reasonTok: Number(r.reason_tok ?? 0)
    }))
  }

  toolBreakdown(sinceMs: number, limit = 30): ToolBreakdown[] {
    const db = this.connection()
    const rows = db
      .prepare(
        `SELECT t.agent, t.name, SUM(t.calls) AS calls, COUNT(DISTINCT t.session_id) AS sessions
         FROM tools t WHERE t.last_ms >= :since
         GROUP BY t.agent, t.name ORDER BY calls DESC LIMIT :lim`
      )
      .all({ since: sinceMs > 0 ? sinceMs : 0, lim: limit }) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      agentId: String(r.agent ?? ''),
      toolName: String(r.name ?? ''),
      calls: Number(r.calls ?? 0),
      sessions: Number(r.sessions ?? 0)
    }))
  }

  modelDailySeries(sinceMs: number, topModels: number): ModelDayPoint[] {
    const db = this.connection()
    // 按生成 token 排名，取前 N
    const ranked = db
      .prepare(
        `SELECT model, SUM(out_tok + reason_tok) AS g FROM responses
         WHERE time_ms >= ? AND model != '' GROUP BY model ORDER BY g DESC LIMIT ?`
      )
      .all(sinceMs > 0 ? sinceMs : 0, topModels) as Array<{ model: string }>
    if (ranked.length === 0) return []
    const keep = new Set(ranked.map((r) => r.model))
    const rows = db
      .prepare(
        `SELECT (time_ms/86400000)*86400000 AS d, model, SUM(out_tok + reason_tok) AS gen
         FROM responses WHERE time_ms >= ? GROUP BY d, model ORDER BY d`
      )
      .all(sinceMs > 0 ? sinceMs : 0) as Array<Record<string, unknown>>
    const out: ModelDayPoint[] = []
    for (const r of rows) {
      const model = String(r.model ?? '')
      if (!keep.has(model)) continue
      out.push({ dayMs: Number(r.d ?? 0), model, genTok: Number(r.gen ?? 0) })
    }
    return out
  }

  rawRows(agent: string, model: string, limit = 400): UsageRecord[] {
    const db = this.connection()
    const where: string[] = []
    const params: Record<string, unknown> = { lim: limit }
    if (agent) {
      where.push('agent = @agent')
      params.agent = agent
    }
    if (model) {
      where.push('model LIKE @model')
      params.model = '%' + model + '%'
    }
    let sql = 'SELECT * FROM responses'
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY time_ms DESC LIMIT @lim'
    const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>
    return rows.map((r) => this.rowToRecord(r))
  }

  // ───────────────────────── 归档（自有历史层） ─────────────────────────

  private loadArchive(): void {
    if (this.archiveLoaded) return
    this.archiveLoaded = true
    const path = archivePath()
    if (!existsSync(path)) return // 首次运行 —— 归档从缓存逐步建立
    try {
      const data = readFileSync(path)
      const parsed = deserializeArchive(data)
      if (!parsed) return // 未知文件 —— 忽略，从缓存重建
      this.archive = parsed
    } catch {
      /* 半截文件 —— 下次 merge 重写 */
    }
  }

  private mergeArchiveFromCache(): void {
    this.loadArchive()
    try {
      const db = this.connection()
      const tz = tzOffsetMs()
      const rows = db
        .prepare(
          `SELECT agent, session_id, model, effort,
                  (time_ms + ${tz}) / 86400000 * 86400000 - ${tz} AS d,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) AS errors,
                  SUM(in_tok) AS in_tok, SUM(out_tok) AS out_tok, SUM(reason_tok) AS reason_tok,
                  SUM(cached_tok) AS cached_tok, SUM(cache_write_tok) AS cache_write_tok,
                  SUM(CASE WHEN dur_ok=1 THEN dur_ms ELSE 0 END) AS dur_sum,
                  SUM(CASE WHEN tps_ok=1 THEN out_tok + reason_tok ELSE 0 END) AS tps_gen
           FROM responses GROUP BY agent, session_id, model, effort, d`
        )
        .all() as Array<Record<string, unknown>>
      let anyRow = false
      for (const r of rows) {
        const e: ArchiveEntry = {
          agent: String(r.agent ?? ''),
          sessionId: String(r.session_id ?? ''),
          model: String(r.model ?? ''),
          effort: String(r.effort ?? ''),
          dayMs: Number(r.d ?? 0),
          requests: Number(r.requests ?? 0),
          errors: Number(r.errors ?? 0),
          inTok: Number(r.in_tok ?? 0),
          outTok: Number(r.out_tok ?? 0),
          reasonTok: Number(r.reason_tok ?? 0),
          cachedTok: Number(r.cached_tok ?? 0),
          cacheWriteTok: Number(r.cache_write_tok ?? 0),
          durSumMs: Math.trunc(Number(r.dur_sum ?? 0)),
          tpsGenTok: Number(r.tps_gen ?? 0)
        }
        this.archive.set(archiveKey(e), e)
        anyRow = true
      }
      // 关键：空/不可读的缓存（刚清空、源短暂被锁、加载失败）绝不能把
      // 归档清空 —— 只做合并 upsert，零行意味着保留归档现有内容
      if (!anyRow) return

      // 保留期：丢弃早于配置窗口的条目（默认 2 年）
      if (this.retentionDays > 0) {
        const cutoff = localMidnight() - this.retentionDays * 86_400_000
        for (const [k, e] of this.archive) {
          if (e.dayMs < cutoff) this.archive.delete(k)
        }
      }

      // 内容没变就不重写（2s 轮询节奏）
      const blob = serializeArchive(this.archive)
      const hash = sha256Hex(blob)
      if (hash === this.archiveHash) return
      this.archiveHash = hash
      const path = archivePath()
      mkdirSync(dirname(path), { recursive: true })
      // 原子替换：Windows 上 rename 不能覆盖已有文件 → 先写 .tmp 再 replace；
      // 写入/替换任一步失败都保留旧归档（本拍内存态照常服务，下拍重试）
      const tmp = path + '.tmp'
      try {
        writeFileSync(tmp, blob)
        renameSync(tmp, path)
      } catch {
        try {
          unlinkSync(tmp)
        } catch {
          /* tmp 也不存在 —— 忽略 */
        }
      }
    } catch {
      /* 归档写失败不致命 —— 下拍重试 */
    }
  }

  archiveInfo(): ArchiveInfo {
    this.loadArchive()
    return { entries: this.archive.size, path: archivePath(), retentionDays: this.retentionDays }
  }

  archiveAgentIds(): string[] {
    this.loadArchive()
    if (this.archive.size > 0) {
      const ids = new Set<string>()
      for (const e of this.archive.values()) ids.add(e.agent)
      return [...ids].sort()
    }
    const db = this.connection()
    const rows = db.prepare('SELECT DISTINCT agent FROM responses').all() as Array<{ agent: string }>
    return [...new Set(rows.map((r) => r.agent))].sort()
  }

  archiveModelFamilies(): string[] {
    this.loadArchive()
    if (this.archive.size > 0) {
      const fams = new Set<string>()
      for (const e of this.archive.values()) {
        const f = modelFamily(e.model)
        if (f) fams.add(f)
      }
      return [...fams].sort()
    }
    const db = this.connection()
    const rows = db
      .prepare(
        `SELECT DISTINCT lower(substr(model, 1, instr(model || '-', '-') - 1)) AS f
         FROM responses WHERE model != ''`
      )
      .all() as Array<{ f: string }>
    return [...new Set(rows.map((r) => r.f).filter(Boolean))].sort()
  }

  dailyTotals(agent: string, family: string): DailyTotal[] {
    this.loadArchive()
    if (this.archive.size > 0) {
      const byDay = new Map<number, number>()
      for (const e of this.archive.values()) {
        if (agent && e.agent !== agent) continue
        if (family && modelFamily(e.model) !== family) continue
        byDay.set(e.dayMs, (byDay.get(e.dayMs) ?? 0) + e.inTok + e.outTok + e.reasonTok)
      }
      return [...byDay.entries()].map(([dayMs, tokens]) => ({ dayMs, tokens })).sort((a, b) => a.dayMs - b.dayMs)
    }
    // 归档为空（首扫之前 / 归档刚被清空）：退回缓存库
    const db = this.connection()
    const { where, params } = statsFilter(agent, family)
    let sql = `SELECT (time_ms + ${tzOffsetMs()}) / 86400000 * 86400000 - ${tzOffsetMs()} AS d,
                      SUM(in_tok + out_tok + reason_tok) AS tokens FROM responses`
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' GROUP BY d ORDER BY d'
    const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>
    return rows.map((r) => ({ dayMs: Number(r.d ?? 0), tokens: Number(r.tokens ?? 0) }))
  }

  agentTotals(agent: string, family: string): AgentTotal[] {
    this.loadArchive()
    if (this.archive.size > 0) {
      const byAgent = new Map<string, AgentTotal>()
      for (const e of this.archive.values()) {
        if (agent && e.agent !== agent) continue
        if (family && modelFamily(e.model) !== family) continue
        const t = byAgent.get(e.agent) ?? { agent: e.agent, requests: 0, inTok: 0, outTok: 0, reasonTok: 0 }
        t.requests += e.requests
        t.inTok += e.inTok
        t.outTok += e.outTok
        t.reasonTok += e.reasonTok
        byAgent.set(e.agent, t)
      }
      return [...byAgent.values()].sort(
        (a, b) => b.inTok + b.outTok + b.reasonTok - (a.inTok + a.outTok + a.reasonTok)
      )
    }
    const db = this.connection()
    const { where, params } = statsFilter(agent, family)
    let sql = `SELECT agent, COUNT(*) AS requests, SUM(in_tok) AS in_tok, SUM(out_tok) AS out_tok,
                      SUM(reason_tok) AS reason_tok FROM responses`
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' GROUP BY agent ORDER BY SUM(in_tok + out_tok + reason_tok) DESC'
    const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      agent: String(r.agent ?? ''),
      requests: Number(r.requests ?? 0),
      inTok: Number(r.in_tok ?? 0),
      outTok: Number(r.out_tok ?? 0),
      reasonTok: Number(r.reason_tok ?? 0)
    }))
  }

  dailyTokensByModel(sinceMs: number, topModels: number, agent: string, family: string): ModelDayPoint[] {
    this.loadArchive()
    if (this.archive.size > 0) {
      const totals = new Map<string, number>()
      const perModelDay = new Map<string, Map<number, number>>()
      for (const e of this.archive.values()) {
        if (agent && e.agent !== agent) continue
        if (family && modelFamily(e.model) !== family) continue
        const tok = e.inTok + e.outTok + e.reasonTok
        totals.set(e.model, (totals.get(e.model) ?? 0) + tok)
        const days = perModelDay.get(e.model) ?? new Map<number, number>()
        days.set(e.dayMs, (days.get(e.dayMs) ?? 0) + tok)
        perModelDay.set(e.model, days)
      }
      const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1])
      const keep = new Set(ranked.slice(0, topModels).map(([m]) => m))
      const out: ModelDayPoint[] = []
      for (const [model, days] of perModelDay) {
        if (!keep.has(model)) continue
        for (const [dayMs, tok] of days) {
          if (sinceMs > 0 && dayMs < sinceMs) continue
          out.push({ dayMs, model, genTok: tok })
        }
      }
      return out.sort((a, b) => a.dayMs - b.dayMs)
    }
    // 归档为空：退回缓存库（按窗口总量取前 N）
    const db = this.connection()
    const rankFilter = statsFilter(agent, family)
    let rankSql = 'SELECT model, SUM(in_tok + out_tok + reason_tok) AS t FROM responses WHERE model != \'\''
    if (rankFilter.where.length) rankSql += ' AND ' + rankFilter.where.join(' AND ')
    rankSql += ' GROUP BY model ORDER BY t DESC LIMIT @top'
    rankFilter.params.top = topModels
    const ranked = db.prepare(rankSql).all(rankFilter.params) as Array<{ model: string }>
    if (ranked.length === 0) return []
    const keep = new Set(ranked.map((r) => r.model))
    const { where, params } = statsFilter(agent, family)
    where.unshift('time_ms >= @since')
    params.since = sinceMs > 0 ? sinceMs : 0
    let sql = `SELECT (time_ms + ${tzOffsetMs()}) / 86400000 * 86400000 - ${tzOffsetMs()} AS d,
                      model, SUM(in_tok + out_tok + reason_tok) AS gen
               FROM responses WHERE ${where.join(' AND ')} GROUP BY d, model ORDER BY d`
    const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>
    const out: ModelDayPoint[] = []
    for (const r of rows) {
      const model = String(r.model ?? '')
      if (!keep.has(model)) continue
      out.push({ dayMs: Number(r.d ?? 0), model, genTok: Number(r.gen ?? 0) })
    }
    return out
  }

  longestSessionActiveMs(agent: string, family: string): number {
    this.loadArchive()
    let best = -1
    const liveAgents = new Set<string>()
    // ① 有官方聊天时长口径的 agent（zcode：Σ 已完成 turn 时长）实时报数；
    // ② 文件型 agent 退回归档的每会话流式时长和
    for (const a of this.adapters) {
      if (agent && agent !== a.id) continue
      if (!a.longestChatMs) continue
      const live = a.longestChatMs(familyLikePattern(family))
      if (live >= 0) {
        best = Math.max(best, live)
        liveAgents.add(a.id)
      }
    }
    if (this.archive.size > 0) {
      const perSession = new Map<string, number>()
      for (const e of this.archive.values()) {
        if (liveAgents.has(e.agent)) continue // 该 agent 的实时口径更权威
        if (agent && e.agent !== agent) continue
        if (family && modelFamily(e.model) !== family) continue
        const k = e.agent + '\x1f' + e.sessionId
        perSession.set(k, (perSession.get(k) ?? 0) + e.durSumMs)
      }
      for (const v of perSession.values()) best = Math.max(best, v)
    }
    return Math.max(best, 0)
  }

  // ───────────────────────── 体检：ZCode 源库深检 ─────────────────────────
  // TTFT / 破坏性操作 / 重试账单 —— 这些字段只有 ZCode 源库有，直接实时查询
  // （源库自带保留期，这里展示的是"现状诊断"而非历史统计）。

  zcodeDiagnostics(sinceMs: number): ZcodeDiagnostics {
    const empty: ZcodeDiagnostics = {
      available: false,
      sinceMs,
      ttft: [],
      destructiveCalls: 0,
      failedCalls: 0,
      contextExceeded: 0,
      tools: [],
      recentDangerous: [],
      retriedCalls: 0,
      retryCount: 0,
      wastedTokens: 0,
      topErrors: []
    }
    const since = sinceMs > 0 ? sinceMs : 0
    let db: import('better-sqlite3').Database
    try {
      db = openReadonly(zcodeDbPath(), 'zcode-src')
    } catch {
      return empty
    }
    try {
      // ① TTFT：逐响应首字延迟 → 按模型聚合（P50/P90 用样本计算）
      const ttftRows = db
        .prepare(
          `SELECT model_id, time_to_first_token_ms AS ttft
           FROM model_usage WHERE completed_at >= ? AND time_to_first_token_ms > 0
           LIMIT 40000`
        )
        .all(since) as Array<{ model_id: string; ttft: number }>
      const byModel = new Map<string, number[]>()
      for (const r of ttftRows) {
        const m = r.model_id || '未知'
        const arr = byModel.get(m) ?? []
        arr.push(Number(r.ttft))
        byModel.set(m, arr)
      }
      const pct = (arr: number[], p: number): number => {
        if (arr.length === 0) return 0
        const s = [...arr].sort((a, b) => a - b)
        return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
      }
      const ttft = [...byModel.entries()]
        .map(([model, arr]) => ({
          model,
          count: arr.length,
          avgMs: arr.reduce((a, b) => a + b, 0) / arr.length,
          p50Ms: pct(arr, 0.5),
          p90Ms: pct(arr, 0.9)
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)

      // ② 安全审计：破坏性调用 / 失败调用 / 上下文超限
      const sec = db
        .prepare(
          `SELECT COUNT(*) AS calls,
                  SUM(CASE WHEN destructive = 1 THEN 1 ELSE 0 END) AS destructive,
                  SUM(CASE WHEN exit_code IS NOT NULL AND exit_code != 0 THEN 1 ELSE 0 END) AS failed
           FROM tool_usage WHERE started_at >= ?`
        )
        .get(since) as { calls: number; destructive: number | null; failed: number | null }
      const tools = (
        db
          .prepare(
            `SELECT tool_name AS tool, COUNT(*) AS calls,
                    SUM(CASE WHEN destructive = 1 THEN 1 ELSE 0 END) AS destructive,
                    SUM(CASE WHEN exit_code IS NOT NULL AND exit_code != 0 THEN 1 ELSE 0 END) AS failed
             FROM tool_usage WHERE started_at >= ?
             GROUP BY tool_name ORDER BY destructive DESC, failed DESC, calls DESC LIMIT 12`
          )
          .all(since) as Array<{ tool: string; calls: number; destructive: number | null; failed: number | null }>
      ).map((t) => ({
        tool: t.tool,
        calls: Number(t.calls ?? 0),
        destructive: Number(t.destructive ?? 0),
        failed: Number(t.failed ?? 0)
      }))
      const recentDangerous = (
        db
          .prepare(
            `SELECT tool_name AS tool, started_at AS timeMs, status,
                    COALESCE(exit_code, 0) AS exitCode
             FROM tool_usage
             WHERE started_at >= ? AND (destructive = 1 OR (exit_code IS NOT NULL AND exit_code != 0))
             ORDER BY started_at DESC LIMIT 20`
          )
          .all(since) as Array<{ tool: string; timeMs: number; status: string; exitCode: number }>
      ).map((r) => ({
        tool: r.tool,
        timeMs: Number(r.timeMs) || 0,
        status: String(r.status ?? ''),
        exitCode: Number(r.exitCode) || 0
      }))
      const ctx = db
        .prepare(
          `SELECT COUNT(*) AS n FROM model_usage WHERE completed_at >= ? AND context_exceeded = 1`
        )
        .get(since) as { n: number }

      // ③ 重试账单
      const retry = db
        .prepare(
          `SELECT SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) AS retried,
                  SUM(retry_count) AS retries,
                  SUM(CASE WHEN retry_count > 0 THEN input_tokens + output_tokens + reasoning_tokens ELSE 0 END) AS wasted
           FROM model_usage WHERE completed_at >= ?`
        )
        .get(since) as { retried: number | null; retries: number | null; wasted: number | null }
      const topErrors = (
        db
          .prepare(
            `SELECT error_type AS type, COUNT(*) AS n FROM model_usage
             WHERE completed_at >= ? AND error_type IS NOT NULL AND error_type != ''
             GROUP BY error_type ORDER BY n DESC LIMIT 8`
          )
          .all(since) as Array<{ type: string; n: number }>
      ).map((r) => ({ type: r.type, count: Number(r.n ?? 0) }))

      return {
        available: true,
        sinceMs: since,
        ttft,
        destructiveCalls: Number(sec.destructive ?? 0),
        failedCalls: Number(sec.failed ?? 0),
        contextExceeded: Number(ctx.n ?? 0),
        tools,
        recentDangerous,
        retriedCalls: Number(retry.retried ?? 0),
        retryCount: Number(retry.retries ?? 0),
        wastedTokens: Number(retry.wasted ?? 0),
        topErrors
      }
    } catch {
      dropReadonly('zcode-src')
      return empty
    }
  }

  // 托盘日报：今天 vs 昨天 + 主力模型
  dailyDigest(): DailyDigest {
    const db = this.connection()
    const today = localMidnight()
    const yesterday = today - 86_400_000
    const q = db
      .prepare(
        `SELECT SUM(in_tok + out_tok + reason_tok) AS tok, COUNT(*) AS req
         FROM responses WHERE time_ms >= ? AND time_ms < ?`
      )
    const t = q.get(today, today + 86_400_000) as { tok: number | null; req: number }
    const y = q.get(yesterday, today) as { tok: number | null; req: number }
    const models = db
      .prepare(
        `SELECT model, SUM(out_tok + reason_tok) AS g FROM responses
         WHERE time_ms >= ? AND model != '' GROUP BY model ORDER BY g DESC LIMIT 2`
      )
      .all(today) as Array<{ model: string; g: number }>
    // 完整生成量用于占比
    const allGen = db
      .prepare(`SELECT SUM(out_tok + reason_tok) AS g FROM responses WHERE time_ms >= ?`)
      .get(today) as { g: number | null }
    const genTotal = Number(allGen.g ?? 0)
    return {
      tokens: Number(t.tok ?? 0),
      requests: Number(t.req ?? 0),
      yesterdayTokens: Number(y.tok ?? 0),
      topModel: models[0]?.model ?? '',
      topModelPct: genTotal > 0 && models[0] ? (Number(models[0].g) / genTotal) * 100 : 0
    }
  }

  // 合并另一台机器的归档（多机统计合并）：按 key 做 max 合并后重写
  mergeArchiveFile(filePath: string): ArchiveMergeResult {
    this.loadArchive()
    try {
      const data = readFileSync(filePath)
      const parsed = deserializeArchive(data)
      if (!parsed) return { added: 0, total: this.archive.size }
      let added = 0
      for (const [k, e] of parsed) {
        const prev = this.archive.get(k)
        if (!prev) {
          this.archive.set(k, e)
          added++
        } else {
          // 同 key 重叠（同一份数据在两台机器都出现过）：逐字段取大，避免重复计数
          this.archive.set(k, {
            ...prev,
            requests: Math.max(prev.requests, e.requests),
            errors: Math.max(prev.errors, e.errors),
            inTok: Math.max(prev.inTok, e.inTok),
            outTok: Math.max(prev.outTok, e.outTok),
            reasonTok: Math.max(prev.reasonTok, e.reasonTok),
            cachedTok: Math.max(prev.cachedTok, e.cachedTok),
            cacheWriteTok: Math.max(prev.cacheWriteTok, e.cacheWriteTok),
            durSumMs: Math.max(prev.durSumMs, e.durSumMs),
            tpsGenTok: Math.max(prev.tpsGenTok, e.tpsGenTok)
          })
        }
      }
      this.mergeArchiveFromCache() // 重写 bin（同时合并缓存，幂等）
      return { added, total: this.archive.size }
    } catch {
      return { added: 0, total: this.archive.size }
    }
  }

  agentStatuses(): AgentStatus[] {
    return this.statusCache
  }

  // ───────────────────────── 项目洞察 / 急刹车 / 重放 / 深度扫描 ─────────────────────────

  // 项目排行榜：按会话 cwd 聚合（join sessions 拿项目）
  projectStats(sinceMs: number): ProjectStat[] {
    const db = this.connection()
    const rows = db
      .prepare(
        `SELECT s.cwd AS project,
                COUNT(DISTINCT r.session_id) AS sessions,
                COUNT(*) AS requests,
                SUM(r.in_tok) AS in_tok, SUM(r.out_tok) AS out_tok,
                SUM(r.reason_tok) AS reason_tok, SUM(r.cached_tok) AS cached_tok,
                SUM(CASE WHEN r.error IS NOT NULL AND r.error != '' THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN r.error IN ('cancelled_by_user','turn_aborted') THEN 1 ELSE 0 END) AS aborts,
                SUM(CASE WHEN r.tps_ok=1 THEN r.out_tok + r.reason_tok ELSE 0 END) AS gen,
                SUM(CASE WHEN r.tps_ok=1 THEN r.dur_ms ELSE 0 END) AS dur,
                MAX(r.time_ms) AS last_ms,
                GROUP_CONCAT(DISTINCT r.agent) AS agents
         FROM responses r JOIN sessions s ON s.agent = r.agent AND s.session_id = r.session_id
         WHERE r.time_ms >= ? AND s.cwd IS NOT NULL AND s.cwd != ''
         GROUP BY s.cwd
         ORDER BY SUM(r.in_tok + r.out_tok + r.reason_tok) DESC`
      )
      .all(sinceMs > 0 ? sinceMs : 0) as Array<Record<string, unknown>>
    return rows.map((r) => {
      const durMs = Number(r.dur ?? 0)
      const tpsOk = durMs > 0
      const project = String(r.project ?? '')
      return {
        project,
        name: project.split(/[\\/]/).filter(Boolean).pop() || project || '（未知项目）',
        agents: String(r.agents ?? '').split(',').filter(Boolean),
        sessions: Number(r.sessions ?? 0),
        requests: Number(r.requests ?? 0),
        inTok: Number(r.in_tok ?? 0),
        outTok: Number(r.out_tok ?? 0),
        reasonTok: Number(r.reason_tok ?? 0),
        cacheTok: Number(r.cached_tok ?? 0),
        errors: Number(r.errors ?? 0),
        aborts: Number(r.aborts ?? 0),
        tpsOk,
        weightedTps: tpsOk ? Number(r.gen ?? 0) / (durMs / 1000) : 0,
        lastMs: Number(r.last_ms ?? 0)
      }
    })
  }

  // 急刹车指数：打断率 + 被打断烧掉的 token + 按模型 / 按小时分布
  brakeStats(sinceMs: number): BrakeStats {
    const db = this.connection()
    const since = sinceMs > 0 ? sinceMs : 0
    const abortIn = `error IN ('cancelled_by_user','turn_aborted')`
    const overall = db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN ${abortIn} THEN 1 ELSE 0 END) AS aborts,
                SUM(CASE WHEN ${abortIn} THEN in_tok + out_tok + reason_tok ELSE 0 END) AS aborted_tok
         FROM responses WHERE time_ms >= ?`
      )
      .get(since) as Record<string, unknown>

    const byModelRows = db
      .prepare(
        `SELECT model, COUNT(*) AS requests,
                SUM(CASE WHEN ${abortIn} THEN 1 ELSE 0 END) AS aborts,
                SUM(CASE WHEN ${abortIn} THEN in_tok + out_tok + reason_tok ELSE 0 END) AS aborted_tok
         FROM responses WHERE time_ms >= ? AND model != ''
         GROUP BY model ORDER BY aborts DESC LIMIT 12`
      )
      .all(since) as Array<Record<string, unknown>>

    // 本地小时分桶（对齐本地时区）
    const tz = tzOffsetMs()
    const hourRows = db
      .prepare(
        `SELECT ((time_ms + ${tz}) / 3600000) % 24 AS h, COUNT(*) AS requests,
                SUM(CASE WHEN ${abortIn} THEN 1 ELSE 0 END) AS aborts
         FROM responses WHERE time_ms >= ? GROUP BY h`
      )
      .all(since) as Array<{ h: number; requests: number; aborts: number }>
    const byHour: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      requests: 0,
      aborts: 0
    }))
    for (const r of hourRows) {
      const h = Number(r.h) || 0
      const bucket = byHour[h]
      if (bucket) {
        bucket.requests = Number(r.requests ?? 0)
        bucket.aborts = Number(r.aborts ?? 0)
      }
    }

    const byModel: BrakeModelRow[] = byModelRows.map((r) => ({
      model: String(r.model ?? ''),
      requests: Number(r.requests ?? 0),
      aborts: Number(r.aborts ?? 0),
      abortedTok: Number(r.aborted_tok ?? 0)
    }))

    return {
      sinceMs: since,
      requests: Number(overall.requests ?? 0),
      aborts: Number(overall.aborts ?? 0),
      abortedTok: Number(overall.aborted_tok ?? 0),
      byModel,
      byHour
    }
  }

  // 一日重放：[startMs, endMs) 窗口内的全部响应（按时间升序）。
  // 窗口由调用方给定（单日 / 近 24 小时），止于"现在"，绝不播放未来。
  dayReplay(startMs: number, endMs: number): DayReplayRow[] {
    const db = this.connection()
    const rows = db
      .prepare(
        `SELECT time_ms, agent, model, in_tok, out_tok, reason_tok, tps, dur_ok, error
         FROM responses WHERE time_ms >= ? AND time_ms < ?
         ORDER BY time_ms LIMIT 30000`
      )
      .all(startMs, endMs) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      timeMs: Number(r.time_ms ?? 0),
      agentId: String(r.agent ?? ''),
      model: String(r.model ?? ''),
      inTok: Number(r.in_tok ?? 0),
      outTok: Number(r.out_tok ?? 0),
      reasonTok: Number(r.reason_tok ?? 0),
      tps: Number(r.tps ?? 0),
      durOk: !!r.dur_ok,
      error: String(r.error ?? '')
    }))
  }

  // 深度扫描（有界）：最近会话的对话重放 →
  //   · 文件热点：工具调用里的文件路径 + 归因生成 token（响应 → 下一个文件工具）
  //   · 重试环：同参数同工具 ≥3 次重复（卡死烧钱信号）
  deepScan(sinceMs: number): DeepScanResult {
    const db = this.connection()
    const since = sinceMs > 0 ? sinceMs : 0
    const budgetMs = 8000
    const started = Date.now()
    const sessions = db
      .prepare(
        `SELECT agent, session_id, path, cwd FROM sessions
         WHERE updated >= ? AND agent IN ('zcode','claude','codex')
         ORDER BY updated DESC LIMIT 80`
      )
      .all(since) as Array<{ agent: string; session_id: string; path: string; cwd: string }>

    const hotspots = new Map<string, FileHotspot>()
    const loops = new Map<string, LoopHit>()
    let scannedSessions = 0
    let truncated = false

    // 文件路径提取：工具参数 JSON 里的常见键
    const extractFile = (toolName: string, text: string): string | null => {
      if (!text || text === '{}' || text === '""') return null
      try {
        const o = JSON.parse(text) as Record<string, unknown>
        const v = (o.file_path ?? o.path ?? o.notebook_path ?? o.filename ?? o.target_file) as unknown
        if (typeof v === 'string' && v.trim()) return v.trim()
      } catch {
        /* arguments 非合法 JSON —— 跳过 */
      }
      void toolName
      return null
    }

    for (const s of sessions) {
      if (Date.now() - started > budgetMs) {
        truncated = true
        break
      }
      const ad = this.adapters.find((a) => a.id === s.agent)
      if (!ad?.parseMessages) continue
      const info = this.sessionInfo(s.agent, s.session_id)
      if (!info.filePath) continue
      try {
        const messages = ad.parseMessages({ path: info.filePath, mtimeMs: 0, size: 0 })
        if (!messages || messages.length === 0) continue

        // 文件事件 + 归因：响应(out+reason) → 时间上紧跟其后的文件工具调用
        const responses = this.sessionRecords(s.agent, s.session_id)
        const fileEvents: Array<{ timeMs: number; file: string }> = []
        const pairCount = new Map<string, number>()
        let lastPair = ''
        let lastPairAt = 0

        for (const m of messages) {
          if (m.role === 'tool' && m.toolName) {
            const file = extractFile(m.toolName, m.text)
            if (file) fileEvents.push({ timeMs: m.timeMs, file })
            // 重试环：相邻两次完全相同的 (tool + args)
            const pair = m.toolName + '\x1f' + (m.text ?? '')
            if (pair === lastPair && m.timeMs - lastPairAt < 600_000) {
              pairCount.set(pair, (pairCount.get(pair) ?? 2) + 1)
            } else {
              pairCount.set(pair, Math.max(1, pairCount.get(pair) ?? 1))
            }
            lastPair = pair
            lastPairAt = m.timeMs
          }
        }
        // 相同 (tool+args) 出现 ≥3 次 → 卡死环
        for (const [pair, count] of pairCount) {
          if (count >= 3) {
            const [tool, args] = pair.split('\x1f')
            const key = s.session_id + '\x1f' + pair
            const prev = loops.get(key)
            const repeats = Math.max(count, prev?.repeats ?? 0)
            loops.set(key, {
              sessionId: s.session_id,
              agentId: s.agent,
              tool: tool ?? '',
              repeats,
              args: (args ?? '').slice(0, 120)
            })
          }
        }

        // 归因
        const respSorted = responses
          .map((r) => ({ timeMs: r.timeMs, tok: r.outputTokens + r.reasoningTokens }))
          .filter((r) => r.tok > 0)
          .sort((a, b) => a.timeMs - b.timeMs)
        const filesSorted = fileEvents.sort((a, b) => a.timeMs - b.timeMs)
        for (const resp of respSorted) {
          const next = filesSorted.find((fe) => fe.timeMs >= resp.timeMs && fe.timeMs - resp.timeMs <= 600_000)
          if (!next) continue
          let key = next.file
          if (info.cwd && next.file.toLowerCase().startsWith(info.cwd.toLowerCase())) {
            key = next.file.slice(info.cwd.length).replace(/^[\\/]/, '')
          }
          const h = hotspots.get(key) ?? { file: key, edits: 0, tokens: 0 }
          h.edits++
          h.tokens += resp.tok
          hotspots.set(key, h)
        }
        scannedSessions++
      } catch {
        /* 单会话解析失败 —— 跳过 */
      }
    }

    const hotspotsList = [...hotspots.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 40)
    const loopsList = [...loops.values()].sort((a, b) => b.repeats - a.repeats).slice(0, 20)
    return { scannedSessions, truncated, hotspots: hotspotsList, loops: loopsList }
  }

  lastScanMs(): number {
    return this.m_lastScanMs
  }

  familyNames(): Array<{ key: string; display: string }> {
    return this.archiveModelFamilies().map((k) => ({ key: k, display: familyDisplay(k) }))
  }
}

// ── 共享小工具 ──

function emptyKpis(): Kpis {
  return {
    requests: 0,
    sessions: 0,
    errors: 0,
    inTok: 0,
    outTok: 0,
    reasonTok: 0,
    cacheRead: 0,
    cacheWrite: 0,
    avgDurOk: false,
    avgDurMs: 0,
    tpsOk: false,
    weightedTps: 0,
    tpsSamples: 0
  }
}

function emptySession(): SessionInfo {
  return {
    agentId: '',
    sessionId: '',
    filePath: '',
    title: '',
    cwd: '',
    model: '',
    originator: '',
    startedMs: 0,
    updatedMs: 0,
    responses: 0,
    toolCalls: 0,
    errors: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    contextWindow: 0
  }
}

function sessionFilter(agent: string, search: string): ParsedQuery {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (agent) {
    where.push('agent = @agent')
    params.agent = agent
  }
  if (search) {
    where.push('(title LIKE @s OR cwd LIKE @s OR model LIKE @s OR session_id LIKE @s)')
    params.s = '%' + search + '%'
  }
  return { where, params }
}

function statsFilter(agent: string, family: string): ParsedQuery {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (agent) {
    where.push('agent = @agent')
    params.agent = agent
  }
  if (family) {
    where.push("(lower(model) LIKE @famPat OR lower(model) = @fam)")
    params.famPat = family + '-%'
    params.fam = family
  }
  return { where, params }
}

// family 参数 → zcode live SQL 的 LIKE 模式（'glm' → 'glm-%'；空 = 不过滤）
function familyLikePattern(family: string): string {
  return family ? family.toLowerCase() + '-%' : ''
}

export type { ParseResult }
