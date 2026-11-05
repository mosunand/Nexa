// main/core/util.ts — 数据层通用工具：行读取器、时间换算、模型大类、归档二进制 IO。
// 对应老项目的 QFile::readLine(kLineCap)、isoToMs、modelFamily 与 QDataStream 归档格式。

import { createHash } from 'node:crypto'
import { closeSync, openSync, opendirSync, readSync, statSync, type Dir } from 'node:fs'
import { join } from 'node:path'

// ── 会话文件探测（增量扫描的最小单位） ──

export interface SessionFile {
  path: string
  mtimeMs: number
  size: number
}

export interface ToolStat {
  calls: number
  firstMs: number
  lastMs: number
}

// ── ISO-8601 → epoch ms（无效/空返回 0） ──

export function isoToMs(s: string | undefined | null): number {
  if (!s) return 0
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

// ── 逐行读取（替代 QFile::readLine(kLineCap)） ──
// 超过 cap 的"荒谬行"整行丢弃（防御坏文件），与 C++ 版语义一致。

export function* readLines(filePath: string, capBytes = 4 * 1024 * 1024): Generator<string> {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(256 * 1024)
    let pending: Buffer = Buffer.alloc(0)
    let eof = false
    while (!eof) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) {
        eof = true
      } else {
        pending = pending.length === 0 ? buf.subarray(0, n) : Buffer.concat([pending, buf.subarray(0, n)])
      }
      let idx: number
      while ((idx = pending.indexOf(0x0a)) >= 0) {
        let line = pending.subarray(0, idx)
        pending = pending.subarray(idx + 1)
        if (line.length > capBytes) continue // 荒谬行 → 丢弃
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
        if (line.length > 0) yield line.toString('utf8')
      }
      // 文件结束但残留一行（无换行结尾）
      if (eof && pending.length > 0 && pending.length <= capBytes) {
        yield pending.toString('utf8')
      }
      if (eof) break
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// 快速子串探测（codex 新格式 pre-pass）：只扫字节，不做 JSON 解析
export function fileContains(filePath: string, needle: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(256 * 1024)
    const nbuf = Buffer.from(needle, 'utf8')
    let tail: Buffer = Buffer.alloc(0)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) return false
      const chunk = tail.length ? Buffer.concat([tail, buf.subarray(0, n)]) : buf.subarray(0, n)
      if (chunk.includes(nbuf)) return true
      tail = chunk.subarray(Math.max(0, chunk.length - nbuf.length + 1))
    }
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ── 目录递归枚举（对应 QDirIterator Subdirectories） ──

export function walkFiles(root: string, exts: string[]): SessionFile[] {
  const out: SessionFile[] = []
  const extSet = new Set(exts.map((e) => e.toLowerCase()))
  const visit = (dir: string, depth: number): void => {
    if (depth > 16) return // 防御符号链接环
    let d: Dir
    try {
      d = opendirSync(dir)
    } catch {
      return
    }
    try {
      for (;;) {
        let ent
        try {
          ent = d.readSync()
        } catch {
          break
        }
        if (!ent) break
        const p = join(dir, ent.name)
        if (ent.isDirectory()) {
          visit(p, depth + 1)
        } else if (ent.isFile()) {
          const dot = ent.name.lastIndexOf('.')
          if (dot < 0) continue
          const ext = ent.name.slice(dot).toLowerCase()
          if (!extSet.has(ext)) continue
          try {
            const st = statSync(p)
            out.push({ path: p, mtimeMs: Math.floor(st.mtimeMs), size: st.size })
          } catch {
            /* 竞态：文件刚被删 → 跳过 */
          }
        }
      }
    } finally {
      d.closeSync()
    }
  }
  visit(root, 0)
  return out
}

// ── 模型大类："GLM-5.3-Flash" / "glm-5.3" → "glm" ──

export function modelFamily(model: string): string {
  const lower = model.toLowerCase().trim()
  const dash = lower.indexOf('-')
  return dash > 0 ? lower.slice(0, dash) : lower
}

const FAMILY_DISPLAY: Record<string, string> = {
  glm: 'GLM',
  gpt: 'GPT',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  claude: 'Claude',
  gemini: 'Gemini',
  qwen: 'Qwen',
  qwen3: 'Qwen',
  o3: 'O3',
  o4: 'O4'
}

export function familyDisplay(family: string): string {
  return FAMILY_DISPLAY[family.toLowerCase()] ?? family
}

// ── 本地时区工具（日聚合对齐本地午夜） ──

