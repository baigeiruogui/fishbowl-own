import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, openDb } from '../src/db/index.ts'
import { areFriends, friendCount, listRelations, makeFriends } from '../src/domain/relationship.ts'

function relRowCount(db: ReturnType<typeof openDb>): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM relationship').get() as { c: number }).c)
}

// 1. 交朋友：建立关系，friendCount=1
test('makeFriends：建立好友关系，friendCount=1', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  const r = makeFriends(db, a.id, b.id, 1000)
  assert.equal(r.created, true)
  assert.equal(r.kind, 'friend')
  assert.equal(r.since, 1000)
  assert.equal(friendCount(db, a.id), 1)
  assert.equal(friendCount(db, b.id), 1)
  assert.equal(relRowCount(db), 1)
  db.close()
})

// 2. 幂等：重复交朋友不重复建行
test('makeFriends：重复调用幂等，不重复建行', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  makeFriends(db, a.id, b.id)
  const again = makeFriends(db, a.id, b.id)
  assert.equal(again.created, false)
  assert.equal(friendCount(db, a.id), 1)
  assert.equal(relRowCount(db), 1)
  db.close()
})

// 3. 对称：一方列表里能看到另一方
test('listRelations：关系对称，双方列表都能看到对方', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  makeFriends(db, a.id, b.id)
  assert.deepEqual(listRelations(db, a.id).map((r) => r.fishId), [b.id])
  assert.deepEqual(listRelations(db, b.id).map((r) => r.fishId), [a.id])
  db.close()
})

// 4. 不能和自己做朋友
test('makeFriends：不能和自己做朋友', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  assert.throws(() => makeFriends(db, a.id, a.id), (e: any) => e.code === 'BAD_REQUEST')
  assert.equal(friendCount(db, a.id), 0)
  db.close()
})

// 5. 陌生人：空列表 / 0 好友
test('listRelations/friendCount：陌生人无关系', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  assert.deepEqual(listRelations(db, a.id), [])
  assert.equal(friendCount(db, a.id), 0)
  assert.equal(areFriends(db, a.id, b.id), false)
  db.close()
})

// 6. 多好友计数
test('friendCount：多个好友正确计数', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  const c = createFish(db, { name: 'C', balance: 0 })
  makeFriends(db, a.id, b.id)
  makeFriends(db, a.id, c.id)
  assert.equal(friendCount(db, a.id), 2)
  assert.equal(listRelations(db, a.id).length, 2)
  db.close()
})

// 7. areFriends 对称判断
test('areFriends：双向为真，单向/自己为假', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  assert.equal(areFriends(db, a.id, b.id), false)
  makeFriends(db, a.id, b.id)
  assert.equal(areFriends(db, a.id, b.id), true)
  assert.equal(areFriends(db, b.id, a.id), true)
  assert.equal(areFriends(db, a.id, a.id), false)
  db.close()
})

// 8. 只统计 kind='friend'，其它关系类型不计入
test('listRelations：只统计 friend，其它 kind 忽略', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  db.prepare(`INSERT INTO relationship(a, b, kind, since) VALUES(?,?, 'rival', ?)`).run(a.id, b.id, 100)
  assert.equal(friendCount(db, a.id), 0)
  assert.equal(areFriends(db, a.id, b.id), false)
  db.close()
})

// 9. 规范化去重：正反顺序各调一次只存一行（a<b）
test('makeFriends：正反顺序调用只存一行，a<b 规范化', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  makeFriends(db, b.id, a.id)
  makeFriends(db, a.id, b.id)
  assert.equal(relRowCount(db), 1)
  const row = db.prepare(`SELECT a, b FROM relationship LIMIT 1`).get() as { a: string; b: string }
  assert.ok(row.a < row.b, '应以 a<b 规范化存储')
  assert.equal(friendCount(db, a.id), 1)
  db.close()
})

// 10. 鱼不存在
test('makeFriends：鱼不存在 → NOT_FOUND', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  assert.throws(() => makeFriends(db, a.id, 'f_nope'), (e: any) => e.code === 'NOT_FOUND')
  assert.throws(() => makeFriends(db, 'f_nope', a.id), (e: any) => e.code === 'NOT_FOUND')
  db.close()
})
