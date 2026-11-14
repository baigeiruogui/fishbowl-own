import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, createFish } from '../src/db/index.ts'
import { createTurnEngine } from '../src/engine/index.ts'
import { TurnHub } from '../src/engine/hub.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function freshEngine(opts: { agencyCooldownMs?: number; redeliverMs?: number } = {}) {
  const db = openDb(':memory:')
  const engine = createTurnEngine(db, { agencyCooldownMs: 600_000, ...opts })
  return { db, engine }
}

/** 预热：先生成并答掉一个 agency，使 lastAgencyAt 置位、无 pending（长轮询会真正挂起）。 */
function prewarm(engine: ReturnType<typeof createTurnEngine>, fishId: string) {
  const t = engine.createAgency(fishId)
  engine.answer(fishId, t.turn_id, JSON.stringify({ action: 'none' }))
}

// ---------------- Hub 单等待者语义 ----------------
test('TurnHub：新等待者顶掉旧的（旧立即 kicked），notify 只唤醒当前一个', async () => {
  const hub = new TurnHub()
  const pA = hub.wait('f1', 2_000)
  await sleep(5)
  const pB = hub.wait('f1', 2_000)
  assert.equal(await pA, 'kicked', '旧的应被顶掉并立即返回')
  assert.equal(hub.hasWaiter('f1'), true)
  hub.notify('f1')
  assert.equal(await pB, 'notified', '只唤醒当前等待者')
  assert.equal(hub.hasWaiter('f1'), false)
})

test('TurnHub：超时返回 timeout', async () => {
  const hub = new TurnHub()
  assert.equal(await hub.wait('f2', 10), 'timeout')
})

// ---------------- 同鱼双长轮询顶替 ----------------
test('同鱼双长轮询：新的顶掉旧的（旧的立刻返回空），同一回合只投给新的一个', async () => {
  const { db, engine } = freshEngine()
  const fish = createFish(db, { name: '顶替鱼', balance: 100 })
  prewarm(engine, fish.id)

  const pOld = engine.poll(fish.id, { waitSec: 5 })
  await sleep(30)
  const pNew = engine.poll(fish.id, { waitSec: 5 })
  await sleep(30)

  const triggered = engine.createAgency(fish.id)
  const [oldTurns, newTurns] = await Promise.all([pOld, pNew])

  assert.equal(oldTurns.length, 0, '旧长轮询应立刻返回空（被顶掉）')
  assert.equal(newTurns.length, 1, '新长轮询恰好收到一个回合')
  assert.equal(newTurns[0].turn_id, triggered.turn_id, '收到的是触发的那一个回合')
})

// ---------------- 多鱼不串台 ----------------
test('多鱼并发：各收各的回合，不重复、不串台', async () => {
  const { db, engine } = freshEngine()
  const f1 = createFish(db, { name: '鱼A', balance: 100 })
  const f2 = createFish(db, { name: '鱼B', balance: 100 })
  const f3 = createFish(db, { name: '鱼C', balance: 100 })
  prewarm(engine, f1.id)
  prewarm(engine, f2.id)
  prewarm(engine, f3.id)

  const p1 = engine.poll(f1.id, { waitSec: 5 })
  const p2 = engine.poll(f2.id, { waitSec: 5 })
  const p3 = engine.poll(f3.id, { waitSec: 5 })
  await sleep(30)
  const t1 = engine.createAgency(f1.id)
  const t2 = engine.createAgency(f2.id)
  const t3 = engine.createAgency(f3.id)
  const [r1, r2, r3] = await Promise.all([p1, p2, p3])

  assert.equal(r1.length, 1)
  assert.equal(r2.length, 1)
  assert.equal(r3.length, 1)
  assert.equal(r1[0].turn_id, t1.turn_id)
  assert.equal(r2[0].turn_id, t2.turn_id)
  assert.equal(r3[0].turn_id, t3.turn_id)
  assert.equal(new Set([r1[0].turn_id, r2[0].turn_id, r3[0].turn_id]).size, 3, '三条鱼三个不同的回合')
})

// ---------------- 回合一次性认领 + 10 秒重发 ----------------
test('认领：同一回合在重发窗口内只投递一次，过了 redeliverMs 才重发', async () => {
  const { db, engine } = freshEngine({ redeliverMs: 40 })
  const fish = createFish(db, { name: '重发鱼', balance: 100 })
  prewarm(engine, fish.id)

  const t = engine.createAgency(fish.id)
  const first = await engine.poll(fish.id, { waitSec: 0 })
  assert.equal(first.length, 1)
  assert.equal(first[0].turn_id, t.turn_id)

  // 窗口内再轮询：不应重复投递
  const within = await engine.poll(fish.id, { waitSec: 0 })
  assert.equal(within.length, 0, '重发窗口内同一回合不得重复投递')

  // 过了 redeliverMs：允许重发（发出后未答，下次轮询重发）
  await sleep(60)
  const redelivered = await engine.poll(fish.id, { waitSec: 0 })
  assert.equal(redelivered.length, 1)
  assert.equal(redelivered[0].turn_id, t.turn_id)

  // 答掉后不再重发
  engine.answer(fish.id, t.turn_id, JSON.stringify({ action: 'none' }))
  const afterAnswer = await engine.poll(fish.id, { waitSec: 0 })
  assert.equal(afterAnswer.length, 0, '已回答的回合不应再投递')
})

test('认领：多个 pending 回合时每次只投一个，互不重复', async () => {
  const { db, engine } = freshEngine({ redeliverMs: 10_000 })
  const fish = createFish(db, { name: '多回合鱼', balance: 100 })
  prewarm(engine, fish.id)

  const a = engine.createAgency(fish.id)
  const b = engine.createAgency(fish.id)
  const p1 = await engine.poll(fish.id, { waitSec: 0 })
  const p2 = await engine.poll(fish.id, { waitSec: 0 })
  assert.equal(p1.length, 1)
  assert.equal(p2.length, 1)
  const ids = new Set([p1[0].turn_id, p2[0].turn_id])
  assert.equal(ids.size, 2, '两次投递应是两个不同的回合')
  assert.ok(ids.has(a.turn_id) && ids.has(b.turn_id))
})
