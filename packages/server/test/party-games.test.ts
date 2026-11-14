import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createFish, openDb } from '../src/db/index.ts'
import { issueResidentCode } from '../src/api/auth.ts'
import { createTurnEngine } from '../src/engine/index.ts'
import { createDriver, werewolfNightNeed } from '../src/games/driver.ts'
import { maybeCreateGameTurn, submitGameAction } from '../src/games/game-turn.ts'
import { residentP2Routes } from '../src/api/resident-p2.ts'
import type { GameTable } from '../src/games/store.ts'
import type { WerewolfState } from '../../games/src/index.ts'
import type { TurtleSoupSession } from '../src/games/store.ts'

function makeFishes(db: ReturnType<typeof openDb>, n: number, balance = 100) {
  return Array.from({ length: n }, (_, i) => createFish(db, { name: '鱼' + i, balance }))
}

function sumLedger(db: ReturnType<typeof openDb>, reason: string): number {
  return Number((db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE reason = ?').get(reason) as { s: number }).s)
}

function sumBalances(db: ReturnType<typeof openDb>): number {
  return Number((db.prepare('SELECT COALESCE(SUM(balance),0) AS s FROM fish').get() as { s: number }).s)
}

function seatAll(driver: ReturnType<typeof createDriver>, tableId: string, fishes: { id: string }[]) {
  for (const f of fishes) {
    const r = driver.seat(tableId, f.id)
    assert.equal(r.ok, true, r.error)
  }
}

// 下一手狼人杀脚本动作（夜晚按角色/身份，投票按阵营最优）
function nextWerewolfMove(t: GameTable): { fishId: string; action: any } | null {
  const s = t.session as WerewolfState
  if (s.phase === 'ended') return null
  const alive = s.players.filter((p) => p.alive)
  if (s.phase === 'day') return { fishId: alive[0]!.id, action: { type: 'vote', target: alive[0]!.id } }
  if (s.phase === 'night') {
    for (const p of alive) {
      const need = werewolfNightNeed(s, p.id)
      if (!need) continue
      if (need === 'wolf') {
        const tgt = alive.find((x) => x.role !== 'werewolf') ?? alive.find((x) => x.id !== p.id)!
        return { fishId: p.id, action: { type: 'wolf', target: tgt.id } }
      }
      if (need === 'seer') {
        const tgt = alive.find((x) => x.id !== p.id)!
        return { fishId: p.id, action: { type: 'seer', target: tgt.id } }
      }
      if (need === 'witch') return { fishId: p.id, action: { type: 'witch', save: null, poison: null } }
      if (need === 'guard') return { fishId: p.id, action: { type: 'guard', target: p.id } }
    }
    return null
  }
  if (s.phase === 'vote') {
    for (const p of alive) {
      if (s.votes.some((v) => v.voter === p.id)) continue
      const wolves = alive.filter((x) => x.role === 'werewolf')
      const goods = alive.filter((x) => x.role !== 'werewolf')
      const target = p.role === 'werewolf' ? (goods[0]?.id ?? wolves[0]!.id) : (wolves[0]?.id ?? goods[0]!.id)
      return { fishId: p.id, action: { type: 'vote', target } }
    }
  }
  return null
}

// 1. 狼人杀坐满 6 人开局
test('werewolf：6 人坐满开局，角色配比与底池正确', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const fishes = makeFishes(db, 6)
  const table = driver.openTable({ game: 'werewolf', seatFee: 5, seed: 1 })
  assert.equal(table.seats, 6)
  seatAll(driver, table.id, fishes)

  const t = driver.getTable(table.id)!
  assert.equal(t.status, 'playing')
  const s = t.session as WerewolfState
  assert.equal(s.players.filter((p) => p.role === 'werewolf').length, 2)
  assert.equal(t.pot, 30)
  assert.equal(sumLedger(db, 'seat_fee'), -30)
  db.close()
})

// 2. 狼人杀一路打到结算：终局分发底池、余额守恒
test('werewolf：6 人一局走到结算，赢方按底池结算、总余额守恒', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const fishes = makeFishes(db, 6)
  const table = driver.openTable({ game: 'werewolf', seatFee: 5, seed: 2 })
  const before = sumBalances(db) // 入座扣费前的总余额
  seatAll(driver, table.id, fishes)

  let guard = 0
  while (driver.getTable(table.id)!.status === 'playing') {
    guard++
    assert.ok(guard < 2000, '回合过多，可能死循环')
    const t = driver.getTable(table.id)!
    const mv = nextWerewolfMove(t)
    if (!mv) break
    const r = driver.submitAction(table.id, mv.fishId, mv.action)
    assert.equal(r.ok, true, `${mv.action.type} by ${mv.fishId}: ${r.error}`)
  }

  const t = driver.getTable(table.id)!
  assert.equal(t.status, 'done')
  const s = t.session as WerewolfState
  assert.ok(s.winner === 'good' || s.winner === 'werewolf')
  assert.equal(sumLedger(db, 'game_win'), 30) // 底池全额发给赢方
  assert.equal(sumBalances(db), before) // 座位费收上来再发出去，总量守恒
  db.close()
})