export function tzOffsetMs(now = Date.now()): number {
  return -new Date(now).getTimezoneOffset() * 60_000
}

export function localMidnight(now = Date.now()): number {
  const tz = tzOffsetMs(now)
  return Math.floor((now + tz) / 86_400_000) * 86_400_000 - tz
}

// ── 自有二进制归档（与老项目 AGMON v2 格式逐字节兼容） ──
// 8 字节 magic + uint32 version + uint32 count，每条：4 个 (uint16 len + utf8)
// 字符串（agent/session/model/effort）+ 10 个 int64 LE。

const MAGIC = Buffer.from([0x41, 0x47, 0x4d, 0x4f, 0x4e, 0x41, 0x52, 0x01]) // AGMON\x41\x52\x01
const ARCHIVE_VERSION = 2

export interface ArchiveEntry {
  agent: string
  sessionId: string
  model: string
  effort: string
  dayMs: number
  requests: number
  errors: number
  inTok: number
  outTok: number
  reasonTok: number
  cachedTok: number
  cacheWriteTok: number
  durSumMs: number
  tpsGenTok: number
}

export function archiveKey(e: Pick<ArchiveEntry, 'agent' | 'sessionId' | 'model' | 'effort' | 'dayMs'>): string {
  return [e.agent, e.sessionId, e.model, e.effort, String(e.dayMs)].join('\x1f')
}

function putStr(parts: Buffer[], s: string): void {
  const b = Buffer.from(s, 'utf8')
  const lh = Buffer.alloc(2)
  lh.writeUInt16LE(Math.min(b.length, 0xffff), 0)
  parts.push(lh, b.subarray(0, 0xffff))
}

function putInts(parts: Buffer[], values: number[]): void {
  const ints = Buffer.alloc(values.length * 8)
  values.forEach((v, i) => ints.writeBigInt64LE(BigInt(Math.trunc(v)), i * 8))
  parts.push(ints)
}

export function serializeArchive(entries: Map<string, ArchiveEntry>): Buffer {
  const header = Buffer.alloc(16)
  MAGIC.copy(header, 0)
  header.writeUInt32LE(ARCHIVE_VERSION, 8)
  header.writeUInt32LE(entries.size, 12)
  const parts: Buffer[] = [header]
  for (const e of entries.values()) {
    putStr(parts, e.agent)
    putStr(parts, e.sessionId)
    putStr(parts, e.model)
    putStr(parts, e.effort)
    putInts(parts, [
      e.dayMs,
      e.requests,
      e.errors,
      e.inTok,
      e.outTok,
      e.reasonTok,
      e.cachedTok,
      e.cacheWriteTok,
      e.durSumMs,
      e.tpsGenTok
    ])
  }
  return Buffer.concat(parts)
}

export function deserializeArchive(data: Buffer): Map<string, ArchiveEntry> | null {
  if (data.length < 16 || !data.subarray(0, 8).equals(MAGIC)) return null
  const version = data.readUInt32LE(8)
  if (version !== ARCHIVE_VERSION) return null
  const count = data.readUInt32LE(12)
  const out = new Map<string, ArchiveEntry>()
  let off = 16
  const readStr = (): string => {
    if (off + 2 > data.length) return ''
    const len = data.readUInt16LE(off)
    off += 2
    if (off + len > data.length) {
      off = data.length
      return ''
    }
    const s = data.subarray(off, off + len).toString('utf8')
    off += len
    return s
  }
  for (let i = 0; i < count && off + 2 <= data.length; i++) {
    const agent = readStr()
    const sessionId = readStr()
    const model = readStr()
    const effort = readStr()
    if (off + 80 > data.length) break // 半截尾巴：忽略，下次 merge 重写
    const ints: number[] = []
    for (let k = 0; k < 10; k++) {
      ints.push(Number(data.readBigInt64LE(off + k * 8)))
    }
    off += 80
    const e: ArchiveEntry = {
      agent,
      sessionId,
      model,
      effort,
      dayMs: ints[0] ?? 0,
      requests: ints[1] ?? 0,
      errors: ints[2] ?? 0,
      inTok: ints[3] ?? 0,
      outTok: ints[4] ?? 0,
      reasonTok: ints[5] ?? 0,
      cachedTok: ints[6] ?? 0,
      cacheWriteTok: ints[7] ?? 0,
      durSumMs: ints[8] ?? 0,
      tpsGenTok: ints[9] ?? 0
    }
    out.set(archiveKey(e), e)
  }
  return out
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
