// @fishbowl/npc 决策大脑测试：可复现性、人格/时段/金钱倾向、边界与约束。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decide, makeRng } from '../src/index.ts'
import type { NpcAction, NpcView, Personality } from '../src/index.ts'

// ---------- 测试辅助 ----------

/** 构造一个基础快照，字段可覆盖。 */
function baseView(over: Partial<NpcView> = {}): NpcView {
  return {
    selfId: 'npc-1',
    coins: 100,
    personality: 'kind',
    tables: [],
    jobs: [],
    shops: [],
    bounties: [],
    timeOfDay: 'afternoon',
    ...over,
  }
}

/** 用 seed=1..n 跑 n 次决策，返回结果列表。 */
function runMany(view: NpcView, n = 2000): NpcAction[] {
  const out: NpcAction[] = []
  for (let i = 0; i < n; i++) out.push(decide(view, makeRng(i + 1)))
  return out
}

/** 某个谓词命中比例。 */
function rate(actions: NpcAction[], pred: (a: NpcAction) => boolean): number {
  if (actions.length === 0) return 0
  return actions.filter(pred).length / actions.length
}

function isMoney(a: NpcAction): boolean {
  return a.kind === 'work' || a.kind === 'bounty'
}

/** 一个「什么都有、且买得起 / 桌缺人」的富裕快照。 */
function richView(personality: Personality, over: Partial<NpcView> = {}): NpcView {
  return baseView({
    coins: 500,
    personality,
    tables: [{ id: 't1', game: 'mahjong', seats: 4, needed: 2, seatFee: 5 }],
    jobs: [{ id: 'j1', pay: 30, durationMin: 10 }],
    shops: [{ id: 's1', items: [{ id: 'tea', price: 8, stock: 10 }] }],
    bounties: [{ id: 'b1', reward: 50 }],
    timeOfDay: 'afternoon',
    ...over,
  })
}

// ---------- 1. 可复现性 ----------

test('同样 seed 的决策结果完全可复现', () => {
  const view = richView('greedy')
  const a = decide(view, makeRng(12345))
  const b = decide(view, makeRng(12345))
  assert.deepEqual(a, b)

  // 连续多次也一致
  for (let i = 0; i < 50; i++) {
    const v = richView('lively')
    assert.deepEqual(decide(v, makeRng(i)), decide(v, makeRng(i)))
  }
})

test('makeRng：同 seed 序列一致，且值域落在 [0,1)', () => {
  const r1 = makeRng(42)
  const r2 = makeRng(42)
  for (let i = 0; i < 20; i++) {
    const x = r1()
    assert.equal(x, r2())
    assert.ok(x >= 0 && x < 1, `期望 [0,1)，实际 ${x}`)
  }
})

test('makeRng：不同 seed 产生不同序列', () => {
  const a = makeRng(1)
  const b = makeRng(2)
  const seqA = Array.from({ length: 8 }, () => a())
  const seqB = Array.from({ length: 8 }, () => b())
  assert.notDeepEqual(seqA, seqB)
})

// ---------- 2. 空快照 / 边界 ----------

test('空快照返回 rest/none 且不抛异常', () => {
  const personalities: Personality[] = ['lively', 'lazy', 'greedy', 'kind']
  for (const p of personalities) {
    const view = baseView({ coins: 0, personality: p, timeOfDay: 'night' })
    for (let i = 0; i < 100; i++) {
      const action = decide(view, makeRng(i))
      assert.ok(action.kind === 'rest' || action.kind === 'none', `意外行为 ${JSON.stringify(action)}`)
      if (action.kind === 'rest') assert.ok(action.minutes > 0)
    }
  }
})

test('缺字段的畸形快照也不崩', () => {
  const broken = { selfId: 'x', coins: 0, personality: 'kind', timeOfDay: 'afternoon' } as unknown as NpcView
  assert.doesNotThrow(() => decide(broken, makeRng(1)))
  const a = decide(broken, makeRng(1))
  assert.equal(a.kind, 'rest')
})

