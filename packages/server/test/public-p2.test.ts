import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createFish, openDb, postLedger } from '../src/db/index.ts'
import { publicP2Routes, type TableLike, type TablesSource } from '../src/api/public-p2.ts'
import { generateDailyPaper } from '../src/sim/paper.ts'

async function makeApp(deps: { db: ReturnType<typeof openDb>; driver?: TablesSource; store?: TablesSource }) {
  const app = Fastify()
  await app.register(publicP2Routes, { prefix: '/api/public', ...deps })
  return app
}

function stubTable(over: Partial<TableLike> = {}): TableLike {
  return {
    id: 't1',
    game: 'ddz',
    status: 'waiting',
    seats: 3,
    seatFee: 10,
    pot: 0,
    createdAt: 1_700_000_000_000,
    players: [],
    session: null,
    ...over,
  }
}

function stubDriver(tables: TableLike[]): TablesSource {
  return {
    listTables: () => tables,
    getTable: (id: string) => tables.find((t) => t.id === id) ?? null,
  }
}

// -------- GET /api/public/lobby --------
test('lobby：返回牌桌 / 游戏 / 地点结构', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '占位鱼', balance: 100 })
  db.prepare('INSERT INTO venue(id, name, kind, config_json) VALUES(?,?,?,?)').run('pier', '码头', 'place', '{}')

  const table = stubTable({ players: [{ seat: 0, fishId: fish.id }] })
  const app = await makeApp({ db, driver: stubDriver([table]) })
  const res = await app.inject({ method: 'GET', url: '/api/public/lobby' })
  assert.equal(res.statusCode, 200)
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.equal(b.tables.length, 1)
  const t = b.tables[0]
  assert.equal(t.id, 't1')
  assert.equal(t.game, 'ddz')
  assert.equal(t.state, 'waiting')
  assert.equal(t.seatsNeeded, 2)
  assert.equal(t.seatFee, 10)
  assert.equal(t.pot, 0)
  assert.equal(t.startedAt, 1_700_000_000_000)
  assert.equal(t.seats.length, 3)
  assert.equal(t.seats[0].seat, 0)
  assert.equal(t.seats[0].fishId, fish.id)
  assert.equal(t.seats[0].name, '占位鱼')
  assert.equal(t.seats[1].seat, 1)
  assert.equal(t.seats[1].fishId, undefined)

  // 游戏列表
  assert.deepEqual(
    b.games.map((g: any) => g.id),
    ['ddz', 'mj', 'werewolf', 'turtlesoup'],
  )
  assert.equal(b.games.find((g: any) => g.id === 'mj').seats, 4)
  // 地点
  assert.deepEqual(b.places, [{ id: 'pier', name: '码头' }])
  await app.close()
  db.close()
})

test('lobby：无驱动时从 game_session / game_seat 表回落读取', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '落座鱼', balance: 100 })
  db.prepare('INSERT INTO game_session(id, venue_id, game, state, pot, created_at, config_json) VALUES(?,?,?,?,?,?,?)').run(
    'tbl_db',
    null,
    'ddz',
    'waiting',
    0,
    Date.now(),
    JSON.stringify({ seatFee: 5, seats: 3, seed: 1 }),
  )
  db.prepare('INSERT INTO game_seat(id, session_id, fish_id, seat, state) VALUES(?,?,?,?,?)').run('gs1', 'tbl_db', fish.id, 0, 'seated')

  const app = await makeApp({ db })
  const res = await app.inject({ method: 'GET', url: '/api/public/lobby' })
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.equal(b.tables.length, 1)
  assert.equal(b.tables[0].id, 'tbl_db')
  assert.equal(b.tables[0].seatFee, 5)
  assert.equal(b.tables[0].seatsNeeded, 2)
  assert.equal(b.tables[0].seats[0].fishId, fish.id)
  await app.close()
  db.close()
})

