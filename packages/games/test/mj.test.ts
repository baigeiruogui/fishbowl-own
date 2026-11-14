import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createWall,
  createState,
  draw,
  discard,
  canWin,
} from '../src/mj.ts'
import type { Tile, TileKind, Meld, State } from '../src/mj.ts'

function t(kind: TileKind, rank: number): Tile {
  return { kind, rank }
}

test('createWall 生成 136 张，每种牌 4 张，且同 seed 可复现', () => {
  const wall = createWall(1)
  assert.equal(wall.length, 136)
  const counts = new Map<string, number>()
  for (const tile of wall) {
    const key = `${tile.kind}-${tile.rank}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  // 3 门 * 9 + 7 字 = 34 种，每种 4 张
  assert.equal(counts.size, 34)
  for (const v of counts.values()) assert.equal(v, 4)
  assert.deepEqual(createWall(1), createWall(1))
  assert.notDeepEqual(createWall(1), createWall(2))
})

test('draw 从牌墙摸一张进手牌', () => {
  const state = createState(5)
  assert.equal(state.wall.length, 136)
  assert.equal(state.hand.length, 0)
  const result = draw(state)
  assert.ok(result)
  assert.equal(result!.state.wall.length, 135)
  assert.equal(result!.state.hand.length, 1)
  assert.deepEqual(result!.state.hand[0], result!.tile)
  // 原状态不被修改（纯函数）
  assert.equal(state.wall.length, 136)
  assert.equal(state.hand.length, 0)
})

test('draw 牌墙为空时返回 null', () => {
  const empty: State = { hand: [], wall: [], discards: [], melds: [] }
  assert.equal(draw(empty), null)
})

test('discard 把牌从手牌移到弃牌堆', () => {
  const state: State = {
    hand: [t('wan', 1), t('wan', 2), t('tong', 9)],
    wall: [],
    discards: [],
    melds: [],
  }
  const next = discard(state, t('wan', 1))
  assert.equal(next.hand.length, 2)
  assert.deepEqual(next.hand, [t('wan', 2), t('tong', 9)])
  assert.deepEqual(next.discards, [t('wan', 1)])
  assert.equal(state.hand.length, 3, '原状态不变')
  assert.throws(() => discard(state, t('zi', 7)), /not in hand/)
})

test('canWin 标准型：4 面子 + 1 将 判胡', () => {
  const hand: Tile[] = [
    t('wan', 1), t('wan', 2), t('wan', 3),
    t('wan', 4), t('wan', 5), t('wan', 6),
    t('wan', 7), t('wan', 8), t('wan', 9),
    t('tong', 1), t('tong', 2), t('tong', 3),
    t('tiao', 5), t('tiao', 5),
  ]
  assert.equal(canWin(hand), true)
})

test('canWin 标准型反例：无法拆成面子+将 不胡', () => {
  const hand: Tile[] = [
    t('wan', 1), t('wan', 4), t('wan', 7),
    t('tong', 1), t('tong', 4), t('tong', 7),
    t('tiao', 1), t('tiao', 4), t('tiao', 7),
    t('zi', 1), t('zi', 2), t('zi', 3),
    t('zi', 7), t('zi', 7),
  ]
  assert.equal(canWin(hand), false)
})

test('canWin 七对', () => {
  const hand: Tile[] = [
    t('wan', 1), t('wan', 1), t('wan', 2), t('wan', 2),
    t('wan', 3), t('wan', 3), t('wan', 4), t('wan', 4),
    t('wan', 5), t('wan', 5), t('wan', 6), t('wan', 6),
    t('wan', 7), t('wan', 7),
  ]
  assert.equal(canWin(hand), true)
})

test('canWin 带副露（碰）时只需补齐剩余面子', () => {
  const melds: Meld[] = [{ kind: 'peng', tiles: [t('wan', 1), t('wan', 1), t('wan', 1)] }]
  const hand: Tile[] = [
    t('wan', 2), t('wan', 3), t('wan', 4),
    t('wan', 5), t('wan', 6), t('wan', 7),
    t('tong', 1), t('tong', 2), t('tong', 3),
    t('tiao', 9), t('tiao', 9),
  ]
  assert.equal(canWin(hand, melds), true)
})

test('canWin 字牌不能组顺子（只能刻子）', () => {
  const hand: Tile[] = [
    t('zi', 1), t('zi', 2), t('zi', 3),
    t('wan', 1), t('wan', 2), t('wan', 3),
    t('tong', 1), t('tong', 2), t('tong', 3),
    t('tiao', 7), t('tiao', 8), t('tiao', 9),
    t('zi', 7), t('zi', 7),
  ]
  // 仅 3 个面子 + 将，字牌 1-2-3 不能成顺 → 不胡
  assert.equal(canWin(hand), false)

  // 改成字牌刻子则胡
  const winHand: Tile[] = [
    t('zi', 1), t('zi', 1), t('zi', 1),
    t('wan', 1), t('wan', 2), t('wan', 3),
    t('tong', 4), t('tong', 5), t('tong', 6),
    t('tiao', 7), t('tiao', 8), t('tiao', 9),
    t('zi', 5), t('zi', 5),
  ]
  assert.equal(canWin(winHand), true)
})

test('canWin 张数不对时不胡', () => {
  const thirteen = createWall(3).slice(0, 13)
  assert.equal(canWin(thirteen), false)
  const twelve = createWall(4).slice(0, 12)
  assert.equal(canWin(twelve), false)
})
