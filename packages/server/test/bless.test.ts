import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, openDb } from '../src/db/index.ts'
import { ledgerSum } from '../src/domain/account.ts'
import { createBless, listBless } from '../src/domain/bless.ts'

function setStatus(db: ReturnType<typeof openDb>, fishId: string, status: string) {
  db.prepare('UPDATE fish SET status = ? WHERE id = ?').run(status, fishId)
}

function blessEventCount(db: ReturnType<typeof openDb>): number {
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM event WHERE kind = 'bless'`).get() as { c: number }).c)
}

// 1. 发夸夸：给所有 active 鱼各写一条 event
test('createBless：给所有 active 鱼各写一条 bless 事件，返回 recipients', () => {
  const db = openDb(':memory:')
  const by = createFish(db, { name: '夸夸鱼', balance: 0 })
  createFish(db, { name: '鱼一', balance: 0 })
  createFish(db, { name: '鱼二', balance: 0 })

  const r = createBless(db, by.id, { text: '你真棒！' }, 1000)
  assert.ok(r.blessId.startsWith('bless_'))
  assert.equal(r.recipients, 3) // by + 鱼一 + 鱼二 都 active
  assert.equal(blessEventCount(db), 3)

  const rows = db.prepare(`SELECT data_json FROM event WHERE kind = 'bless'`).all() as unknown as { data_json: string }[]
  const d = JSON.parse(rows[0]!.data_json)
  assert.equal(d.by, by.id)
  assert.equal(d.text, '你真棒！')
  assert.equal(d.blessId, r.blessId)
  db.close()
})

// 2. 只发给 active 鱼：paused/banned 不写
test('createBless：只发给 active 鱼，paused/banned 排除', () => {
  const db = openDb(':memory:')
  const by = createFish(db, { name: 'by', balance: 0 })
  const paused = createFish(db, { name: '暂停鱼', balance: 0 })
  const banned = createFish(db, { name: '封禁鱼', balance: 0 })
  setStatus(db, paused.id, 'paused')
  setStatus(db, banned.id, 'banned')

  const r = createBless(db, by.id, { text: '加油' }, 1000)
  assert.equal(r.recipients, 1) // 仅 by 自己 active
  const pausedCount = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM event WHERE kind='bless' AND fish_id = ?`).get(paused.id) as { c: number }).c,
  )
  const bannedCount = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM event WHERE kind='bless' AND fish_id = ?`).get(banned.id) as { c: number }).c,
  )
  assert.equal(pausedCount, 0)
  assert.equal(bannedCount, 0)
  db.close()
})

// 3. listBless：按 blessId 归并，一条夸夸只出现一次，recipients 正确
test('listBless：按 blessId 归并，不重复，recipients 正确', () => {
  const db = openDb(':memory:')
  const by = createFish(db, { name: 'by', balance: 0 })
  createFish(db, { name: '鱼一', balance: 0 }) // 共 2 条 active
  const r = createBless(db, by.id, { text: '你超厉害' }, 5000)

  const list = listBless(db)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.blessId, r.blessId)
  assert.equal(list[0]!.text, '你超厉害')
  assert.equal(list[0]!.by, by.id)
  assert.equal(list[0]!.recipients, 2) // 归并了 2 个收件事件
  assert.equal(list[0]!.ts, 5000)
  db.close()
})

// 4. 多条夸夸 + limit
test('listBless：多条按最近优先，limit 生效', () => {
  const db = openDb(':memory:')
  const by = createFish(db, { name: 'by', balance: 0 })
  createBless(db, by.id, { text: '第一条' }, 1000)
  createBless(db, by.id, { text: '第二条' }, 2000)
  createBless(db, by.id, { text: '第三条' }, 3000)

  const all = listBless(db)
  assert.equal(all.length, 3)
  assert.deepEqual(all.map((b) => b.text), ['第三条', '第二条', '第一条'])
  assert.equal(listBless(db, 2).length, 2)
  db.close()
})

// 5. 空文本拒绝，无事件写入
test('createBless：空文本被拒，不写事件', () => {
  const db = openDb(':memory:')
  const by = createFish(db, { name: 'by', balance: 0 })
  assert.throws(() => createBless(db, by.id, { text: '   ' }), (e: any) => e.code === 'BAD_REQUEST')
  assert.equal(blessEventCount(db), 0)
  db.close()
})

// 6. 超过 200 字拒绝
test('createBless：超过 200 字被拒', () => {
  const db = openDb(':memory:')
  const by = createFish(db, { name: 'by', balance: 0 })
  assert.throws(() => createBless(db, by.id, { text: '夸'.repeat(201) }), (e: any) => e.code === 'BAD_REQUEST')
  assert.equal(blessEventCount(db), 0)
  db.close()
})

// 7. 发起鱼不存在
test('createBless：发起鱼不存在 → NOT_FOUND', () => {
  const db = openDb(':memory:')
  assert.throws(() => createBless(db, 'f_nope', { text: 'hi' }), (e: any) => e.code === 'NOT_FOUND')
  db.close()
})

// 8. 没有 active 鱼：recipients=0，列表空，但返回 blessId
test('createBless：无 active 鱼时 recipients=0，listBless 为空', () => {
  const db = openDb(':memory:')
  const by = createFish(db, { name: 'by', balance: 0 })
  setStatus(db, by.id, 'paused') // by 存在但不是 active
  const r = createBless(db, by.id, { text: '自嗨' }, 1000)
  assert.ok(r.blessId.startsWith('bless_'))
  assert.equal(r.recipients, 0)
  assert.equal(listBless(db).length, 0)
  db.close()
})

// 9. 夸夸不动钱：账本无变化
test('createBless：不改动任何余额/账本', () => {
  const db = openDb(':memory:')
  const by = createFish(db, { name: 'by', balance: 100 })
  const before = ledgerSum(db, by.id)
  createBless(db, by.id, { text: '夸夸' }, 1000)
  assert.equal(ledgerSum(db, by.id), before)
  db.close()
})
