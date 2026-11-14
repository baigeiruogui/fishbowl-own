import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, getFish, openDb } from '../src/db/index.ts'
import { verifyBalance } from '../src/domain/account.ts'
import { createJobOffer } from '../src/domain/jobs.ts'
import { createBounty, getBounty } from '../src/domain/bounty.ts'
import { addItem, createShop } from '../src/domain/shop.ts'
import { createDriver } from '../src/games/index.ts'
import { npcStep } from '../src/sim/npc.ts'

const AFTERNOON = new Date(2026, 0, 1, 14, 0, 0).getTime()
const pickLast = () => 0.99 // 加权抽样里偏向最后一个候选（排除最前面的 rest）

function makeNpc(db: ReturnType<typeof openDb>, name: string, balance: number) {
  return createFish(db, { name, kind: 'npc', balance })
}

// -------- 空数据：无 NPC --------
test('npcStep 空世界（无 NPC）不崩，计数全 0', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const res = npcStep(db, driver, { now: AFTERNOON })
  assert.equal(res.steps, 0)
  assert.equal(res.work + res.play + res.shop + res.bounty, 0)
  assert.equal(res.errors, 0)
  db.close()
})

// -------- 空数据：有 NPC 但无事可做 --------
test('npcStep 有 NPC 但无任何资源：安全休息，不崩', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const npc = makeNpc(db, '闲鱼', 100)
  const res = npcStep(db, driver, { now: AFTERNOON, rng: pickLast })
  assert.equal(res.steps, 1)
  assert.ok(res.rest + res.none >= 1)
  assert.equal(res.work + res.play + res.shop + res.bounty + res.errors, 0)
  db.close()
})

// -------- work：接活 --------
test('npcStep work：NPC 接下招工，产生 working 合同', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const npc = makeNpc(db, '勤劳鱼', 10) // 缺钱 → 打工意愿高
  const offer = createJobOffer(db, { title: '搬鱼', pay: 20, durationMin: 30, slots: 2 })

  const res = npcStep(db, driver, { now: AFTERNOON, rng: pickLast, personalities: { [npc.id]: 'greedy' } })
  assert.ok(res.work >= 1, `应至少有一个 work 动作，实际 ${res.work}`)
  const c = db
    .prepare(`SELECT id, state FROM job_contract WHERE fish_id = ? AND offer_id = ? AND state = 'working'`)
    .get(npc.id, offer.id) as { id: string; state: string } | undefined
  assert.ok(c, '应为该 NPC 建立 working 合同')
  db.close()
})

// -------- shop：买货，记 shop_sale --------
test('npcStep shop：NPC 买货，写订单、扣库存、店主进账', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const owner = createFish(db, { name: '店主鱼', balance: 0 })
  const npc = makeNpc(db, '爱买鱼', 100)
  const shop = createShop(db, owner.id, '小卖部')
  const item = addItem(db, shop.id, { name: '鱼丸', price: 8, stock: 5 })

  const res = npcStep(db, driver, { now: AFTERNOON, rng: pickLast, personalities: { [npc.id]: 'kind' } })
  assert.ok(res.shop >= 1, `应至少有一个 shop 动作，实际 ${res.shop}`)

  const itemAfter = db.prepare('SELECT stock FROM shop_item WHERE id = ?').get(item.id) as { stock: number }
  assert.equal(itemAfter.stock, 4) // 库存 -1
  assert.equal(getFish(db, owner.id)!.balance, 8) // 店主进账
  const order = db.prepare('SELECT total FROM orders WHERE buyer_fish_id = ?').get(npc.id) as { total: number } | undefined
  assert.ok(order, '应写入订单')
  assert.equal(order!.total, 8)
  assert.equal(verifyBalance(db, npc.id).ok, true)
  assert.equal(verifyBalance(db, owner.id).ok, true)
  db.close()
})

// -------- play：入座玩牌 --------
test('npcStep play：NPC 入座牌桌，扣座位费', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const npc = makeNpc(db, '爱玩鱼', 100)
  const table = driver.openTable({ game: 'ddz', seatFee: 10, seed: 1 })

  const res = npcStep(db, driver, { now: AFTERNOON, rng: pickLast, personalities: { [npc.id]: 'lively' } })
  assert.ok(res.play >= 1, `应至少有一个 play 动作，实际 ${res.play}`)
  assert.equal(driver.getTable(table.id)!.players.length, 1)
  assert.equal(getFish(db, npc.id)!.balance, 90) // 扣了座位费
  db.close()
})

// -------- bounty：接悬赏 --------
test('npcStep bounty：NPC 接下悬赏，登记为 taker', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const poster = createFish(db, { name: '悬赏主', balance: 100 })
  const npc = makeNpc(db, '赏金猎人', 10)
  const bounty = createBounty(db, poster.id, { title: '找猫', reward: 10 })

  const res = npcStep(db, driver, { now: AFTERNOON, rng: pickLast, personalities: { [npc.id]: 'greedy' } })
  assert.ok(res.bounty >= 1, `应至少有一个 bounty 动作，实际 ${res.bounty}`)
  const b = getBounty(db, bounty.id)!
  assert.equal(b.state, 'taken')
  assert.equal(b.takerFishId, npc.id)
  db.close()
})

// -------- 满数据：资源齐全也不崩，动作合法 --------
test('npcStep 满数据：多种资源并存时决策不崩、账本不变量保持', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const poster = createFish(db, { name: '悬赏主', balance: 100 })
  const owner = createFish(db, { name: '店主', balance: 0 })
  const shop = createShop(db, owner.id, '杂货铺')
  addItem(db, shop.id, { name: '小鱼干', price: 5, stock: 10 })
  createJobOffer(db, { title: '搬鱼', pay: 20, durationMin: 30, slots: 3 })
  createBounty(db, poster.id, { title: '找猫', reward: 10 })
  driver.openTable({ game: 'ddz', seatFee: 5, seed: 1 })

  const npcs = [makeNpc(db, 'NPC甲', 50), makeNpc(db, 'NPC乙', 8), makeNpc(db, 'NPC丙', 200)]
  // 轮转 rng，让不同 NPC 走不同分支
  let i = 0
  const seq = [0.99, 0.4, 0.7]
  const rng = () => seq[i++ % seq.length]!

  const res = npcStep(db, driver, { now: AFTERNOON, rng })
  assert.equal(res.steps, npcs.length)
  for (const v of [res.rest, res.work, res.play, res.shop, res.bounty, res.none, res.errors]) {
    assert.ok(Number.isInteger(v) && v >= 0)
  }
  // 动作合法：所有鱼账本不变量成立、余额不为负
  for (const n of npcs) {
    assert.equal(verifyBalance(db, n.id).ok, true)
    assert.ok(getFish(db, n.id)!.balance >= 0)
  }
  // 每个 NPC 至多一个动作：分类计数之和 + errors 不会超过 steps（决策失败会同时计 none+errors，故放宽为 <= steps+errors）
  const sum = res.rest + res.work + res.play + res.shop + res.bounty + res.none
  assert.ok(sum <= res.steps + res.errors)
  db.close()
})
