import test from 'node:test'
import assert from 'node:assert/strict'

import { createSession, applyAction, turnSeat } from '../src/session.ts'
import type { ApplyResult, DdzSession, MjSession } from '../src/session.ts'
import { legalPlays } from '../src/ddz.ts'
import type { Card, Suit } from '../src/ddz.ts'
import type { Tile, TileKind } from '../src/mj.ts'

function card(rank: number, suit: Suit = 'S', joker = false): Card {
  return { rank, suit, joker }
}
function tile(kind: TileKind, rank: number): Tile {
  return { kind, rank }
}

/** 斗地主：用最朴素的机器人一路打到终局，返回最后一次 applyAction 结果。 */
function playDdzToEnd(seed: number, seatFee = 0): { session: DdzSession; last: ApplyResult } {
  let s = createSession('ddz', 3, { seed, seatFee }) as DdzSession
  let last: ApplyResult | null = null
  let steps = 0
  while (!s.done && steps < 3000) {
    const seat = turnSeat(s) as number
    const lastPlay = s.last?.play ?? null
    const plays = legalPlays(s.hands[seat], lastPlay)
    const action = plays.length > 0 ? { type: 'play' as const, cards: plays[0] } : { type: 'pass' as const }
    const r = applyAction(s, seat, action)
    assert.equal(r.ok, true, `第 ${steps} 步失败：${r.error}`)
    last = r
    s = r.session as DdzSession
    steps++
  }
  assert.ok(last, '应至少走一步')
  return { session: s, last: last! }
}

// 1
test('createSession(ddz)：地主 20 张、农民各 17 张、底牌 3 张、共 54 张不重复', () => {
  const s = createSession('ddz', 3, { seed: 7 }) as DdzSession
  assert.equal(s.game, 'ddz')
  assert.equal(s.seats, 3)
  assert.equal(s.hands.length, 3)
  assert.equal(s.hands[0].length, 20)
  assert.equal(s.hands[1].length, 17)
  assert.equal(s.hands[2].length, 17)
  assert.equal(s.bottom.length, 3)
  const all = [...s.hands[0], ...s.hands[1], ...s.hands[2]]
  assert.equal(all.length, 54)
  assert.equal(new Set(all.map((c) => `${c.rank}${c.suit}`)).size, 54)
  assert.equal(turnSeat(s), s.landlord)
})

// 2
test('createSession(mj)：庄家 14 张、其余 13 张、牌墙 83 张、共 136 张', () => {
  const s = createSession('mj', 4, { seed: 3 }) as MjSession
  assert.equal(s.game, 'mj')
  assert.equal(s.seats, 4)
  assert.deepEqual(
    s.hands.map((h) => h.length),
    [14, 13, 13, 13],
  )
  assert.equal(s.wall.length, 136 - 53)
  assert.equal(s.phase, 'await_discard')
  assert.equal(turnSeat(s), 0)
  const total = s.hands.flat().length + s.wall.length + s.discards.length
  assert.equal(total, 136)
})

// 3
test('ddz：合法出单张后轮转到下家，并记录 last（原 session 不被修改）', () => {
  const s = createSession('ddz', 3, { seed: 1 }) as DdzSession
  const before = JSON.stringify(s)
  const seat = turnSeat(s) as number
  const r = applyAction(s, seat, { type: 'play', cards: [s.hands[seat][0]] })
  assert.equal(r.ok, true)
  assert.equal(turnSeat(r.session), (seat + 1) % 3)
  assert.equal((r.session as DdzSession).last?.play.type, 'single')
  assert.equal(JSON.stringify(s), before, '原 session 必须保持不变')
  assert.equal(s.hands[seat].length, 20, '原手牌数量不变')
})

