import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, createFish, getFish } from '../src/db/index.ts'
import { createDriver } from '../src/games/index.ts'
import { legalPlays, turnSeat } from '../../games/src/index.ts'
import type { DdzSession, MjSession } from '../../games/src/index.ts'

function setup() {
  const db = openDb(':memory:')
  const driver = createDriver(db)
  return { db, driver }
}

function makeFish(db: ReturnType<typeof openDb>, names: string[], balance: number) {
  return names.map((name) => createFish(db, { name, balance }))
}

function ledgerSum(db: ReturnType<typeof openDb>, reason: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE reason = ?').get(reason) as { s: number }
  return Number(r.s)
}

/** 用最朴素的机器人把已开局的斗地主打到终局，返回最后一次 submitAction 结果。 */
function playDdzToEnd(driver: ReturnType<typeof createDriver>, tableId: string) {
  let last: ReturnType<ReturnType<typeof createDriver>['submitAction']> | null = null
  let guard = 0
  while (driver.getTable(tableId)!.status === 'playing') {
    guard++
    assert.ok(guard < 3000, '回合过多，可能死循环')
    const table = driver.getTable(tableId)!
    const sess = table.session as DdzSession
    const seat = turnSeat(sess)
    assert.ok(seat != null)
    const fishId = table.players.find((p) => p.seat === seat)!.fishId
    const plays = legalPlays(sess.hands[seat!], sess.last?.play ?? null)
    const action = plays.length > 0 ? { type: 'play' as const, cards: plays[0] } : { type: 'pass' as const }
    const r = driver.submitAction(tableId, fishId, action)
    assert.equal(r.ok, true, r.error)
    last = r
  }
  assert.ok(last, '至少应走一步')
  return last!
}

// 1) 开桌收座位费
test('开桌 + 入座：每人扣 seat_fee，坐满发牌开局，底池=seatFee*人数', async () => {
  const { db, driver } = setup()
  const fishes = makeFish(db, ['甲', '乙', '丙'], 100)
  const t = driver.openTable({ game: 'ddz', seatFee: 10, seed: 1 })
  assert.equal(t.status, 'waiting')
  assert.equal(t.seats, 3)

  for (const f of fishes) {
    const r = driver.seat(t.id, f.id)
    assert.equal(r.ok, true, r.error)
  }
  const table = driver.getTable(t.id)!
  assert.equal(table.status, 'playing')
  assert.equal(table.pot, 30)
  for (const f of fishes) assert.equal(getFish(db, f.id)!.balance, 90, '每人扣 10 座位费')

  // 账本：3 条 seat_fee，各 -10
  const rows = db.prepare(`SELECT delta FROM ledger WHERE reason = 'seat_fee'`).all() as unknown as { delta: number }[]
  assert.equal(rows.length, 3)
  assert.ok(rows.every((r) => r.delta === -10))

  // 开局发牌正确（地主 20 / 农民各 17）
  const sess = table.session as DdzSession
  assert.deepEqual(sess.hands.map((h) => h.length), [20, 17, 17])
})

// 2) 余额不足开不了桌/入座（不透支、不落座）
test('余额不足：付不起座位费就入不了座（INSUFFICIENT），桌子开不起来', async () => {
  const { db, driver } = setup()
  const poor = createFish(db, { name: '穷鱼', balance: 5 })
  const t = driver.openTable({ game: 'ddz', seatFee: 10 })

  const r = driver.seat(t.id, poor.id)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'INSUFFICIENT')
  assert.equal(getFish(db, poor.id)!.balance, 5, '余额不变、不透支')
  assert.equal(driver.getTable(t.id)!.players.length, 0, '未落座')
  assert.equal(driver.getTable(t.id)!.status, 'waiting', '人没坐满，开不了局')

  // 免费桌（seatFee=0）可以入座
  const t2 = driver.openTable({ game: 'ddz', seatFee: 0 })
  assert.equal(driver.seat(t2.id, poor.id).ok, true)
})

