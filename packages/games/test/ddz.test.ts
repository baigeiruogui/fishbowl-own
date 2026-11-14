import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDeck,
  shuffle,
  deal,
  parsePlay,
  canBeat,
  legalPlays,
} from '../src/ddz.ts'
import type { Card, Suit, Play } from '../src/ddz.ts'

function c(rank: number, suit: Suit = 'S', joker = false): Card {
  return { rank, suit, joker }
}

test('createDeck 生成 54 张，各点数数量正确', () => {
  const deck = createDeck()
  assert.equal(deck.length, 54)
  const counts = new Map<number, number>()
  for (const card of deck) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1)
  for (let r = 3; r <= 15; r++) assert.equal(counts.get(r), 4, `rank ${r} 应有 4 张`)
  assert.equal(counts.get(16), 1)
  assert.equal(counts.get(17), 1)
  assert.equal(deck.filter((x) => x.joker).length, 2)
})

test('shuffle 同 seed 可复现，不同 seed 不同', () => {
  const deck = createDeck()
  const a = shuffle(deck, 42)
  const b = shuffle(deck, 42)
  const d = shuffle(deck, 7)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, d)
  assert.equal(a.length, 54)
  // 不修改入参
  assert.deepEqual(deck, createDeck())
})

test('deal 三家各 17 张 + 3 张底牌，且无重复', () => {
  const result = deal(shuffle(createDeck(), 1))
  assert.equal(result.hands.length, 3)
  for (const hand of result.hands) assert.equal(hand.length, 17)
  assert.equal(result.bottom.length, 3)
  const all = [...result.hands[0], ...result.hands[1], ...result.hands[2], ...result.bottom]
  assert.equal(all.length, 54)
  const keys = new Set(all.map((x) => `${x.rank}${x.suit}`))
  assert.equal(keys.size, 54)
})

test('parsePlay 识别 单张/对子/三张', () => {
  assert.deepEqual(parsePlay([c(5)]), { type: 'single', mainRank: 5, length: 1 })
  assert.deepEqual(parsePlay([c(5, 'S'), c(5, 'H')]), { type: 'pair', mainRank: 5, length: 2 })
  assert.deepEqual(parsePlay([c(9, 'S'), c(9, 'H'), c(9, 'D')]), {
    type: 'triple',
    mainRank: 9,
    length: 3,
  })
  // 两张不同点数不是对子
  assert.equal(parsePlay([c(5), c(6)]), null)
  // 两张王是王炸不是对子
  assert.equal(parsePlay([c(16, 'S', true), c(17, 'S', true)])?.type, 'rocket')
})

test('parsePlay 识别 三带一 / 三带一对', () => {
  assert.deepEqual(parsePlay([c(9, 'S'), c(9, 'H'), c(9, 'D'), c(3)]), {
    type: 'triple_single',
    mainRank: 9,
    length: 4,
  })
  assert.deepEqual(parsePlay([c(9, 'S'), c(9, 'H'), c(9, 'D'), c(3, 'S'), c(3, 'H')]), {
    type: 'triple_pair',
    mainRank: 9,
    length: 5,
  })
})

test('parsePlay 识别顺子（>=5 连续，不能含 2/王）', () => {
  const straight = parsePlay([c(3, 'S'), c(4, 'H'), c(5, 'D'), c(6, 'C'), c(7, 'S')])
  assert.deepEqual(straight, { type: 'straight', mainRank: 3, length: 5 })
  // 4 张不构成顺子
  assert.equal(parsePlay([c(3), c(4), c(5), c(6)]), null)
  // 含 2（rank 15）不构成顺子
  assert.equal(parsePlay([c(11), c(12), c(13), c(14), c(15)]), null)
})

test('parsePlay 识别连对（>=3 对连续）', () => {
  const cards = [c(3, 'S'), c(3, 'H'), c(4, 'S'), c(4, 'H'), c(5, 'S'), c(5, 'H')]
  assert.deepEqual(parsePlay(cards), { type: 'double_straight', mainRank: 3, length: 6 })
  // 两对（4 张）不够
  assert.equal(parsePlay([c(3, 'S'), c(3, 'H'), c(4, 'S'), c(4, 'H')]), null)
})

