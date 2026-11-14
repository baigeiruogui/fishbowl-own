// 人际关系领域：好友关系（relationship 表 kind='friend'），无金额。
// 关系去重：以 (min(a,b), max(a,b)) 规范化存储，保证 a↔b 只有一个方向、天然对称/幂等。
import { getFish } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { DomainError } from './errors.ts'

export interface RelationView {
  /** 好友（对方的 fishId） */
  fishId: string
  kind: 'friend'
  since: number
}

export interface MakeFriendsResult {
  a: string
  b: string
  kind: 'friend'
  since: number
  /** 本次是否新建（false = 已经是好友） */
  created: boolean
}

function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

function rowExists(db: DB, a: string, b: string): { since: number } | undefined {
  const [x, y] = canonical(a, b)
  return db
    .prepare(`SELECT since FROM relationship WHERE a = ? AND b = ? AND kind = 'friend'`)
    .get(x, y) as { since: number } | undefined
}

/** 交朋友：幂等去重；不能和自己做朋友。 */
export function makeFriends(db: DB, a: string, b: string, now: number = Date.now()): MakeFriendsResult {
  if (a === b) throw new DomainError('BAD_REQUEST', 'cannot befriend yourself')
  if (!getFish(db, a)) throw new DomainError('NOT_FOUND', `fish not found: ${a}`)
  if (!getFish(db, b)) throw new DomainError('NOT_FOUND', `fish not found: ${b}`)

  const [x, y] = canonical(a, b)
  const existing = rowExists(db, a, b)
  if (existing) {
    return { a: x, b: y, kind: 'friend', since: existing.since, created: false }
  }
  const res = db
    .prepare(`INSERT OR IGNORE INTO relationship(a, b, kind, since) VALUES(?,?, 'friend', ?)`)
    .run(x, y, now)
  const row = rowExists(db, a, b)!
  return { a: x, b: y, kind: 'friend', since: row.since, created: Number(res.changes) > 0 }
}

/** 是否好友（对称）。 */
export function areFriends(db: DB, a: string, b: string): boolean {
  if (a === b) return false
  return rowExists(db, a, b) !== undefined
}

/** 某条鱼的全部好友（去重、按结识时间升序）。 */
export function listRelations(db: DB, fishId: string): RelationView[] {
  const rows = db
    .prepare(
      `SELECT a, b, since FROM relationship
       WHERE kind = 'friend' AND (a = ? OR b = ?) ORDER BY since ASC, id ASC`,
    )
    .all(fishId, fishId) as unknown as { a: string; b: string; since: number }[]
  const seen = new Set<string>()
  const out: RelationView[] = []
  for (const r of rows) {
    const friendId = r.a === fishId ? r.b : r.a
    if (seen.has(friendId)) continue
    seen.add(friendId)
    out.push({ fishId: friendId, kind: 'friend', since: Number(r.since) })
  }
  return out
}

/** 好友数量（去重后的好友数）。 */
export function friendCount(db: DB, fishId: string): number {
  return listRelations(db, fishId).length
}
