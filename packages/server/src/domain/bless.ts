// 夸夸群领域：一条「夸夸」广播给所有 active 鱼（每人一条 event(kind='bless')），无金额。
// 纯新增、不接线。listBless 按 blessId 归并，避免每个 recipient 重复出现在列表里。
import { getFish, newId } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { DomainError } from './errors.ts'

export const BLESS_MAX_CHARS = 200

export interface BlessResult {
  blessId: string
  by: string
  text: string
  ts: number
  /** 实际写到多少条 active 鱼 */
  recipients: number
}

export interface BlessItem {
  blessId: string
  by: string
  text: string
  ts: number
  /** 收到这条夸夸的鱼数 */
  recipients: number
}

interface EventRow {
  id: number
  fish_id: string
  kind: string
  data_json: string
  ts: number
}

function parseData(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 发一条夸夸：写给所有 status='active' 的鱼各一条 event(kind='bless')。
 * 返回 blessId（并附 recipients 人数）。文本必填、≤200 字。
 */
export function createBless(db: DB, byFishId: string, input: { text: string }, now: number = Date.now()): BlessResult {
  const by = getFish(db, byFishId)
  if (!by) throw new DomainError('NOT_FOUND', `fish not found: ${byFishId}`)
  const text = typeof input?.text === 'string' ? input.text.trim() : ''
  if (text === '') throw new DomainError('BAD_REQUEST', 'bless text is required')
  const chars = [...text].length
  if (chars > BLESS_MAX_CHARS) {
    throw new DomainError('BAD_REQUEST', `bless too long: ${chars} > ${BLESS_MAX_CHARS}`, {
      detail: { chars, limit: BLESS_MAX_CHARS },
    })
  }

  const blessId = newId('bless')
  const tsSec = Math.floor(now / 1000)
  const fishes = db.prepare(`SELECT id FROM fish WHERE status = 'active'`).all() as unknown as { id: string }[]
  const payload = JSON.stringify({ blessId, by: byFishId, byName: by.name, text })
  const ins = db.prepare('INSERT INTO event(fish_id, kind, data_json, ts, read_at) VALUES(?,?,?,?,NULL)')
  let recipients = 0
  for (const f of fishes) {
    ins.run(f.id, 'bless', payload, tsSec)
    recipients++
  }
  return { blessId, by: byFishId, text, ts: now, recipients }
}

/** 夸夸列表：按 blessId 归并，最近发布优先，默认 20 条、上限 200。 */
export function listBless(db: DB, limit = 20): BlessItem[] {
  const n = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 20
  const rows = db
    .prepare(`SELECT id, fish_id, kind, data_json, ts FROM event WHERE kind = 'bless' ORDER BY id DESC`)
    .all() as unknown as EventRow[]
  const map = new Map<string, BlessItem>()
  for (const r of rows) {
    const d = parseData(r.data_json)
    const blessId = typeof d.blessId === 'string' ? d.blessId : 'bless_' + r.id
    const existing = map.get(blessId)
    if (existing) {
      existing.recipients += 1
      continue
    }
    if (map.size >= n) continue
    map.set(blessId, {
      blessId,
      by: typeof d.by === 'string' ? d.by : '',
      text: typeof d.text === 'string' ? d.text : '',
      ts: Number(r.ts) * 1000,
      recipients: 1,
    })
  }
  return [...map.values()]
}