// 4
test('ddz：其余两家 pass 后清空 last，回到上一手玩家领出', () => {
  let s = createSession('ddz', 3, { seed: 1 }) as DdzSession
  let r = applyAction(s, 0, { type: 'play', cards: [s.hands[0][0]] })
  s = r.session as DdzSession
  assert.equal(turnSeat(s), 1)
  r = applyAction(s, 1, { type: 'pass' })
  assert.equal(r.ok, true)
  s = r.session as DdzSession
  assert.equal(turnSeat(s), 2)
  r = applyAction(s, 2, { type: 'pass' })
  assert.equal(r.ok, true)
  s = r.session as DdzSession
  assert.equal(s.last, null, '两家都过后 last 清空')
  assert.equal(turnSeat(s), 0, '回到上一手玩家领出')
})

// 5
test('ddz：非法动作被拒绝且不改动 session（不是我出/不是我的手牌/非法牌型/领出时 pass）', () => {
  const s = createSession('ddz', 3, { seed: 5 }) as DdzSession
  const snapshot = JSON.stringify(s)

  const notTurn = applyAction(s, 1, { type: 'play', cards: [s.hands[1][0]] })
  assert.equal(notTurn.ok, false)
  assert.equal(notTurn.session, s)

  const notInHand = applyAction(s, 0, { type: 'play', cards: [card(99)] })
  assert.equal(notInHand.ok, false)
  assert.match(notInHand.error ?? '', /没有这些牌/)

  const norm = s.hands[0].filter((c) => !c.joker)
  const a = norm[0]
  const b = norm.find((c) => c.rank !== a.rank) as Card
  const badCombo = applyAction(s, 0, { type: 'play', cards: [a, b] })
  assert.equal(badCombo.ok, false)
  assert.match(badCombo.error ?? '', /合法牌型/)

  const leadPass = applyAction(s, 0, { type: 'pass' })
  assert.equal(leadPass.ok, false)
  assert.match(leadPass.error ?? '', /领出方/)

  assert.equal(JSON.stringify(s), snapshot, '所有失败动作都不应改动 session')
})

// 6
test('mj：摸打推进——打牌→轮转→摸牌→打牌，牌墙/弃牌/手牌数量正确', () => {
  let s = createSession('mj', 4, { seed: 2 }) as MjSession
  const wall0 = s.wall.length
  let r = applyAction(s, 0, { type: 'discard', tile: s.hands[0][0] })
  assert.equal(r.ok, true)
  s = r.session as MjSession
  assert.equal(turnSeat(s), 1)
  assert.equal(s.phase, 'await_draw')
  assert.equal(s.discards.length, 1)
  assert.equal(s.hands[0].length, 13)

  r = applyAction(s, 1, { type: 'draw' })
  assert.equal(r.ok, true)
  s = r.session as MjSession
  assert.equal(s.hands[1].length, 14)
  assert.equal(s.phase, 'await_discard')
  assert.equal(s.wall.length, wall0 - 1)

  r = applyAction(s, 1, { type: 'discard', tile: s.hands[1][0] })
  assert.equal(r.ok, true)
  s = r.session as MjSession
  assert.equal(turnSeat(s), 2)
  assert.equal(s.discards.length, 2)
})

// 7
test('mj：非法动作被拒绝（该摸牌时打牌 / 不是我摸 / 手里没有该牌）', () => {
  let s = createSession('mj', 4, { seed: 2 }) as MjSession
  const r0 = applyAction(s, 0, { type: 'discard', tile: s.hands[0][0] })
  s = r0.session as MjSession // 现在轮到 1 号，phase=await_draw
  assert.equal(s.phase, 'await_draw')

  const discardWhenDraw = applyAction(s, 1, { type: 'discard', tile: s.hands[1][0] })
  assert.equal(discardWhenDraw.ok, false)

  const wrongSeatDraw = applyAction(s, 2, { type: 'draw' })
  assert.equal(wrongSeatDraw.ok, false)

  // 摸牌后进入该打牌，打一张手里没有的牌
  s = applyAction(s, 1, { type: 'draw' }).session as MjSession
  const kinds: TileKind[] = ['wan', 'tong', 'tiao', 'zi']
  const maxRank: Record<TileKind, number> = { wan: 9, tong: 9, tiao: 9, zi: 7 }
  let absent: Tile | null = null
  for (const k of kinds) {
    for (let rank = 1; rank <= maxRank[k]; rank++) {
      if (!s.hands[1].some((t) => t.kind === k && t.rank === rank)) {
        absent = { kind: k, rank }
        break
      }
    }
    if (absent) break
  }
  assert.ok(absent)
  const notInHand = applyAction(s, 1, { type: 'discard', tile: absent! })
  assert.equal(notInHand.ok, false)
  assert.match(notInHand.error ?? '', /没有这张牌/)
})

