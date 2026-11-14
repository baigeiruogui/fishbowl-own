import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, getFish, openDb, postLedger } from '../src/db/index.ts'
import {
  addCatch,
  assertBalanceIntegrity,
  createJobOffer,
  getMarket,
  ledgerSum,
  listCatch,
  listFishContracts,
  listJobOffers,
  paySeatFee,
  quitJob,
  sellCatch,
  settleDueJobs,
  spentToday,
  startOfLocalDay,
  takeJob,
  verifyBalance,
  DAY_MS,
} from '../src/domain/index.ts'

// -------- 赚钱 1：打工（接活 → 到期结算发工资 reason=job） --------
test('打工：接活→到期结算，余额增加且账本 reason=job', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '打工鱼', balance: 100 })
  const offer = createJobOffer(db, { title: '码头搬鱼', pay: 30, durationMin: 1, slots: 2 })

  assert.equal(offer.pay, 30)
  assert.equal(offer.available, 2)

  const T0 = 1_700_000_000_000
  const contract = takeJob(db, fish.id, offer.id, T0)
  assert.equal(contract.state, 'working')
  assert.equal(contract.pay, 30)
  assert.equal(contract.endsAt, T0 + 60_000) // durationMin=1 分钟
  // 招工列表在岗人数 +1
  assert.equal(listJobOffers(db).find((o) => o.id === offer.id)!.taken, 1)

  // 未到期：不结算
  assert.deepEqual(settleDueJobs(db, T0 + 59_999), [])
  assert.equal(getFish(db, fish.id)!.balance, 100)

  // 到期：结算 +30
  const settled = settleDueJobs(db, T0 + 60_000)
  assert.equal(settled.length, 1)
  assert.equal(settled[0].pay, 30)
  assert.equal(getFish(db, fish.id)!.balance, 130)

  const rows = db
    .prepare('SELECT delta, reason, ref FROM ledger WHERE fish_id = ? AND reason = ?')
    .all(fish.id, 'job') as unknown as { delta: number; reason: string; ref: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].delta, 30)
  assert.equal(rows[0].ref, contract.id)

  // 幂等：重复结算不再发钱
  assert.deepEqual(settleDueJobs(db, T0 + 120_000), [])
  assert.equal(getFish(db, fish.id)!.balance, 130)

  assertBalanceIntegrity(db, fish.id)
  db.close()
})

test('打工：一个人同时只能接一份活；辞活不发工资', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '挑活鱼', balance: 50 })
  const a = createJobOffer(db, { title: 'A', pay: 10, durationMin: 60 })
  const b = createJobOffer(db, { title: 'B', pay: 12, durationMin: 60 })

  const c = takeJob(db, fish.id, a.id)
  assert.throws(() => takeJob(db, fish.id, b.id), (e: any) => e.code === 'ALREADY_WORKING')

  const quit = quitJob(db, fish.id, c.id)
  assert.equal(quit.state, 'quit')
  assert.equal(getFish(db, fish.id)!.balance, 50) // 辞活不结算
  assert.equal(listFishContracts(db, fish.id, 'working').length, 0)
  // 辞了就能接新的
  assert.doesNotThrow(() => takeJob(db, fish.id, b.id))
  assertBalanceIntegrity(db, fish.id)
  db.close()
})

test('打工：名额满了接不了（NO_SLOTS）', () => {
  const db = openDb(':memory:')
  const offer = createJobOffer(db, { title: '唯一坑位', pay: 10, durationMin: 60, slots: 1 })
  const f1 = createFish(db, { name: '鱼1', balance: 0 })
  const f2 = createFish(db, { name: '鱼2', balance: 0 })
  takeJob(db, f1.id, offer.id)
  assert.throws(() => takeJob(db, f2.id, offer.id), (e: any) => e.code === 'NO_SLOTS')
  db.close()
})

