import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import type { DB } from '../src/db/index.ts'
import { createJobOffer, takeJob, settleDueJobs } from '../src/domain/index.ts'
import { paySeatFee } from '../src/domain/seat.ts'

const ADMIN = 'web-contract-admin'

async function setup() {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN })
  const db = (app as unknown as { db: DB }).db
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/owner/fish',
      headers: { 'x-admin-token': ADMIN },
      payload: { name: '契约鱼', persona: '爱赚钱也爱花钱', intro: '一条鱼', balance: 100 },
    })
  ).json() as any
  const fishId = created.fish.id
  // 赚 30（打工结算）+ 花 10（座位费），保证 stats 四值非零
  const offer = createJobOffer(db, { title: '契约短工', pay: 30, durationMin: 1 })
  takeJob(db, fishId, offer.id, 1_000)
  settleDueJobs(db, 1_000 + 60_000)
  paySeatFee(db, fishId, 10)
  return { app, db, fishId, code: created.code }
}

test('public/town：web 契约 town{...} + recent[]（含 id/fishId/fishName/ref），旧字段兼容', async () => {
  const { app } = await setup()
  const res = await app.inject({ method: 'GET', url: '/api/public/town' })
  assert.equal(res.statusCode, 200)
  const b = res.json() as any

  assert.equal(b.ok, true)
  // 新契约 town
  assert.ok(b.town && typeof b.town === 'object')
  assert.equal(b.town.name, '鱼缸小镇')
  assert.equal(typeof b.town.onlineFish, 'number')
  assert.equal(typeof b.town.totalFish, 'number')
  assert.ok(b.town.totalFish >= 7)
  assert.ok(b.town.onlineFish >= 1, '刚活动的鱼应在线')
  assert.equal(typeof b.town.today.earned, 'number')
  assert.equal(typeof b.town.today.spent, 'number')
  assert.equal(typeof b.town.today.net, 'number')
  assert.equal(b.town.today.net, b.town.today.earned - b.town.today.spent)
  assert.equal(b.town.currency, '鱼币')
  assert.equal(typeof b.town.updatedAt, 'number')

  // 今日赚/花包含我们的 30/10
  assert.ok(b.town.today.earned >= 30, 'earned=' + b.town.today.earned)
  assert.ok(b.town.today.spent >= 10, 'spent=' + b.town.today.spent)

  // 新契约 recent 项
  assert.ok(Array.isArray(b.recent))
  assert.ok(b.recent.length >= 1)
  for (const it of b.recent) {
    assert.equal(typeof it.id, 'string')
    assert.equal(typeof it.ts, 'number')
    assert.equal(typeof it.fishId, 'string')
    assert.equal(typeof it.fishName, 'string')
    assert.equal(typeof it.reason, 'string')
    assert.equal(typeof it.delta, 'number')
    assert.ok(it.ref === null || typeof it.ref === 'string')
    // 旧字段 fish 仍在
    assert.ok(it.fish && it.fish.id === it.fishId)
  }

  // 旧字段兼容
  assert.equal(b.name, '鱼缸小镇')
  assert.equal(typeof b.fishCount, 'number')
  assert.equal(typeof b.today.earned, 'number')
  await app.close()
})

test('public/fish：web 契约 items[]（含 avatar/intro/online），旧 fish[] 兼容', async () => {
  const { app, fishId } = await setup()
  const res = await app.inject({ method: 'GET', url: '/api/public/fish' })
  assert.equal(res.statusCode, 200)
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.ok(Array.isArray(b.items))
  const one = b.items.find((f: any) => f.id === fishId)
  assert.ok(one)
  assert.equal(one.name, '契约鱼')
  assert.equal(typeof one.kind, 'string')
  assert.equal(typeof one.avatar, 'string')
  assert.equal(typeof one.intro, 'string')
  assert.equal(one.balance, 120) // 100 + 30 - 10
  assert.equal(typeof one.status, 'string')
  assert.equal(typeof one.online, 'boolean')

  // 旧字段
  assert.ok(Array.isArray(b.fish))
  assert.ok(b.fish.some((f: any) => f.id === fishId))
  assert.equal(typeof b.count, 'number')
  await app.close()
})

test('public/fish/:id：fish 名片 + ledger 带 id + stats 四值；旧 summary 兼容', async () => {
  const { app, fishId } = await setup()
  const res = await app.inject({ method: 'GET', url: `/api/public/fish/${fishId}` })
  assert.equal(res.statusCode, 200)
  const b = res.json() as any

  // fish 名片字段
  for (const k of ['id', 'name', 'kind', 'persona', 'intro', 'avatar', 'balance', 'status', 'dayCap', 'createdAt', 'ownerName']) {
    assert.ok(k in b.fish, '缺字段 fish.' + k)
  }
  assert.equal(b.fish.id, fishId)
  assert.equal(b.fish.name, '契约鱼')
  assert.equal(b.fish.ownerName, null)
  assert.equal(typeof b.fish.online, 'boolean')

  // ledger 每项带 id
  assert.ok(Array.isArray(b.ledger) && b.ledger.length === 3) // init + job + seat_fee
  for (const l of b.ledger) {
    assert.equal(typeof l.id, 'number')
    assert.equal(typeof l.delta, 'number')
    assert.equal(typeof l.balanceAfter, 'number')
    assert.equal(typeof l.reason, 'string')
    assert.ok(l.ref === null || typeof l.ref === 'string')
    assert.equal(typeof l.ts, 'number')
  }
  // 新的在前
  assert.ok(b.ledger[0].id > b.ledger[1].id)

  // stats 四值
  const s = b.stats
  assert.equal(s.todayEarned, 30)
  assert.equal(s.todaySpent, 10)
  assert.equal(s.totalEarned, 30)
  assert.equal(s.totalSpent, 10)
  assert.equal(s.entries, 3)

  // 旧 summary 兼容
  assert.ok(Array.isArray(b.summary))
  assert.ok(b.summary.some((x: any) => x.reason === 'init' && x.total === 100))
  await app.close()
})

test('public/fish/:id：不存在 → 404', async () => {
  const { app } = await setup()
  const res = await app.inject({ method: 'GET', url: '/api/public/fish/f_nope' })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error, 'NOT_FOUND')
  await app.close()
})
