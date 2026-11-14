import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db/index.ts'
import { seedTown } from '../src/seed.ts'

type DB = ReturnType<typeof openDb>
const count = (db: DB, sql: string) => Number((db.prepare(sql).get() as { c: number }).c)

test('seed: 默认内容数量（招工10 / 市场价6 / NPC6 / 店铺2 / 悬赏4）', () => {
  const db = openDb(':memory:')
  const s = seedTown(db)
  assert.equal(s.jobs, 10)
  assert.equal(s.npcs, 6)
  assert.equal(s.marketPrices, 6)
  assert.equal(s.shops, 2)
  assert.equal(s.bounties, 4)

  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM job_offer'), 10)
  assert.equal(count(db, `SELECT COUNT(*) AS c FROM fish WHERE kind='npc'`), 6)
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM shop'), 2)
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM bounty'), 4)

  const mp = db.prepare(`SELECT v FROM meta WHERE k = 'market_prices'`).get() as { v: string }
  assert.equal(Object.keys(JSON.parse(mp.v)).length, 6)
})

test('seed: 幂等——重复调用不重复写入，数量不变', () => {
  const db = openDb(':memory:')
  seedTown(db)
  const before = {
    jobs: count(db, 'SELECT COUNT(*) AS c FROM job_offer'),
    npcs: count(db, `SELECT COUNT(*) AS c FROM fish WHERE kind='npc'`),
    shops: count(db, 'SELECT COUNT(*) AS c FROM shop'),
    items: count(db, 'SELECT COUNT(*) AS c FROM shop_item'),
    bounties: count(db, 'SELECT COUNT(*) AS c FROM bounty'),
  }
  const second = seedTown(db)
  assert.deepEqual(second, { jobs: 0, npcs: 0, marketPrices: 0, shops: 0, bounties: 0, gallery: 0 })
  const after = {
    jobs: count(db, 'SELECT COUNT(*) AS c FROM job_offer'),
    npcs: count(db, `SELECT COUNT(*) AS c FROM fish WHERE kind='npc'`),
    shops: count(db, 'SELECT COUNT(*) AS c FROM shop'),
    items: count(db, 'SELECT COUNT(*) AS c FROM shop_item'),
    bounties: count(db, 'SELECT COUNT(*) AS c FROM bounty'),
  }
  assert.deepEqual(after, before)
})

test('seed: 两家店各有商品，店主是 NPC', () => {
  const db = openDb(':memory:')
  seedTown(db)
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM shop_item'), 5) // 3 + 2
  const shops = db.prepare('SELECT id, owner_fish_id FROM shop').all() as unknown as { id: string; owner_fish_id: string }[]
  for (const sh of shops) {
    const items = count(db, `SELECT COUNT(*) AS c FROM shop_item WHERE shop_id='${sh.id}'`)
    assert.ok(items >= 1, '每家店至少 1 件商品')
    const owner = db.prepare('SELECT kind FROM fish WHERE id = ?').get(sh.owner_fish_id) as { kind: string } | undefined
    assert.equal(owner?.kind, 'npc', '示例店店主应为 NPC')
  }
})

test('seed: 10 条招工 pay/时长合法且 active', () => {
  const db = openDb(':memory:')
  seedTown(db)
  const jobs = db.prepare('SELECT pay, duration_min, active FROM job_offer').all() as unknown as { pay: number; duration_min: number; active: number }[]
  assert.equal(jobs.length, 10)
  for (const j of jobs) {
    assert.ok(j.pay >= 5, 'pay >= MIN_JOB_PAY(5)')
    assert.ok(j.duration_min > 0)
    assert.equal(j.active, 1)
  }
})

test('seed: 4 条悬赏都是 open 且 reward 为正', () => {
  const db = openDb(':memory:')
  seedTown(db)
  const bounties = db.prepare('SELECT reward, state FROM bounty').all() as unknown as { reward: number; state: string }[]
  assert.equal(bounties.length, 4)
  for (const b of bounties) {
    assert.equal(b.state, 'open')
    assert.ok(b.reward > 0)
  }
})
