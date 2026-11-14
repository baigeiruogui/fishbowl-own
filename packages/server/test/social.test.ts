import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, getFish, openDb } from '../src/db/index.ts'
import { ledgerSum, startOfLocalDay, DAY_MS } from '../src/domain/account.ts'
import { dailySocialUsed, gift, socialBudget } from '../src/domain/social.ts'

function setMeta(db: ReturnType<typeof openDb>, k: string, v: string) {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v)
}

function giftLedgerCount(db: ReturnType<typeof openDb>, fishId: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM ledger WHERE fish_id = ? AND reason = 'gift'`).get(fishId) as { c: number }
  return Number(r.c)
}

// 1. 默认预算 50 鱼币（50 分 × 1）
test('socialBudget：默认 50 分 × 1 = 50 鱼币；可配置换算率', () => {
  const db = openDb(':memory:')
  const f = createFish(db, { name: '鱼', balance: 100 })
  assert.equal(socialBudget(db, f.id), 50)
  setMeta(db, 'fishcoin_per_cent', '2')
  assert.equal(socialBudget(db, f.id), 100)
  setMeta(db, 'social_day_cents', '10')
  assert.equal(socialBudget(db, f.id), 20)
  db.close()
})

// 2. 送礼成功：送礼人扣款、账本 reason=gift、收礼人不进账
test('gift：送礼成功扣款，reason=gift，收礼人余额不变', () => {
  const db = openDb(':memory:')
  const from = createFish(db, { name: '送礼鱼', balance: 100 })
  const to = createFish(db, { name: '收礼鱼', balance: 0 })
  const r = gift(db, from.id, to.id, { item: '贝壳', price: 10, words: '给你' })

  assert.equal(r.price, 10)
  assert.equal(r.balance, 90)
  assert.equal(r.usedToday, 10)
  assert.equal(r.budget, 50)
  assert.equal(getFish(db, from.id)!.balance, 90)
  assert.equal(getFish(db, to.id)!.balance, 0)
  assert.equal(dailySocialUsed(db, from.id), 10)

  const row = db
    .prepare(`SELECT delta, reason, ref FROM ledger WHERE fish_id = ? AND reason = 'gift'`)
    .get(from.id) as { delta: number; reason: string; ref: string }
  assert.equal(Number(row.delta), -10)
  assert.equal(row.reason, 'gift')
  assert.equal(row.ref, r.ref)
  db.close()
})

// 3. 不能送给自己
test('gift：不能送给自己', () => {
  const db = openDb(':memory:')
  const f = createFish(db, { name: '自恋鱼', balance: 100 })
  assert.throws(() => gift(db, f.id, f.id, { item: '花', price: 5 }), (e: any) => e.code === 'BAD_REQUEST')
  assert.equal(dailySocialUsed(db, f.id), 0)
  db.close()
})

// 4. 礼价必须是正整数
test('gift：礼价 <=0 / 非整数被拒', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 100 })
  const b = createFish(db, { name: 'B', balance: 0 })
  for (const bad of [0, -1, 1.5]) {
    assert.throws(() => gift(db, a.id, b.id, { item: 'x', price: bad as number }), (e: any) => e.code === 'BAD_REQUEST')
  }
  assert.equal(giftLedgerCount(db, a.id), 0)
  db.close()
})

// 5. 鱼不存在
test('gift：送礼/收礼鱼不存在 → NOT_FOUND', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 100 })
  assert.throws(() => gift(db, a.id, 'f_nope', { item: 'x', price: 5 }), (e: any) => e.code === 'NOT_FOUND')
  assert.throws(() => gift(db, 'f_nope', a.id, { item: 'x', price: 5 }), (e: any) => e.code === 'NOT_FOUND')
  db.close()
})

// 6. 每日社交预算超限拒绝且无副作用
test('gift：每日社交预算超限 → DAY_CAP，且无副作用', () => {
  const db = openDb(':memory:')
  setMeta(db, 'social_day_cents', '10') // 预算 10
  const a = createFish(db, { name: 'A', balance: 100 })
  const b = createFish(db, { name: 'B', balance: 0 })

  gift(db, a.id, b.id, { item: '小礼', price: 6 })
  assert.equal(dailySocialUsed(db, a.id), 6)

  const before = getFish(db, a.id)!.balance
  assert.throws(() => gift(db, a.id, b.id, { item: '再送', price: 6 }), (e: any) => e.code === 'DAY_CAP')
  assert.equal(getFish(db, a.id)!.balance, before) // 未扣
  assert.equal(dailySocialUsed(db, a.id), 6) // 记账未变
  assert.equal(giftLedgerCount(db, a.id), 1)
  db.close()
})

// 7. 余额不足 → INSUFFICIENT（预算足够但钱不够）
test('gift：余额不足抛 INSUFFICIENT 且不透支', () => {
  const db = openDb(':memory:')
  setMeta(db, 'social_day_cents', '1000') // 预算放大，避免先撞预算
  const a = createFish(db, { name: '穷鱼', balance: 20 })
  const b = createFish(db, { name: 'B', balance: 0 })

  assert.throws(() => gift(db, a.id, b.id, { item: '贵礼', price: 100 }), (e: any) => e.code === 'INSUFFICIENT')
  assert.equal(getFish(db, a.id)!.balance, 20)
  assert.equal(dailySocialUsed(db, a.id), 0)
  assert.equal(giftLedgerCount(db, a.id), 0)
  db.close()
})

// 8. dailySocialUsed 按自然日重置
test('dailySocialUsed：昨天的送礼不计入今天', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 100 })
  const now = Date.now()
  const yesterday = startOfLocalDay(now) - DAY_MS + 12 * 3600_000
  db.prepare('INSERT INTO ledger(fish_id, delta, balance_after, reason, ref, ts) VALUES(?,?,?,?,?,?)').run(
    a.id,
    -40,
    60,
    'gift',
    'old',
    yesterday,
  )
  assert.equal(dailySocialUsed(db, a.id, now), 0)
  const r = gift(db, a.id, createFish(db, { name: 'B', balance: 0 }).id, { item: 'x', price: 10 }, now)
  assert.equal(r.usedToday, 10)
  db.close()
})

// 9. 送礼写一条 event(kind='gift') 记录礼物详情
test('gift：写 event 记录礼物详情（to/item/price/words）', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 100 })
  const b = createFish(db, { name: 'B', balance: 0 })
  const r = gift(db, a.id, b.id, { item: '玫瑰', price: 8, words: '生日快乐' })

  const ev = db
    .prepare(`SELECT data_json FROM event WHERE fish_id = ? AND kind = 'gift'`)
    .get(a.id) as { data_json: string }
  assert.ok(ev)
  const data = JSON.parse(ev.data_json)
  assert.equal(data.to, b.id)
  assert.equal(data.item, '玫瑰')
  assert.equal(data.price, 8)
  assert.equal(data.words, '生日快乐')
  assert.equal(data.ref, r.ref)
  db.close()
})

// 10. 不变量：多次送礼后 账本 gift 求和 == 余额减少量
test('gift：账本不透支，ledgerSum 与余额保持一致', () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 100 })
  const b = createFish(db, { name: 'B', balance: 0 })
  gift(db, a.id, b.id, { item: 'x', price: 10 })
  gift(db, a.id, b.id, { item: 'y', price: 15 })
  assert.equal(dailySocialUsed(db, a.id), 25)
  assert.equal(getFish(db, a.id)!.balance, 75)
  assert.equal(ledgerSum(db, a.id), 75)
  db.close()
})
