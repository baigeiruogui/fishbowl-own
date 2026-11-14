import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/index.ts'
import { cleanupEvents, cleanupTurns } from '../src/maintenance.ts'

const NOW = 1_000_000_000_000 // ms

function insertTurn(
  db: ReturnType<typeof openDb>,
  id: string,
  state: string,
  deadline: number,
  createdAt = NOW,
) {
  db.prepare(
    'INSERT INTO turn(id, fish_id, kind, deadline, packet_json, state, answer, created_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(id, 'f1', 'agency', deadline, '{}', state, null, createdAt)
}

function insertEvent(db: ReturnType<typeof openDb>, ts: number, readAt: number | null) {
  db.prepare('INSERT INTO event(fish_id, kind, data_json, ts, read_at) VALUES(?,?,?,?,?)').run(
    'f1',
    'k',
    '{}',
    ts,
    readAt,
  )
}

function turnIds(db: ReturnType<typeof openDb>): string[] {
  return (db.prepare('SELECT id FROM turn ORDER BY id').all() as unknown as { id: string }[]).map((r) => r.id)
}

function eventCount(db: ReturnType<typeof openDb>): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM event').get() as { c: number }).c)
}

const OLDER = 60_000 // 60s

// 1. cleanupTurns：closed 一律删，过期超时的删，其余保留；计数正确
test('cleanupTurns：删已关闭/过期回合，保留进行中与未过期的', () => {
  const db = openDb(':memory:')
  insertTurn(db, 't_closed_old', 'closed', NOW + 999999, NOW - 100000)
  insertTurn(db, 't_closed_new', 'closed', NOW + 999999, NOW) // 已关闭，无论多新都删
  insertTurn(db, 't_expired_old', 'pending', NOW - 120000, NOW - 120000) // deadline < now-60s
  insertTurn(db, 't_expired_recent', 'pending', NOW - 30000, NOW - 30000) // 刚过期，未超 olderThanMs
  insertTurn(db, 't_future', 'pending', NOW + 60000, NOW)

  const deleted = cleanupTurns(db, { olderThanMs: OLDER, now: NOW })
  assert.equal(deleted, 3)
  assert.deepEqual(turnIds(db), ['t_expired_recent', 't_future'])
  db.close()
})

// 2. cleanupTurns 幂等
test('cleanupTurns：重复调用幂等，第二次删除 0', () => {
  const db = openDb(':memory:')
  insertTurn(db, 't_closed', 'closed', NOW, NOW)
  insertTurn(db, 't_future', 'pending', NOW + 60000, NOW)
  assert.equal(cleanupTurns(db, { olderThanMs: OLDER, now: NOW }), 1)
  assert.equal(cleanupTurns(db, { olderThanMs: OLDER, now: NOW }), 0)
  assert.deepEqual(turnIds(db), ['t_future'])
  db.close()
})

// 3. cleanupTurns 空库返回 0
test('cleanupTurns：空库返回 0', () => {
  const db = openDb(':memory:')
  assert.equal(cleanupTurns(db, { olderThanMs: OLDER, now: NOW }), 0)
  db.close()
})

// 4. cleanupEvents keepUnread=true（默认）：只删已读旧事件
test('cleanupEvents：默认 keepUnread 只删已读旧事件，保留未读与近期', () => {
  const db = openDb(':memory:')
  const oldSec = Math.floor((NOW - 3600_000) / 1000) // 1 小时前
  const recentSec = Math.floor(NOW / 1000)
  insertEvent(db, oldSec, NOW - 3600_000) // 已读旧 → 删
  insertEvent(db, oldSec, null) // 未读旧 → 保留
  insertEvent(db, recentSec, NOW) // 已读但近期 → 保留

  const deleted = cleanupEvents(db, { olderThanMs: OLDER, now: NOW })
  assert.equal(deleted, 1)
  assert.equal(eventCount(db), 2)
  db.close()
})

// 5. cleanupEvents keepUnread=false：旧事件（含未读）全删，近期保留
test('cleanupEvents：keepUnread=false 删除所有旧事件', () => {
  const db = openDb(':memory:')
  const oldSec = Math.floor((NOW - 3600_000) / 1000)
  const recentSec = Math.floor(NOW / 1000)
  insertEvent(db, oldSec, NOW - 3600_000) // 已读旧 → 删
  insertEvent(db, oldSec, null) // 未读旧 → 删
  insertEvent(db, recentSec, null) // 近期 → 保留

  const deleted = cleanupEvents(db, { olderThanMs: OLDER, keepUnread: false, now: NOW })
  assert.equal(deleted, 2)
  assert.equal(eventCount(db), 1)
  db.close()
})

// 6. cleanupEvents 幂等
test('cleanupEvents：重复调用幂等，第二次删除 0', () => {
  const db = openDb(':memory:')
  const oldSec = Math.floor((NOW - 3600_000) / 1000)
  insertEvent(db, oldSec, NOW)
  assert.equal(cleanupEvents(db, { olderThanMs: OLDER, now: NOW }), 1)
  assert.equal(cleanupEvents(db, { olderThanMs: OLDER, now: NOW }), 0)
  db.close()
})

// 7. cleanupEvents 空库 / olderThanMs 参数校验
test('cleanupEvents：空库返回 0；非法 olderThanMs 抛错', () => {
  const db = openDb(':memory:')
  assert.equal(cleanupEvents(db, { olderThanMs: 0, now: NOW }), 0)
  assert.throws(() => cleanupEvents(db, { olderThanMs: -1, now: NOW }), /olderThanMs/)
  assert.throws(() => cleanupTurns(db, { olderThanMs: -5, now: NOW }), /olderThanMs/)
  db.close()
})
