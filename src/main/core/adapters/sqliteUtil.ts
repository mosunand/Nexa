// main/core/adapters/sqliteUtil.ts — 只读 SQLite 源连接助手。
// 对应 C++ 版的 QThreadStorage per-thread 连接：worker 线程内每个源库
// 缓存一条只读连接，出错（库被独占/损坏）时重置，下一拍重试。

import Database from 'better-sqlite3'

const g_conns = new Map<string, Database.Database>()

export function openReadonly(dbPath: string, tag: string, busyTimeoutMs = 5000): Database.Database {
  const hit = g_conns.get(tag)
  if (hit && hit.open) return hit
  const db = new Database(dbPath, { readonly: true, timeout: busyTimeoutMs })
  db.pragma(`busy_timeout = ${busyTimeoutMs}`)
  g_conns.set(tag, db)
  return db
}

export function dropReadonly(tag: string): void {
  const hit = g_conns.get(tag)
  if (hit) {
    try {
      hit.close()
    } catch {
      /* 已损坏的连接可能关不掉 —— 无所谓，扔掉即可 */
    }
    g_conns.delete(tag)
  }
}
