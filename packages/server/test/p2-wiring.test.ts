import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import { getFish } from '../src/db/index.ts'
import type { DB } from '../src/db/index.ts'
import type { GameDriver } from '../src/games/driver.ts'
import { legalPlays } from '../../games/src/index.ts'
import type { DdzSession } from '../../games/src/index.ts'

const ADMIN = 't26-admin'
const RES = '/town/api/resident'

async function setup() {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN })
  const db = (app as unknown as { db: DB }).db
  const driver = (app as unknown as { driver: GameDriver }).driver
  return { app, db, driver }
}

async function resident(app: Awaited<ReturnType<typeof buildServer>>, name: string, balance = 100) {
  const created = (
    await app.inject({ method: 'POST', url: '/api/owner/fish', headers: { 'x-admin-token': ADMIN }, payload: { name, balance } })
  ).json() as any
  return { id: created.fish.id, code: created.code, headers: { authorization: 'Bearer ' + created.code } }
}

// 验收 1：两鱼（斗地主 3 人）开桌 → 逐手 turn/answer 打到结算
test('P2 接线：斗地主开桌-入座-发牌-逐手 answer-结算（game_win 发底池、seat_fee 守恒）', async () => {
  const { app, db, driver } = await setup()
  const a = await resident(app, '甲', 100)
  const b = await resident(app, '乙', 100)
  const c = await resident(app, '丙', 100)

  // 甲开桌（seatFee 5）
  const open = await app.inject({ method: 'POST', url: `${RES}/play`, headers: a.headers, payload: { game: 'ddz', seat_fee: 5 } })
  assert.equal(open.statusCode, 200)
  const ob = open.json() as any
  assert.equal(ob.ok, true)
  const tableId = ob.table.id as string

  // 乙、丙入座 → 坐满开局
  for (const f of [b, c]) {
    const join = await app.inject({ method: 'POST', url: `${RES}/play`, headers: f.headers, payload: { venue_id: tableId } })
    assert.equal((join.json() as any).ok, true)
  }
  const started = driver.getTable(tableId)
  assert.ok(started)
  assert.equal(started.status, 'playing')

  let guard = 0
  let last: any = null
  while (driver.getTable(tableId)!.status === 'playing') {
    guard++
    assert.ok(guard < 3000, '对局步数过多，疑似死循环')
    const table = driver.getTable(tableId)!
    const turnFish = driver.nextTurn(tableId) as string
    assert.ok(turnFish)
    const player = table.players.find((p) => p.fishId === turnFish)!
    const sess = table.session as DdzSession
    const plays = legalPlays(sess.hands[player.seat], sess.last?.play ?? null)
    const action = plays.length > 0 ? { type: 'play', cards: plays[0] } : { type: 'pass' }

    const headers = [a, b, c].find((f) => f.id === turnFish)!.headers
    const turns = (await app.inject({ method: 'GET', url: `${RES}/turns?wait=0&kinds=game`, headers })).json() as any
    const gameTurn = (turns.turns as any[]).find((t) => t.kind === 'game')
    assert.ok(gameTurn, '轮到出手的鱼应能拿到 kind=game 回合')

    const ans = await app.inject({ method: 'POST', url: `${RES}/turns/${gameTurn.turn_id}`, headers, payload: { answer: JSON.stringify({ action }) } })
    assert.equal(ans.statusCode, 200)
    const ab = ans.json() as any
    assert.equal(ab.ok, true)
    if (ab.done) last = ab
  }
  const done = driver.getTable(tableId)!
  assert.equal(done.status, 'done')
  assert.ok(last && last.settlement)
  assert.equal(last.settlement.winners.length, 1)

  // 经济：每人已付 5 座位费；赢家 +15
  const winnerSeat = last.settlement.winners[0] as number
  const winnerFish = done.players.find((p) => p.seat === winnerSeat)!.fishId
  assert.equal(getFish(db, winnerFish)!.balance, 110)
  for (const p of done.players) if (p.seat !== winnerSeat) assert.equal(getFish(db, p.fishId)!.balance, 95)
  await app.close()
})

// 验收 2：开店 → 别人买 → 店主进账
test('P2 接线：开店→上货→别人买→店主进账（buy/shop_sale 双记）', async () => {
  const { app, db } = await setup()
  const owner = await resident(app, '店主', 100)
  const buyer = await resident(app, '买主', 100)

  const opened = await app.inject({ method: 'POST', url: `${RES}/shop/open`, headers: owner.headers, payload: { name: '鱼干铺', kind: 'food' } })
  assert.equal((opened.json() as any).ok, true)
  const shopId = (opened.json() as any).shop.id as string

  const stocked = await app.inject({ method: 'POST', url: `${RES}/shop/stock`, headers: owner.headers, payload: { item: '鱼干', price: 20, stock: 5 } })
  const stockedB = stocked.json() as any
  assert.equal(stockedB.ok, true)
  const itemId = stockedB.shop.items.find((i: any) => i.name === '鱼干').id as string

  const buy = await app.inject({ method: 'POST', url: `${RES}/shop/buy`, headers: buyer.headers, payload: { item_id: itemId, qty: 2 } })
  const bb = buy.json() as any
  assert.equal(bb.ok, true)
  assert.equal(bb.receipt.delta, -40)

  assert.equal(getFish(db, buyer.id)!.balance, 60)
  assert.equal(getFish(db, owner.id)!.balance, 140)
  const order = db.prepare('SELECT * FROM orders WHERE buyer_fish_id = ?').get(buyer.id) as { total: number } | undefined
  assert.equal(order!.total, 40)
  await app.close()
})

// 验收 3：发悬赏 → 接 → 交 → 赏金转移
test('P2 接线：发悬赏→接→交→赏金从海报转给接单人', async () => {
  const { app, db } = await setup()
  const poster = await resident(app, '海报', 100)
  const taker = await resident(app, '接单', 100)

  const post = await app.inject({ method: 'POST', url: `${RES}/bounties/post`, headers: poster.headers, payload: { title: '找走失的猫', reward: 30 } })
  assert.equal((post.json() as any).ok, true)
  const bountyId = (post.json() as any).bounty.id as string

  const take = await app.inject({ method: 'POST', url: `${RES}/bounties/take`, headers: taker.headers, payload: { bounty_id: bountyId } })
  assert.equal((take.json() as any).ok, true)

  const claim = await app.inject({ method: 'POST', url: `${RES}/bounties/claim`, headers: taker.headers, payload: { bounty_id: bountyId } })
  const cb = claim.json() as any
  assert.equal(cb.ok, true)
  assert.equal(cb.bounty.state, 'done')

  assert.equal(getFish(db, poster.id)!.balance, 70)
  assert.equal(getFish(db, taker.id)!.balance, 130)
  await app.close()
})

// 桌列表 / 公开大厅端点可用（接线冒烟）
test('P2 接线：GET tables / public lobby 均可用', async () => {
  const { app } = await setup()
  const fish = await resident(app, '看桌鱼', 100)
  const play = await app.inject({ method: 'POST', url: `${RES}/play`, headers: fish.headers, payload: { game: 'ddz' } })
  const tableId = (play.json() as any).table.id

  const tables = await app.inject({ method: 'GET', url: `${RES}/tables`, headers: fish.headers })
  assert.equal((tables.json() as any).tables.length >= 1, true)
  assert.ok((tables.json() as any).tables.some((t: any) => t.id === tableId))

  const lobby = await app.inject({ method: 'GET', url: '/api/public/lobby' })
  assert.equal(lobby.statusCode, 200)
  assert.ok(Array.isArray((lobby.json() as any).tables))
  await app.close()
})