// 3. 狼人杀通过 turns(kind=game) 桥接：狼首领收回合、提交动作推进、非法动作报错
test('werewolf turns 桥接：生成狼刀回合，提交动作推进，非法动作不崩', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const engine = createTurnEngine(db)
  const fishes = makeFishes(db, 6)
  const table = driver.openTable({ game: 'werewolf', seatFee: 0, seed: 3 })
  seatAll(driver, table.id, fishes)

  const s = driver.getTable(table.id)!.session as WerewolfState
  const wolf = s.players.find((p) => p.role === 'werewolf' && p.alive)!
  const good = s.players.find((p) => p.role !== 'werewolf' && p.alive)!

  const turn = maybeCreateGameTurn(db, engine, driver, wolf.id)
  assert.ok(turn, '狼首领应收到 game 回合')
  assert.equal(turn!.packet.game, 'werewolf')
  assert.equal((turn!.packet as any).need, 'wolf')

  const r = submitGameAction(db, engine, driver, wolf.id, { action: { type: 'wolf', target: good.id } })
  assert.equal(r.ok, true, r.error)

  // 夜晚投票类动作应被拒
  const bad = submitGameAction(db, engine, driver, wolf.id, { action: { type: 'vote', target: good.id } })
  assert.equal(bad.ok, false)
  db.close()
})

// 4. 狼人杀人数不足：5 人不能开局
test('werewolf：5 人坐不满不开局，提交动作返回 NOT_PLAYING', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const fishes = makeFishes(db, 5)
  const table = driver.openTable({ game: 'werewolf', seatFee: 0, seed: 4 })
  seatAll(driver, table.id, fishes)
  assert.equal(driver.getTable(table.id)!.status, 'waiting')
  const r = driver.submitAction(table.id, fishes[0]!.id, { type: 'vote', target: fishes[1]!.id })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NOT_PLAYING')
  db.close()
})

// 5. resident POST /play {game:'werewolf'} 开桌/入座
test('resident POST /play：game=werewolf 开桌并入座，6 人后开局', async () => {
  const db = openDb(':memory:')
  const engine = createTurnEngine(db)
  const driver = createDriver(db)
  const app = Fastify()
  await app.register(residentP2Routes, { prefix: '/town/api/resident', db, engine, driver })

  const fishes = makeFishes(db, 6)
  const codes = fishes.map((f) => issueResidentCode(db, f.id).code)
  for (let i = 0; i < fishes.length; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/town/api/resident/play',
      headers: { authorization: 'Bearer ' + codes[i] },
      payload: i === 0 ? { game: 'werewolf', seat_fee: 5 } : { game: 'werewolf' },
    })
    assert.equal(res.statusCode, 200, res.body)
  }
  const tables = driver.listTables()
  assert.equal(tables.length, 1)
  assert.equal(tables[0]!.game, 'werewolf')
  assert.equal(tables[0]!.status, 'playing')
  assert.equal(tables[0]!.players.length, 6)
  await app.close()
  db.close()
})