// 3) 斗地主（3 人）能一路打到结算
test('斗地主：坐满开打，逐手 submitAction 推进能走到结算（done、恰好一个赢家）', async () => {
  const { db, driver } = setup()
  const fishes = makeFish(db, ['斗1', '斗2', '斗3'], 100)
  const t = driver.openTable({ game: 'ddz', seatFee: 10, seed: 7 })
  for (const f of fishes) assert.equal(driver.seat(t.id, f.id).ok, true)

  const last = playDdzToEnd(driver, t.id)
  const table = driver.getTable(t.id)!
  assert.equal(table.status, 'done')
  assert.equal(last.done, true)
  assert.ok(last.settlement)
  assert.equal(last.settlement!.winners.length, 1)

  // 赢家余额 = 100 - 10 + 30 = 120；其余 90
  const winnerSeat = last.settlement!.winners[0]
  const winnerFish = table.players.find((p) => p.seat === winnerSeat)!.fishId
  assert.equal(getFish(db, winnerFish)!.balance, 120)
  for (const p of table.players) if (p.seat !== winnerSeat) assert.equal(getFish(db, p.fishId)!.balance, 90)
})

// 4) 底池守恒：发出去 == 收上来，且系统总余额不变
test('底池守恒：seat_fee 收上来的总额 == game_win 发出的底池；总余额不变', async () => {
  const { db, driver } = setup()
  const fishes = makeFish(db, ['守1', '守2', '守3'], 100)
  const t = driver.openTable({ game: 'ddz', seatFee: 10, seed: 3 })
  for (const f of fishes) assert.equal(driver.seat(t.id, f.id).ok, true)
  playDdzToEnd(driver, t.id)

  const seatTotal = -ledgerSum(db, 'seat_fee') // 收上来（正数）
  const winTotal = ledgerSum(db, 'game_win') // 发出去（正数）
  assert.equal(seatTotal, 30)
  assert.equal(winTotal, 30)
  assert.equal(winTotal, seatTotal, '发出去必须等于收上来')
  assert.equal(ledgerSum(db, 'refund'), 0, '有赢家时不应有退款')

  const total = fishes.reduce((n, f) => n + getFish(db, f.id)!.balance, 0)
  assert.equal(total, 300, '系统总余额守恒（不抽成、不凭空造钱）')
})

// 5) 非法动作 / 轮次与座位隔离（不崩）
test('非法动作：不是该鱼轮次 / 没入座的鱼 提交动作被拒绝，且不影响牌桌', async () => {
  const { db, driver } = setup()
  const fishes = makeFish(db, ['隔1', '隔2', '隔3'], 100)
  const t = driver.openTable({ game: 'ddz', seatFee: 0, seed: 1 })
  for (const f of fishes) assert.equal(driver.seat(t.id, f.id).ok, true)

  const turnFish = driver.nextTurn(t.id)
  assert.ok(turnFish)
  const other = driver.getTable(t.id)!.players.find((p) => p.fishId !== turnFish)!.fishId
  const wrong = driver.submitAction(t.id, other, { type: 'pass' })
  assert.equal(wrong.ok, false, '不是它的回合应被拒')

  const outsider = createFish(db, { name: '旁观', balance: 0 })
  const notSeated = driver.submitAction(t.id, outsider.id, { type: 'pass' })
  assert.equal(notSeated.ok, false)
  assert.equal(notSeated.error, 'NOT_SEATED')

  // 牌桌仍在进行、未被污染
  assert.equal(driver.getTable(t.id)!.status, 'playing')
})

// 6) 麻将 4 人开局 + 查询接口
test('麻将：4 人坐满开局（庄 14 / 其余 13），getTable/listTables/nextTurn 正常', async () => {
  const { db, driver } = setup()
  const fishes = makeFish(db, ['麻1', '麻2', '麻3', '麻4'], 100)
  const t = driver.openTable({ game: 'mj', seatFee: 5, seed: 2 })
  assert.equal(t.seats, 4)
  for (const f of fishes) assert.equal(driver.seat(t.id, f.id).ok, true)

  const table = driver.getTable(t.id)!
  assert.equal(table.status, 'playing')
  assert.equal(table.pot, 20)
  const sess = table.session as MjSession
  assert.deepEqual(sess.hands.map((h) => h.length), [14, 13, 13, 13])
  assert.equal(driver.nextTurn(t.id), table.players.find((p) => p.seat === 0)!.fishId)
  assert.equal(driver.listTables().length, 1)
  for (const f of fishes) assert.equal(getFish(db, f.id)!.balance, 95)
})