// ---------- 3. 性格 + 金钱倾向 ----------

test('greedy + 缺钱：明显倾向 work/bounty', () => {
  const view = baseView({
    coins: 8,
    personality: 'greedy',
    tables: [{ id: 't1', game: 'mahjong', seats: 4, needed: 2, seatFee: 5 }],
    jobs: [{ id: 'j1', pay: 30, durationMin: 10 }],
    bounties: [{ id: 'b1', reward: 50 }],
    timeOfDay: 'afternoon',
  })
  const actions = runMany(view)
  assert.ok(rate(actions, isMoney) > 0.6, `赚钱比例过低：${rate(actions, isMoney)}`)
})

test('kind + 有钱：倾向 shop/play', () => {
  const view = richView('kind')
  const actions = runMany(view)
  const leisure = rate(actions, (a) => a.kind === 'shop' || a.kind === 'play')
  assert.ok(leisure > 0.55, `shop/play 比例过低：${leisure}`)
})

test('lively：最常见行为是 play', () => {
  const view = richView('lively')
  const actions = runMany(view)
  const playRate = rate(actions, (a) => a.kind === 'play')
  const others = {
    rest: rate(actions, (a) => a.kind === 'rest'),
    work: rate(actions, (a) => a.kind === 'work'),
    bounty: rate(actions, (a) => a.kind === 'bounty'),
    shop: rate(actions, (a) => a.kind === 'shop'),
  }
  for (const [k, v] of Object.entries(others)) {
    assert.ok(playRate > v, `play(${playRate}) 应高于 ${k}(${v})`)
  }
})

test('lazy + 夜里：明显倾向 rest', () => {
  const view = richView('lazy', { timeOfDay: 'night' })
  const actions = runMany(view)
  assert.ok(rate(actions, (a) => a.kind === 'rest') > 0.7, `夜里 rest 比例过低：${rate(actions, (a) => a.kind === 'rest')}`)
})

test('缺钱会抬高 work/bounty 比例（相对有钱时）', () => {
  const poor = baseView({
    coins: 5,
    personality: 'greedy',
    tables: [{ id: 't1', game: 'mahjong', seats: 4, needed: 2, seatFee: 0 }],
    jobs: [{ id: 'j1', pay: 30, durationMin: 10 }],
    bounties: [{ id: 'b1', reward: 50 }],
  })
  const rich = baseView({
    coins: 900,
    personality: 'greedy',
    tables: [{ id: 't1', game: 'mahjong', seats: 4, needed: 2, seatFee: 0 }],
    jobs: [{ id: 'j1', pay: 30, durationMin: 10 }],
    bounties: [{ id: 'b1', reward: 50 }],
  })
  const poorRate = rate(runMany(poor), isMoney)
  const richRate = rate(runMany(rich), isMoney)
  assert.ok(poorRate > richRate, `缺钱(${poorRate}) 应高于有钱(${richRate})`)
})

test('greedy 比 lively 更爱赚钱；lively 比 greedy 更爱玩', () => {
  const greedy = runMany(richView('greedy'))
  const lively = runMany(richView('lively'))
  assert.ok(rate(greedy, isMoney) > rate(lively, isMoney), 'greedy 赚钱比例应更高')
  assert.ok(
    rate(lively, (a) => a.kind === 'play') > rate(greedy, (a) => a.kind === 'play'),
    'lively 玩牌比例应更高',
  )
})

test('lazy 白天 rest 比例高于 lively', () => {
  const lazy = rate(runMany(richView('lazy', { timeOfDay: 'afternoon' })), (a) => a.kind === 'rest')
  const lively = rate(runMany(richView('lively', { timeOfDay: 'afternoon' })), (a) => a.kind === 'rest')
  assert.ok(lazy > lively, `lazy rest(${lazy}) 应高于 lively rest(${lively})`)
})

