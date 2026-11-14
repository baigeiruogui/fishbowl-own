import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, createFish, getFish } from '../src/db/index.ts'
import { lottery, playRps, rollDice } from '../src/domain/minigames.ts'
import { DAY_MS } from '../src/domain/account.ts'

type DB = ReturnType<typeof openDb>

function seqRng(vals: number[]): () => number {
  let i = 0
  return () => vals[Math.min(i++, vals.length - 1)]!
}

function ledgerRows(db: DB, fishId: string, reason = 'game_win'): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM ledger WHERE fish_id = ? AND reason = ?').get(fishId, reason) as { c: number }).c)
}

// ---------- 猜拳 ----------
test('rps: 赢 +stake（账本 game_win > 0）', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '猜拳鱼', balance: 100 })
  // opponent = 下标 floor(0.5*3)=1 → scissors；rock 赢 scissors
  const r = playRps(db, fish.id, { choice: 'rock', stake: 5, rng: () => 0.5 })
  assert.equal(r.result, 'win')
  assert.equal(r.win, true)
  assert.equal(r.opponent, 'scissors')
  assert.equal(r.balance, 105)
  assert.equal(getFish(db, fish.id)!.balance, 105)
  const row = db.prepare(`SELECT delta FROM ledger WHERE fish_id = ? AND reason = 'game_win'`).get(fish.id) as { delta: number }
  assert.equal(row.delta, 5)
})

test('rps: 输 -stake（账本 game_win < 0）', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '猜拳鱼', balance: 100 })
  // opponent = floor(0.9*3)=2 → paper；rock 输 paper
  const r = playRps(db, fish.id, { choice: 'rock', stake: 5, rng: () => 0.9 })
  assert.equal(r.result, 'lose')
  assert.equal(r.balance, 95)
  const row = db.prepare(`SELECT delta FROM ledger WHERE fish_id = ? AND reason = 'game_win'`).get(fish.id) as { delta: number }
  assert.equal(row.delta, -5)
})

test('rps: 平局不结算（无账本、余额不变）', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '猜拳鱼', balance: 100 })
  const r = playRps(db, fish.id, { choice: 'rock', stake: 5, rng: () => 0.0 }) // opponent rock
  assert.equal(r.result, 'draw')
  assert.equal(r.balance, 100)
  assert.equal(ledgerRows(db, fish.id), 0)
})

test('rps: 余额不足拒绝且不透支', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '穷鱼', balance: 3 })
  assert.throws(() => playRps(db, fish.id, { choice: 'rock', stake: 5, rng: () => 0.5 }), (e: any) => e.code === 'INSUFFICIENT')
  assert.equal(getFish(db, fish.id)!.balance, 3)
  assert.equal(ledgerRows(db, fish.id), 0)
})

test('rps: 非法 choice / 非法 stake 抛 BAD_REQUEST', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '鱼', balance: 100 })
  assert.throws(() => playRps(db, fish.id, { choice: 'lizard' as any }), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => playRps(db, fish.id, { choice: 'rock', stake: 0 }), (e: any) => e.code === 'BAD_REQUEST')
})

// ---------- 掷骰子 ----------
test('dice: 玩家大 → 赢 +stake', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '骰子鱼', balance: 100 })
  // 玩家 = 1+floor(0.9*6)=6，对手 = 1+floor(0*6)=1
  const r = rollDice(db, fish.id, { stake: 5, rng: seqRng([0.9, 0.0]) })
  assert.equal(r.player, 6)
  assert.equal(r.opponent, 1)
  assert.equal(r.result, 'win')
  assert.equal(r.balance, 105)
})

test('dice: 玩家小 → 输 -stake', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '骰子鱼', balance: 100 })
  const r = rollDice(db, fish.id, { stake: 5, rng: seqRng([0.0, 0.9]) })
  assert.equal(r.player, 1)
  assert.equal(r.opponent, 6)
  assert.equal(r.result, 'lose')
  assert.equal(r.balance, 95)
})

test('dice: 相同点数平局不结算', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '骰子鱼', balance: 100 })
  const r = rollDice(db, fish.id, { stake: 5, rng: seqRng([0.5, 0.5]) }) // 都是 4
  assert.equal(r.player, r.opponent)
  assert.equal(r.result, 'draw')
  assert.equal(r.balance, 100)
  assert.equal(ledgerRows(db, fish.id), 0)
})

// ---------- 抽奖 ----------
test('lottery: 命中给小额奖励，每天仅 1 次', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '抽奖鱼', balance: 100 })
  const now = 1_700_000_000_000
  // 第一个 rng 命中(<0.5)，第二个决定 bonus=1+floor(0*10)=1
  const r = lottery(db, fish.id, { now, rng: seqRng([0.0, 0.0]) })
  assert.equal(r.hit, true)
  assert.equal(r.bonus, 1)
  assert.equal(r.balance, 101)
  assert.equal(getFish(db, fish.id)!.balance, 101)

  // 当天再来 → DAY_CAP
  assert.throws(() => lottery(db, fish.id, { now, rng: seqRng([0.0, 0.0]) }), (e: any) => e.code === 'DAY_CAP')
  assert.equal(getFish(db, fish.id)!.balance, 101)
})

test('lottery: 没中也不扣钱；次日可再抽', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '抽奖鱼', balance: 100 })
  const now = 1_700_000_000_000
  const miss = lottery(db, fish.id, { now, rng: () => 0.9 }) // 0.9 >= 0.5 不中
  assert.equal(miss.hit, false)
  assert.equal(miss.bonus, 0)
  assert.equal(miss.balance, 100)

  // 次日（+1 天）可再抽
  const next = lottery(db, fish.id, { now: now + DAY_MS, rng: () => 0.9 })
  assert.equal(next.hit, false)
  assert.equal(getFish(db, fish.id)!.balance, 100)
})

test('lottery: 不存在的鱼 → NOT_FOUND', () => {
  const db = openDb(':memory:')
  assert.throws(() => lottery(db, 'f_nope', { rng: () => 0.0 }), (e: any) => e.code === 'NOT_FOUND')
})
