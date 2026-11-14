import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, openDb } from '../src/db/index.ts'
import { addItem, buyItem, createShop } from '../src/domain/shop.ts'
import { claimBounty, createBounty, takeBounty } from '../src/domain/bounty.ts'
import { generateDailyPaper } from '../src/sim/paper.ts'

function paperCount(db: ReturnType<typeof openDb>): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM paper').get() as { c: number }).c)
}

// -------- 空库：不崩，给出 0 值日报并落库 --------
test('generateDailyPaper 空库：不崩，生成 0 值日报并写入 paper 表', () => {
  const db = openDb(':memory:')
  const res = generateDailyPaper(db)
  assert.match(res.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(Array.isArray(res.items), true)
  assert.equal(res.items.length, 4)
  assert.equal(res.written, res.items.length)
  assert.equal(paperCount(db), res.items.length)
  for (const it of res.items) {
    assert.equal(typeof it.id, 'string')
    assert.equal(typeof it.title, 'string')
    assert.equal(typeof it.summary, 'string')
  }
  db.close()
})

// -------- 幂等：重复调用不再重复写 --------
test('generateDailyPaper 幂等：当天二次调用 written=0、paper 行数不变', () => {
  const db = openDb(':memory:')
  const first = generateDailyPaper(db)
  const afterFirst = paperCount(db)
  const second = generateDailyPaper(db)
  assert.equal(second.written, 0)
  assert.equal(paperCount(db), afterFirst)
  assert.ok(second.items.length === first.items.length)
  db.close()
})

// -------- 有数据：统计口径正确 --------
test('generateDailyPaper 有数据：局数 / 成交 / 悬赏 统计进标题', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 200 })
  const buyer = createFish(db, { name: '买家', balance: 100 })

  // 一笔店铺成交（8 鱼币）
  const shop = createShop(db, owner.id, '小店')
  const item = addItem(db, shop.id, { name: '鱼丸', price: 8, stock: 5 })
  buyItem(db, buyer.id, item.id, 1)

  // 一个悬赏完成
  const bounty = createBounty(db, owner.id, { title: '找猫', reward: 10 })
  takeBounty(db, bounty.id, buyer.id)
  claimBounty(db, bounty.id, buyer.id)

  // 一局今天开的对局
  db.prepare('INSERT INTO game_session(id, venue_id, game, state, pot, created_at, config_json) VALUES(?,?,?,?,?,?,?)').run(
    'tbl_paper',
    null,
    'ddz',
    'done',
    30,
    Date.now(),
    JSON.stringify({ seatFee: 10, seats: 3, seed: 1 }),
  )

  const res = generateDailyPaper(db)
  const byKind = (k: string) => res.items.find((i) => i.kind === k)!
  assert.match(byKind('games').title, /1 局/)
  assert.match(byKind('shop').title, /1 单/)
  assert.match(byKind('shop').summary, /8 鱼币/)
  assert.match(byKind('bounty').title, /1 个/)
  // 谁赚谁赔行存在
  assert.equal(typeof byKind('money').title, 'string')
  assert.equal(paperCount(db), res.items.length)
  db.close()
})
