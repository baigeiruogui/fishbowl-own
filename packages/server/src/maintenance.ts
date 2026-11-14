// 运维清理（纯新增，不接线）：定期删除历史 turn / event，返回删除条数。
//  - cleanupTurns：删除「已关闭」或「过期超过 olderThanMs」的回合。
//  - cleanupEvents：删除「超过 olderThanMs」的事件；keepUnread=true 时只删已读的。
// 说明：turn.deadline / turn.created_at 为毫秒；event.ts 存的是「秒」（与 engine/turns.recordEvent 一致）。
import type { DB } from './db/index.ts'

export interface CleanupTurnsOptions {
  /** 过期多久（毫秒）以前的回合可清（对已关闭回合不设门槛） */
  olderThanMs: number
  /** 注入时钟（测试用），默认 Date.now */
  now?: number
}

export interface CleanupEventsOptions {
  /** 早于「现在 - olderThanMs」的事件可清（毫秒） */
  olderThanMs: number
  /** true（默认）= 只删已读事件；false = 已读未读都删 */
  keepUnread?: boolean
  /** 注入时钟（测试用），默认 Date.now */
  now?: number
}

function assertOlderThanMs(v: number): number {
  if (!Number.isFinite(v) || v < 0) throw new Error('olderThanMs must be a non-negative number')
  return v
}

/**
 * 清理回合：state='closed' 一律删；state<>'closed' 且 deadline 早于 (now - olderThanMs) 的过期回合也删。
 * 返回删除行数（幂等：重复调用第二次为 0）。
 */
export function cleanupTurns(db: DB, opts: CleanupTurnsOptions): number {
  const olderThanMs = assertOlderThanMs(Number(opts?.olderThanMs))
  const now = opts?.now ?? Date.now()
  const cutoff = now - olderThanMs
  const res = db.prepare(`DELETE FROM turn WHERE state = 'closed' OR (state <> 'closed' AND deadline < ?)`).run(cutoff)
  return Number(res.changes)
}

/**
 * 清理事件：删除 ts 早于 (now - olderThanMs) 的事件。
 * keepUnread !== false 时只删 read_at 非空的已读事件（默认保护未读）。返回删除行数。
 */
export function cleanupEvents(db: DB, opts: CleanupEventsOptions): number {
  const olderThanMs = assertOlderThanMs(Number(opts?.olderThanMs))
  const now = opts?.now ?? Date.now()
  const keepUnread = opts?.keepUnread !== false
  const cutoffSec = Math.floor((now - olderThanMs) / 1000)
  const res = keepUnread
    ? db.prepare('DELETE FROM event WHERE ts < ? AND read_at IS NOT NULL').run(cutoffSec)
    : db.prepare('DELETE FROM event WHERE ts < ?').run(cutoffSec)
  return Number(res.changes)
}
