// 小手机领域：鱼与鱼之间发私信（phone_message 表），无金额。
// 护栏：只能发给认识（好友）的人；单条 ≤ 60 字；每人每天最多 20 条。
import { getFish } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { DomainError } from './errors.ts'
import { startOfLocalDay, DAY_MS } from './account.ts'
import { areFriends } from './relationship.ts'

export const PHONE_MAX_CHARS = 60
export const PHONE_DAILY_LIMIT = 20

export interface SendMessageInput {
  text: string
}

export interface PhoneMessageView {
  id: number
  fromFishId: string
  toFishId: string
  text: string
  ts: number
  readAt: number | null
}

interface PhoneRow {
  id: number
  from_fish: string
  to_fish: string
  text: string
  ts: number
  read_at: number | null
}

function toView(r: PhoneRow): PhoneMessageView {
  return {
    id: Number(r.id),
    fromFishId: r.from_fish,
    toFishId: r.to_fish,
    text: r.text,
    ts: Number(r.ts),
    readAt: r.read_at == null ? null : Number(r.read_at),
  }
}

/** 某条鱼今天已发出的私信条数。 */
export function sentToday(db: DB, fishId: string, now: number = Date.now()): number {
  const start = startOfLocalDay(now)
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM phone_message WHERE from_fish = ? AND ts >= ? AND ts < ?')
    .get(fishId, start, start + DAY_MS) as { c: number }
  return Number(row.c)
}

/**
 * 发私信：仅限好友；单条 ≤ 60 字；每日 ≤ 20 条。
 * 校验失败抛 DomainError（BAD_REQUEST / NOT_FOUND / DAY_CAP）。返回消息视图。
 */
export function sendMessage(
  db: DB,
  fromFishId: string,
  toFishId: string,
  input: SendMessageInput,
  now: number = Date.now(),
): PhoneMessageView {
  if (fromFishId === toFishId) throw new DomainError('BAD_REQUEST', 'cannot message yourself')
  if (!getFish(db, fromFishId)) throw new DomainError('NOT_FOUND', `fish not found: ${fromFishId}`)
  if (!getFish(db, toFishId)) throw new DomainError('NOT_FOUND', `fish not found: ${toFishId}`)

  const text = typeof input?.text === 'string' ? input.text.trim() : ''
  if (text === '') throw new DomainError('BAD_REQUEST', 'message text is required')
  const chars = [...text].length
  if (chars > PHONE_MAX_CHARS) {
    throw new DomainError('BAD_REQUEST', `message too long: ${chars} > ${PHONE_MAX_CHARS}`, {
      detail: { chars, limit: PHONE_MAX_CHARS },
    })
  }

  if (!areFriends(db, fromFishId, toFishId)) {
    throw new DomainError('BAD_REQUEST', `can only message friends: ${fromFishId} -> ${toFishId}`)
  }

  const used = sentToday(db, fromFishId, now)
  if (used >= PHONE_DAILY_LIMIT) {
    throw new DomainError('DAY_CAP', `daily message limit ${PHONE_DAILY_LIMIT} reached`, {
      detail: { kind: 'phone', limit: PHONE_DAILY_LIMIT, used },
    })
  }

  const res = db
    .prepare('INSERT INTO phone_message(from_fish, to_fish, text, ts, read_at) VALUES(?,?,?,?,NULL)')
    .run(fromFishId, toFishId, text, now)
  const row = db
    .prepare('SELECT * FROM phone_message WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as unknown as PhoneRow
  return toView(row)
}

/** 某条鱼的私信（收到 + 发出），按时间倒序，默认 20 条、上限 200。 */
export function listMessages(db: DB, fishId: string, limit = 20): PhoneMessageView[] {
  const n = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 20
  const rows = db
    .prepare(
      `SELECT * FROM phone_message WHERE from_fish = ? OR to_fish = ?
       ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(fishId, fishId, n) as unknown as PhoneRow[]
  return rows.map(toView)
}