// ---------- 4. 硬约束 ----------

test('table 满员（needed=0）时绝不会 play', () => {
  const view = baseView({
    coins: 900,
    personality: 'lively',
    tables: [{ id: 'full', game: 'mahjong', seats: 4, needed: 0, seatFee: 0 }],
    timeOfDay: 'afternoon',
  })
  const actions = runMany(view, 1000)
  assert.equal(rate(actions, (a) => a.kind === 'play'), 0, '满员桌不应被选中')
})

test('table 缺人时会 play（说明约束不是一刀切）', () => {
  const view = baseView({
    coins: 900,
    personality: 'lively',
    tables: [{ id: 'open', game: 'doudizhu', seats: 3, needed: 1, seatFee: 0 }],
    timeOfDay: 'afternoon',
  })
  const actions = runMany(view, 1000)
  assert.ok(rate(actions, (a) => a.kind === 'play') > 0.1, '缺人的桌应有机会被选')
})

test('买不起的商品绝不会 shop', () => {
  const view = baseView({
    coins: 5,
    personality: 'kind',
    shops: [{ id: 's1', items: [{ id: 'gem', price: 999, stock: 10 }] }],
    timeOfDay: 'afternoon',
  })
  const actions = runMany(view, 1000)
  assert.equal(rate(actions, (a) => a.kind === 'shop'), 0, '买不起不应购买')
})

test('没库存（stock=0）的商品绝不会 shop', () => {
  const view = baseView({
    coins: 900,
    personality: 'kind',
    shops: [{ id: 's1', items: [{ id: 'soldout', price: 5, stock: 0 }] }],
    timeOfDay: 'afternoon',
  })
  const actions = runMany(view, 1000)
  assert.equal(rate(actions, (a) => a.kind === 'shop'), 0, '没货不应购买')
})

// ---------- 5. 休息时长 ----------

test('夜里休息时长明显长于早晨', () => {
  const morning = decide(baseView({ personality: 'lazy', timeOfDay: 'morning' }), makeRng(7))
  const night = decide(baseView({ personality: 'lazy', timeOfDay: 'night' }), makeRng(7))
  assert.equal(morning.kind, 'rest')
  assert.equal(night.kind, 'rest')
  if (morning.kind === 'rest' && night.kind === 'rest') {
    assert.ok(night.minutes > morning.minutes, `夜里(${night.minutes}) 应长于早晨(${morning.minutes})`)
  }
})

// ---------- 6. 结构合法性 ----------

test('返回的 action 结构与引用的 id 都合法', () => {
  const view = richView('greedy')
  const jobIds = new Set(view.jobs.map((j) => j.id))
  const tableIds = new Set(view.tables.map((t) => t.id))
  const bountyIds = new Set(view.bounties.map((b) => b.id))
  const shopIds = new Set(view.shops.map((s) => s.id))
  const itemIds = new Set(view.shops.flatMap((s) => s.items.map((i) => i.id)))

  for (let i = 0; i < 500; i++) {
    const a = decide(view, makeRng(i))
    switch (a.kind) {
      case 'rest':
        assert.ok(typeof a.minutes === 'number' && a.minutes > 0)
        break
      case 'work':
        assert.ok(jobIds.has(a.jobId), `未知 jobId ${a.jobId}`)
        break
      case 'play':
        assert.ok(tableIds.has(a.tableId), `未知 tableId ${a.tableId}`)
        break
      case 'bounty':
        assert.ok(bountyIds.has(a.bountyId), `未知 bountyId ${a.bountyId}`)
        break
      case 'shop':
        assert.ok(shopIds.has(a.shopId), `未知 shopId ${a.shopId}`)
        assert.ok(itemIds.has(a.itemId), `未知 itemId ${a.itemId}`)
        break
      case 'none':
        break
      default: {
        const never: never = a
        assert.fail(`未知行为 ${JSON.stringify(never)}`)
      }
    }
  }
})