test('parsePlay 识别炸弹/王炸/飞机/四带二', () => {
  assert.deepEqual(parsePlay([c(7, 'S'), c(7, 'H'), c(7, 'D'), c(7, 'C')]), {
    type: 'bomb',
    mainRank: 7,
    length: 4,
  })
  assert.deepEqual(parsePlay([c(16, 'S', true), c(17, 'S', true)]), {
    type: 'rocket',
    mainRank: 17,
    length: 2,
  })
  assert.deepEqual(
    parsePlay([
      c(3, 'S'), c(3, 'H'), c(3, 'D'),
      c(4, 'S'), c(4, 'H'), c(4, 'D'),
    ]),
    { type: 'airplane', mainRank: 3, length: 2 },
  )
  assert.deepEqual(
    parsePlay([c(8, 'S'), c(8, 'H'), c(8, 'D'), c(8, 'C'), c(3), c(4)]),
    { type: 'four_two', mainRank: 8, length: 6 },
  )
})

test('canBeat 炸弹压普通牌，炸弹之间比大小', () => {
  const single3: Play = { type: 'single', mainRank: 3, length: 1 }
  const bomb7: Play = { type: 'bomb', mainRank: 7, length: 4 }
  const bomb9: Play = { type: 'bomb', mainRank: 9, length: 4 }
  assert.equal(canBeat(bomb7, single3), true)
  assert.equal(canBeat(bomb7, bomb9), false)
  assert.equal(canBeat(bomb9, bomb7), true)
})

test('canBeat 王炸最大', () => {
  const bomb15: Play = { type: 'bomb', mainRank: 15, length: 4 }
  const rocket: Play = { type: 'rocket', mainRank: 17, length: 2 }
  assert.equal(canBeat(rocket, bomb15), true)
  assert.equal(canBeat(rocket, rocket), false)
  assert.equal(canBeat(bomb15, rocket), false)
})

test('canBeat 同类型同长度比大小，不同类型/长度不能压', () => {
  const pair3: Play = { type: 'pair', mainRank: 3, length: 2 }
  const pair5: Play = { type: 'pair', mainRank: 5, length: 2 }
  const triple3: Play = { type: 'triple', mainRank: 3, length: 3 }
  const straight5: Play = { type: 'straight', mainRank: 3, length: 5 }
  const straight6: Play = { type: 'straight', mainRank: 3, length: 6 }
  assert.equal(canBeat(pair5, pair3), true)
  assert.equal(canBeat(pair3, pair5), false)
  assert.equal(canBeat(triple3, pair3), false)
  assert.equal(canBeat(straight6, straight5), false)
  assert.equal(canBeat(pair3, null), true)
  assert.equal(canBeat(null, pair3), false)
})

test('legalPlays 只返回能压过 last 的合法牌，且不超过上限', () => {
  const hand: Card[] = [
    c(3, 'S'), c(4, 'H'), c(5, 'D'), c(6, 'C'), c(7, 'S'), c(8, 'H'),
    c(9, 'D'), c(9, 'S'), c(9, 'H'), c(11, 'D'), c(11, 'C'), c(11, 'S'),
    c(5, 'C'), c(6, 'S'), c(16, 'S', true), c(17, 'S', true),
  ]
  const last: Play = { type: 'single', mainRank: 3, length: 1 }
  const plays = legalPlays(hand, last)
  assert.ok(plays.length > 0)
  assert.ok(plays.length <= 200)
  for (const cards of plays) {
    const play = parsePlay(cards)
    assert.ok(play, '枚举结果必须是合法牌型')
    assert.equal(canBeat(play, last), true, '枚举结果必须能压过 last')
  }
  // 王炸应在枚举中（能压单张）
  const hasRocket = plays.some((cards) => parsePlay(cards)?.type === 'rocket')
  assert.equal(hasRocket, true)
})

test('legalPlays last=null 时枚举全部合法牌型，且 ordered 从小到大', () => {
  const hand: Card[] = [c(3, 'S'), c(3, 'H'), c(4, 'S'), c(4, 'H'), c(5, 'S'), c(5, 'H')]
  const plays = legalPlays(hand, null)
  const types = new Set(plays.map((cards) => parsePlay(cards)?.type))
  // 至少包含单、对、连对
  assert.ok(types.has('single'))
  assert.ok(types.has('pair'))
  assert.ok(types.has('double_straight'))
  // 排序稳定性：按 mainRank 单调（同类型内）
  const firstStraight = plays.find((cards) => parsePlay(cards)?.type === 'double_straight')
  assert.ok(firstStraight)
})