// 6. 海龟汤坐满 2 人开局，汤面就绪
test('turtlesoup：主持 + 猜题 2 人开局，汤面就绪', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const fishes = makeFishes(db, 2)
  const table = driver.openTable({ game: 'turtlesoup', seatFee: 5, seed: 5 })
  seatAll(driver, table.id, fishes)
  const t = driver.getTable(table.id)!
  assert.equal(t.status, 'playing')
  const sess = t.session as TurtleSoupSession
  assert.ok(sess.soup.card.riddle.length > 0)
  assert.equal(sess.guesserSeat, 1)
  assert.equal(t.pot, 10)
  db.close()
})

// 7. 海龟汤：提问 → 猜中谜底 → 结算，底池给猜题者
test('turtlesoup：提问判定 + 猜中谜底结算，底池给猜题者', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const engine = createTurnEngine(db)
  const fishes = makeFishes(db, 2)
  const table = driver.openTable({ game: 'turtlesoup', seatFee: 5, seed: 6 })
  seatAll(driver, table.id, fishes)
  const sess = driver.getTable(table.id)!.session as TurtleSoupSession
  const guesserFish = fishes[sess.guesserSeat]!.id
  const hostFish = fishes[sess.hostSeat]!.id

  // 只给猜题者生成回合；主持没有
  assert.equal(maybeCreateGameTurn(db, engine, driver, hostFish), null)
  const turn = maybeCreateGameTurn(db, engine, driver, guesserFish)
  assert.ok(turn)
  assert.equal(turn!.packet.game, 'turtlesoup')

  // 先问一个问题
  const ask = submitGameAction(db, engine, driver, guesserFish, { action: { type: 'ask', question: '和打嗝有关吗？' } })
  assert.equal(ask.ok, true, ask.error)
  assert.equal((ask.events as any)[0].type, 'soup_answer')

  // 再猜中谜底
  const sol = submitGameAction(db, engine, driver, guesserFish, { action: { type: 'guess', answer: sess.soup.card.answer } })
  assert.equal(sol.ok, true, sol.error)
  assert.equal(sol.done, true)
  assert.deepEqual(sol.settlement!.winners, [sess.guesserSeat])
  assert.equal(driver.getTable(table.id)!.status, 'done')
  assert.equal(sumLedger(db, 'game_win'), 10) // 底池 10 全部给猜题者
  db.close()
})

// 8. 海龟汤：猜错继续、非猜题者不能动、非法动作不崩
test('turtlesoup：猜错继续、非猜题者无回合、非法动作返回错误', () => {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  const engine = createTurnEngine(db)
  const fishes = makeFishes(db, 2)
  const table = driver.openTable({ game: 'turtlesoup', seatFee: 0, seed: 7 })
  seatAll(driver, table.id, fishes)
  const sess = driver.getTable(table.id)!.session as TurtleSoupSession
  const guesserFish = fishes[sess.guesserSeat]!.id
  const hostFish = fishes[sess.hostSeat]!.id

  const wrong = submitGameAction(db, engine, driver, guesserFish, { action: { type: 'guess', answer: '完全错误的答案' } })
  assert.equal(wrong.ok, true)
  assert.equal(wrong.done, undefined)
  assert.equal((wrong.events as any)[0].type, 'soup_wrong')
  assert.equal(driver.getTable(table.id)!.status, 'playing')

  // 主持不是猜题者，提交动作应被拒
  const host = submitGameAction(db, engine, driver, hostFish, { action: { type: 'ask', question: '？' } })
  assert.equal(host.ok, false)

  // 非法 action 类型
  const bad = submitGameAction(db, engine, driver, guesserFish, { action: { type: 'nonsense' } })
  assert.equal(bad.ok, false)
  db.close()
})