// -------- 赚钱 2：钓鱼卖钱（产出 → 卖 → reason=fish_sell） --------
test('钓鱼卖钱：产出到 catch，按市场价卖出，余额与账本正确', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '钓鱼鱼', balance: 0 })

  addCatch(db, fish.id, '鲈鱼', 3)
  addCatch(db, fish.id, '鲫鱼', 2)
  const holdings = listCatch(db, fish.id)
  const held = Object.fromEntries(holdings.map((h) => [h.item, h.qty]))
  assert.deepEqual(held, { 鲫鱼: 2, 鲈鱼: 3 })
  // 市场行情里能看到她的持有与市场价
  const market = getMarket(db, fish.id)
  assert.equal(market.find((m) => m.item === '鲈鱼')!.price, 20)
  assert.equal(market.find((m) => m.item === '鲈鱼')!.owned, 3)

  // 卖 2 条鲈鱼：20 * 2 = 40
  const res = sellCatch(db, fish.id, { item: '鲈鱼', qty: 2 })
  assert.equal(res.price, 20)
  assert.equal(res.amount, 40)
  assert.equal(res.balance, 40)
  assert.equal(getFish(db, fish.id)!.balance, 40)
  assert.equal(listCatch(db, fish.id).find((h) => h.item === '鲈鱼')!.qty, 1)

  const rows = db
    .prepare('SELECT delta, reason FROM ledger WHERE fish_id = ? AND reason = ?')
    .all(fish.id, 'fish_sell') as unknown as { delta: number; reason: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].delta, 40)

  // 全部卖光鲫鱼：8 * 2 = 16
  const res2 = sellCatch(db, fish.id, { item: '鲫鱼' })
  assert.equal(res2.amount, 16)
  assert.equal(getFish(db, fish.id)!.balance, 56)

  assertBalanceIntegrity(db, fish.id)
  db.close()
})

test('钓鱼卖钱：按 catchId 单条部分卖出；超量/不存在要报错', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '分卖鱼', balance: 0 })
  const c = addCatch(db, fish.id, '螃蟹', 4) // 45/只

  const r = sellCatch(db, fish.id, { catchId: c.id, qty: 1 })
  assert.equal(r.amount, 45)
  assert.equal(listCatch(db, fish.id).find((h) => h.item === '螃蟹')!.qty, 3)

  assert.throws(() => sellCatch(db, fish.id, { catchId: c.id, qty: 99 }), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => sellCatch(db, fish.id, { catchId: 'catch_nope' }), (e: any) => e.code === 'NOT_FOUND')
  assert.throws(() => sellCatch(db, fish.id, { item: '龙虾' }), (e: any) => e.code === 'NOT_FOUND')
  assertBalanceIntegrity(db, fish.id)
  db.close()
})

// -------- 花钱：座位费（reason=seat_fee） --------
test('座位费：入座扣费，余额减少且账本 reason=seat_fee', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '入座鱼', balance: 100 })

  const r = paySeatFee(db, fish.id, { fee: 15, ref: 'table_1' })
  assert.equal(r.spent, 15)
  assert.equal(r.balance, 85)
  assert.equal(getFish(db, fish.id)!.balance, 85)

  const row = db
    .prepare('SELECT delta, reason, ref FROM ledger WHERE fish_id = ? AND reason = ?')
    .get(fish.id, 'seat_fee') as unknown as { delta: number; reason: string; ref: string }
  assert.equal(row.delta, -15)
  assert.equal(row.ref, 'table_1')

  // fee=0 免费入座，不写账本
  const before = ledgerSum(db, fish.id)
  const r0 = paySeatFee(db, fish.id, 0)
  assert.equal(r0.spent, 0)
  assert.equal(ledgerSum(db, fish.id), before)

  assertBalanceIntegrity(db, fish.id)
  db.close()
})

