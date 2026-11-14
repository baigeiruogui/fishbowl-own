// SQLite 访问层：打开库、迁移、事务、账本不变量。domain 层在此之上构建。
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { Fish, LedgerReason } from '@fishbowl/shared'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(join(here, 'schema.sql'), 'utf8')

export type DB = DatabaseSync

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  db.exec(SCHEMA)
  return db
}

export function newId(prefix: string): string {
  return prefix + '_' + randomBytes(8).toString('hex')
}

/** 事务包装（BEGIN IMMEDIATE）。嵌套请用 savepoint 版（postLedger 自带）。 */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw e
  }
}

export interface LedgerResult { balance: number; delta: number }

/**
 * 账本核心：唯一允许改余额的入口。delta>0 赚，delta<0 花；余额不足抛 INSUFFICIENT。
 * 用 SAVEPOINT 保证可独立调用、也可嵌套在外层事务里。
 */
export function postLedger(db: DB, fishId: string, delta: number, reason: LedgerReason, ref: string | null = null): LedgerResult {
  if (!Number.isInteger(delta)) throw Object.assign(new Error('delta must be integer'), { code: 'BAD_REQUEST' })
  db.exec('SAVEPOINT ledger')
  try {
    const row = db.prepare('SELECT balance FROM fish WHERE id = ?').get(fishId) as { balance: number } | undefined
    if (!row) throw Object.assign(new Error('fish not found'), { code: 'NOT_FOUND' })
    const after = row.balance + delta
    if (after < 0) throw Object.assign(new Error('insufficient balance'), { code: 'INSUFFICIENT', balance: row.balance })
    db.prepare('UPDATE fish SET balance = ? WHERE id = ?').run(after, fishId)
    db.prepare('INSERT INTO ledger(fish_id, delta, balance_after, reason, ref, ts) VALUES(?,?,?,?,?,?)')
      .run(fishId, delta, after, reason, ref, Date.now())
    db.exec('RELEASE ledger')
    return { balance: after, delta }
  } catch (e) {
    try { db.exec('ROLLBACK TO ledger'); db.exec('RELEASE ledger') } catch { /* ignore */ }
    throw e
  }
}

interface FishRow {
  id: string; owner_id: string | null; name: string; kind: string; persona: string; intro: string;
  look_note: string; avatar: string; status: string; balance: number; day_cap: number | null;
  quiet_hours: string; created_at: number
}

export function rowToFish(r: FishRow): Fish {
  return {
    id: r.id, ownerId: r.owner_id, name: r.name, kind: r.kind as Fish['kind'],
    persona: r.persona, intro: r.intro, lookNote: r.look_note, avatar: r.avatar,
    status: r.status as Fish['status'], balance: r.balance, dayCap: r.day_cap,
    quietHours: r.quiet_hours, createdAt: r.created_at,
  }
}

export function getFish(db: DB, id: string): Fish | null {
  const r = db.prepare('SELECT * FROM fish WHERE id = ?').get(id) as FishRow | undefined
  return r ? rowToFish(r) : null
}

export function createFish(db: DB, opts: { name: string; ownerId?: string | null; kind?: Fish['kind']; persona?: string; intro?: string; balance?: number }): Fish {
  const id = newId('f')
  const now = Date.now()
  return tx(db, () => {
    db.prepare('INSERT INTO fish(id, owner_id, name, kind, persona, intro, balance, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, opts.ownerId ?? null, opts.name, opts.kind ?? 'resident', opts.persona ?? '', opts.intro ?? '', 0, 'active', now)
    if (opts.balance && opts.balance > 0) postLedger(db, id, opts.balance, 'init', 'start')
    return getFish(db, id)!
  })
}
