import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, openDb } from '../src/db/index.ts'
import { makeFriends } from '../src/domain/relationship.ts'
import { listMessages, sendMessage, sentToday, PHONE_DAILY_LIMIT, PHONE_MAX_CHARS } from '../src/domain/phone.ts'

function setup() {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 0 })
  const b = createFish(db, { name: 'B', balance: 0 })
  return { db, a, b }
}

// 1. 好友之间发消息成功，双方都能看到
test('sendMessage：好友之间发送成功，双方 listMessages 可见', () => {
  const { db, a, b } = setup()
  makeFriends(db, a.id, b.id)
  const m = sendMessage(db, a.id, b.id, { text: '你好呀' }, 1000)
  assert.equal(m.fromFishId, a.id)
  assert.equal(m.toFishId, b.id)
  assert.equal(m.text, '你好呀')
  assert.equal(m.ts, 1000)
  assert.equal(m.readAt, null)

  assert.equal(listMessages(db, a.id).length, 1)
  assert.equal(listMessages(db, b.id).length, 1)
  db.close()
})

// 2. 非好友不能发消息
test('sendMessage：非好友不能发消息', () => {
  const { db, a, b } = setup()
  assert.throws(() => sendMessage(db, a.id, b.id, { text: 'hi' }), (e: any) => e.code === 'BAD_REQUEST')
  assert.equal(listMessages(db, a.id).length, 0)
  db.close()
})

// 3. 不能发给自己
test('sendMessage：不能发给自己', () => {
  const { db, a } = setup()
  assert.throws(() => sendMessage(db, a.id, a.id, { text: 'hi' }), (e: any) => e.code === 'BAD_REQUEST')
  db.close()
})

// 4. 空消息拒绝
test('sendMessage：空文本被拒', () => {
  const { db, a, b } = setup()
  makeFriends(db, a.id, b.id)
  assert.throws(() => sendMessage(db, a.id, b.id, { text: '   ' }), (e: any) => e.code === 'BAD_REQUEST')
  db.close()
})

// 5. 超过 60 字拒绝
test('sendMessage：超过 60 字被拒', () => {
  const { db, a, b } = setup()
  makeFriends(db, a.id, b.id)
  assert.throws(() => sendMessage(db, a.id, b.id, { text: '鱼'.repeat(61) }), (e: any) => e.code === 'BAD_REQUEST')
  db.close()
})

// 6. 正好 60 字可以发
test('sendMessage：正好 60 字允许', () => {
  const { db, a, b } = setup()
  makeFriends(db, a.id, b.id)
  const text = '鱼'.repeat(PHONE_MAX_CHARS)
  const m = sendMessage(db, a.id, b.id, { text })
  assert.equal([...m.text].length, 60)
  db.close()
})

// 7. 每天 20 条上限
test('sendMessage：每日 20 条上限，超出 DAY_CAP', () => {
  const { db, a, b } = setup()
  makeFriends(db, a.id, b.id)
  for (let i = 0; i < PHONE_DAILY_LIMIT; i++) {
    sendMessage(db, a.id, b.id, { text: '第' + i + '条' })
  }
  assert.equal(sentToday(db, a.id), PHONE_DAILY_LIMIT)
  assert.throws(() => sendMessage(db, a.id, b.id, { text: '超限' }), (e: any) => e.code === 'DAY_CAP')
  assert.equal(sentToday(db, a.id), PHONE_DAILY_LIMIT)
  db.close()
})

// 8. 每日上限按发送者独立计算
test('sendMessage：每日上限按发送者独立计算', () => {
  const { db, a, b } = setup()
  makeFriends(db, a.id, b.id)
  for (let i = 0; i < PHONE_DAILY_LIMIT; i++) sendMessage(db, a.id, b.id, { text: 'a' + i })
  // a 封顶后，b 仍可发
  const m = sendMessage(db, b.id, a.id, { text: 'b 的第一条' })
  assert.equal(m.fromFishId, b.id)
  assert.equal(sentToday(db, b.id), 1)
  db.close()
})

// 9. listMessages：按时间倒序、limit 生效
test('listMessages：倒序返回并遵守 limit', () => {
  const { db, a, b } = setup()
  makeFriends(db, a.id, b.id)
  sendMessage(db, a.id, b.id, { text: 'm1' }, 1000)
  sendMessage(db, a.id, b.id, { text: 'm2' }, 2000)
  sendMessage(db, b.id, a.id, { text: 'm3' }, 3000)

  const all = listMessages(db, a.id)
  assert.deepEqual(all.map((m) => m.text), ['m3', 'm2', 'm1'])
  const one = listMessages(db, a.id, 1)
  assert.equal(one.length, 1)
  assert.equal(one[0].text, 'm3')
  db.close()
})

// 10. 鱼不存在
test('sendMessage：鱼不存在 → NOT_FOUND', () => {
  const { db, a, b } = setup()
  makeFriends(db, a.id, b.id)
  assert.throws(() => sendMessage(db, a.id, 'f_nope', { text: 'hi' }), (e: any) => e.code === 'NOT_FOUND')
  assert.throws(() => sendMessage(db, 'f_nope', a.id, { text: 'hi' }), (e: any) => e.code === 'NOT_FOUND')
  db.close()
})