// -------- 不透支：余额不足抛 INSUFFICIENT，余额与账本不变 --------
test('座位费：余额不足抛 INSUFFICIENT 且不透支', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '穷鱼', balance: 10 })
  const before = ledgerSum(db, fish.id)

  assert.throws(() => paySeatFee(db, fish.id, 50), (e: any) => e.code === 'INSUFFICIENT')
  assert.equal(getFish(db, fish.id)!.balance, 10)
  assert.equal(ledgerSum(db, fish.id), before) // 没有留下任何账本记录
  assertBalanceIntegrity(db, fish.id)
  db.close()
})

// -------- 每日消费上限 day_cap --------
test('day_cap：当日累计消费超上限抛 DAY_CAP 且不扣款', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '有预算鱼', balance: 100 })
  db.prepare('UPDATE fish SET day_cap = ? WHERE id = ?').run(30, fish.id)

  const now = Date.now()
  paySeatFee(db, fish.id, { fee: 20, now }) // 今天已花 20
  assert.equal(spentToday(db, fish.id, now), 20)
  assert.equal(getFish(db, fish.id)!.balance, 80)

  // 再花 20 → 累计 40 > 30，拒绝
  assert.throws(() => paySeatFee(db, fish.id, { fee: 20, now }), (e: any) => e.code === 'DAY_CAP')
  assert.equal(getFish(db, fish.id)!.balance, 80) // 未扣

  // 花 10（累计正好 30）允许
  paySeatFee(db, fish.id, { fee: 10, now })
  assert.equal(getFish(db, fish.id)!.balance, 70)
  assert.equal(spentToday(db, fish.id, now), 30)

  // 再多 1 块就超
  assert.throws(() => paySeatFee(db, fish.id, { fee: 1, now }), (e: any) => e.code === 'DAY_CAP')

  assertBalanceIntegrity(db, fish.id)
  db.close()
})

test('day_cap：跨天重置（昨天的消费不计入今天）', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '跨天鱼', balance: 100 })
  const now = Date.now()
  const yesterday = startOfLocalDay(now) - DAY_MS + 12 * 3600_000 // 昨天中午
  db.prepare('UPDATE fish SET day_cap = ? WHERE id = ?').run(10, fish.id)

  // 直接造一条「昨天」的消费账本记录（仅用于验证按自然日切分的时间窗）
  db.prepare(
    'INSERT INTO ledger(fish_id, delta, balance_after, reason, ref, ts) VALUES(?,?,?,?,?,?)',
  ).run(fish.id, -50, 50, 'seat_fee', 'yesterday', yesterday)

  assert.equal(spentToday(db, fish.id, now), 0) // 昨天的不算
  // 今天额度 10 仍可用满
  assert.doesNotThrow(() => paySeatFee(db, fish.id, { fee: 10, now }))
  db.close()
})

// -------- 账本求和 == 余额（混合赚/花后仍成立） --------
test('不变量：混合赚与花之后 ledger 求和 == fish.balance', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '混业鱼', balance: 100 })
  const offer = createJobOffer(db, { title: '短工', pay: 25, durationMin: 1 })

  addCatch(db, fish.id, '鲤鱼', 2) // 12 * 2 = 24
  const c = takeJob(db, fish.id, offer.id, 1_000)
  settleDueJobs(db, 1_000 + 60_000) // +25
  sellCatch(db, fish.id, { item: '鲤鱼' }) // +24
  paySeatFee(db, fish.id, 30) // -30

  const check = verifyBalance(db, fish.id)
  assert.equal(check.ok, true)
  assert.equal(check.balance, check.ledgerSum)
  assert.equal(check.balance, 100 + 25 + 24 - 30)
  assert.equal(ledgerSum(db, fish.id), getFish(db, fish.id)!.balance)
  assert.equal(listFishContracts(db, fish.id, 'done')[0].id, c.id)
  db.close()
})

// -------- 整数铁律 --------
test('金额必须是整数：非整数 delta / 金额被拒绝', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '小数鱼', balance: 100 })
  assert.throws(() => postLedger(db, fish.id, -1.5, 'seat_fee'), /integer/)
  assert.throws(() => paySeatFee(db, fish.id, 1.5), (e: any) => e.code === 'BAD_REQUEST')
  db.close()
})