// 8
test('ddz：一路打到底能走到结算（done=true 且只有一个赢家）', () => {
  const { session, last } = playDdzToEnd(11, 10)
  assert.equal(session.done, true)
  assert.equal(last.done, true)
  assert.ok(last.settlement)
  assert.equal(last.settlement!.winners.length, 1)
  assert.equal(turnSeat(session), null)
})

// 9
test('ddz：settlement 金额守恒（share 之和 == pot，net 之和 == 0，赢家净赚）', () => {
  const { last } = playDdzToEnd(11, 10)
  const st = last.settlement!
  assert.equal(st.pot, 10 * 3, 'pot = seatFee * seats')
  const shareSum = st.shares.reduce((n, x) => n + x.amount, 0)
  assert.equal(shareSum, st.pot, '分给赢家的总和必须等于底池')
  const netSum = st.net.reduce((n, x) => n + x.delta, 0)
  assert.equal(netSum, 0, '所有人净变化之和必须为 0')
  const winner = st.winners[0]
  const winnerNet = st.net.find((x) => x.seat === winner)!.delta
  assert.ok(winnerNet > 0, '赢家净赚')
  for (const x of st.net) if (x.seat !== winner) assert.equal(x.delta, -10, '输家各付入座费')
})

// 10
test('对局结束后 turnSeat 返回 null，且 applyAction 被拒绝', () => {
  const { session } = playDdzToEnd(11, 0)
  assert.equal(turnSeat(session), null)
  const r = applyAction(session, 0, { type: 'pass' })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /已结束/)
})

// 11
test('createSession：玩家数不对抛错（ddz 必须 3、mj 必须 4）', () => {
  assert.throws(() => createSession('ddz', 2), /3 名玩家/)
  assert.throws(() => createSession('mj', 3), /4 名玩家/)
})

// 12
test('mj：胡牌判定与结算（构造一副胡牌，hu 后 done + settlement）', () => {
  const base = createSession('mj', 4, { seed: 9, seatFee: 5 }) as MjSession
  const winHand: Tile[] = [
    tile('wan', 1), tile('wan', 2), tile('wan', 3),
    tile('wan', 4), tile('wan', 5), tile('wan', 6),
    tile('wan', 7), tile('wan', 8), tile('wan', 9),
    tile('tong', 1), tile('tong', 2), tile('tong', 3),
    tile('tiao', 5), tile('tiao', 5),
  ]
  const s: MjSession = { ...base, hands: [winHand, base.hands[1], base.hands[2], base.hands[3]], phase: 'await_discard', turn: 0 }
  const r = applyAction(s, 0, { type: 'hu' })
  assert.equal(r.ok, true)
  assert.equal(r.done, true)
  assert.equal(r.settlement!.winners[0], 0)
  assert.equal(r.settlement!.pot, 5 * 4)
  assert.equal(r.settlement!.shares.reduce((n, x) => n + x.amount, 0), 20)
})

// 13
test('applyAction 纯度：成功动作后原 session 各手牌/牌墙均未被就地修改', () => {
  const s = createSession('mj', 4, { seed: 4 }) as MjSession
  const wallLen = s.wall.length
  const hand0 = s.hands[0].length
  const snapshot = JSON.stringify(s)
  const r = applyAction(s, 0, { type: 'discard', tile: s.hands[0][0] })
  assert.equal(r.ok, true)
  assert.equal(JSON.stringify(s), snapshot, '原 session 完全不变')
  assert.equal(s.wall.length, wallLen)
  assert.equal(s.hands[0].length, hand0)
})