// -------- GET /api/public/table/:id --------
test('table/:id：返回单桌详情；不存在返回 404', async () => {
  const db = openDb(':memory:')
  const table = stubTable({
    status: 'playing',
    pot: 30,
    players: [
      { seat: 0, fishId: 'f0' },
      { seat: 1, fishId: 'f1' },
      { seat: 2, fishId: 'f2' },
    ],
    session: { game: 'ddz', passes: 2, turn: 2, done: false, last: { seat: 1 } },
    lastActions: [{ ts: 111, text: '座位 1 出牌' }],
  })
  const app = await makeApp({ db, driver: stubDriver([table]) })

  const res = await app.inject({ method: 'GET', url: '/api/public/table/t1' })
  assert.equal(res.statusCode, 200)
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.equal(b.table.id, 't1')
  assert.equal(b.table.game, 'ddz')
  assert.equal(b.table.state, 'playing')
  assert.equal(b.table.seatFee, 10)
  assert.equal(b.table.pot, 30)
  assert.equal(b.table.round, 2)
  assert.equal(b.table.turnSeat, 2)
  assert.equal(b.table.seats.length, 3)
  assert.deepEqual(b.table.lastActions, [{ ts: 111, text: '座位 1 出牌' }])
  assert.equal(typeof b.table.updatedAt, 'number')

  const miss = await app.inject({ method: 'GET', url: '/api/public/table/nope' })
  assert.equal(miss.statusCode, 404)
  assert.equal((miss.json() as any).ok, false)
  await app.close()
  db.close()
})

// -------- GET /api/public/board --------
test('board：按净收益排名，字段齐全', async () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: '常胜鱼', balance: 100 })
  const b2 = createFish(db, { name: '手气差', balance: 100 })
  // 常胜鱼：付 10 座位费，赢 20；手气差：付 10 输掉
  postLedger(db, a.id, -10, 'seat_fee', 't1')
  postLedger(db, a.id, 20, 'game_win', 't1')
  postLedger(db, b2.id, -10, 'seat_fee', 't1')

  const app = await makeApp({ db })
  const res = await app.inject({ method: 'GET', url: '/api/public/board' })
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.equal(b.entries.length, 2)
  assert.equal(typeof b.updatedAt, 'number')

  const win = b.entries.find((e: any) => e.fishId === a.id)
  assert.equal(win.rank, 1)
  assert.equal(win.name, '常胜鱼')
  assert.equal(win.balance, 110)
  assert.equal(win.wins, 1)
  assert.equal(win.losses, 0)
  assert.equal(win.winRate, 1)
  assert.equal(win.net, 10)

  const lose = b.entries.find((e: any) => e.fishId === b2.id)
  assert.equal(lose.rank, 2)
  assert.equal(lose.wins, 0)
  assert.equal(lose.losses, 1)
  assert.equal(lose.winRate, 0)
  assert.equal(lose.net, -10)
  await app.close()
  db.close()
})

// -------- GET /api/public/paper --------
test('paper：空库返回空数组；生成日报后可见条目', async () => {
  const db = openDb(':memory:')
  const app = await makeApp({ db })

  const empty = await app.inject({ method: 'GET', url: '/api/public/paper' })
  const eb = empty.json() as any
  assert.equal(eb.ok, true)
  assert.equal(Array.isArray(eb.items), true)
  assert.equal(eb.items.length, 0)
  assert.match(eb.date, /^\d{4}-\d{2}-\d{2}$/)

  const gen = generateDailyPaper(db)
  assert.ok(gen.written > 0)

  const res = await app.inject({ method: 'GET', url: '/api/public/paper' })
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.ok(b.items.length >= gen.items.length)
  const first = b.items[0]
  assert.ok(first.id)
  assert.equal(typeof first.ts, 'number')
  assert.equal(typeof first.kind, 'string')
  assert.equal(typeof first.title, 'string')
  assert.equal(typeof first.summary, 'string')
  await app.close()
  db.close()
})
