import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import { createFish, getFish } from '../src/db/index.ts'
import type { DB } from '../src/db/index.ts'
import { issueResidentCode } from '../src/api/auth.ts'
import { createJobOffer } from '../src/domain/jobs.ts'
import { addCatch } from '../src/domain/fishing.ts'
import type { TurnEngine } from '../src/engine/index.ts'

const BASE = '/town/api/resident'

async function setup() {
  const app = await buildServer({ dbPath: ':memory:', engine: { agencyCooldownMs: 0 } })
  const db = (app as unknown as { db: DB }).db
  const engine = (app as unknown as { engine: TurnEngine }).engine
  const fish = createFish(db, { name: '测试鱼', balance: 100 })
  const { code } = issueResidentCode(db, fish.id)
  const headers = { authorization: 'Bearer ' + code }
  return { app, db, engine, fish, headers }
}

// ---------------- 鉴权 ----------------
test('resident: 没有/错误的接入码 → 401 RESIDENT_CODE', async () => {
  const { app } = await setup()
  const noAuth = await app.inject({ method: 'GET', url: `${BASE}/status` })
  assert.equal(noAuth.statusCode, 401)
  assert.equal(noAuth.json().error, 'RESIDENT_CODE')

  const bad = await app.inject({ method: 'GET', url: `${BASE}/status`, headers: { authorization: 'Bearer fbr_deadbeef' } })
  assert.equal(bad.statusCode, 401)

  const notFbr = await app.inject({ method: 'GET', url: `${BASE}/status`, headers: { authorization: 'Bearer fbo_other' } })
  assert.equal(notFbr.statusCode, 401)
  await app.close()
})

// ---------------- 回合：turns → answer 往返 ----------------
test('resident: GET turns 生成长轮询回合，POST turns/:id 交答案；重复交 → TURN_CLOSED', async () => {
  const { app, headers } = await setup()

  const got = await app.inject({ method: 'GET', url: `${BASE}/turns?wait=1&kinds=activity,agency`, headers })
  assert.equal(got.statusCode, 200)
  const page = got.json() as { turns: any[] }
  assert.ok(Array.isArray(page.turns) && page.turns.length === 1, '应有 1 个按需生成的回合')

  const turn = page.turns[0]
  assert.equal(turn.kind, 'agency')
  assert.equal(typeof turn.turn_id, 'string')
  assert.equal(typeof turn.deadline, 'number') // 绝对秒
  assert.ok(Array.isArray(turn.packet.messages) && turn.packet.messages.length >= 1)
  assert.ok(Array.isArray(turn.packet.actions) && turn.packet.actions.includes('pier'))
  assert.equal(typeof turn.packet.reply.hint, 'string')
  assert.equal(turn.packet.reply.format, 'json')

  const ans = await app.inject({
    method: 'POST',
    url: `${BASE}/turns/${turn.turn_id}`,
    headers,
    payload: { answer: JSON.stringify({ action: 'none', note: '先歇会' }) },
  })
  assert.equal(ans.statusCode, 200)
  const ab = ans.json() as any
  assert.equal(ab.ok, true)
  assert.equal(ab.receipt.ok, true)
  assert.equal(ab.receipt.code, 'OK')

  // 同一个回合再交一次：已答 → 409 TURN_CLOSED
  const again = await app.inject({
    method: 'POST',
    url: `${BASE}/turns/${turn.turn_id}`,
    headers,
    payload: { answer: JSON.stringify({ action: 'none' }) },
  })
  assert.equal(again.statusCode, 409)
  assert.equal(again.json().error, 'TURN_CLOSED')

  await app.close()
})

test('resident: POST agency 强制生成 agency 回合；回答 action=pier 会移动并生成 activity 回合', async () => {
  const { app, headers } = await setup()

  const ag = await app.inject({ method: 'POST', url: `${BASE}/agency`, headers })
  assert.equal(ag.statusCode, 200)
  const agb = ag.json() as any
  assert.equal(agb.ok, true)
  assert.equal(typeof agb.turn_id, 'string')

  const ans = await app.inject({
    method: 'POST',
    url: `${BASE}/turns/${agb.turn_id}`,
    headers,
    payload: { answer: JSON.stringify({ action: 'pier', note: '去钓鱼' }) },
  })
  assert.equal(ans.statusCode, 200)

  // 去了码头 → 下一步拿到 activity（码头说话）
  const got = await app.inject({ method: 'GET', url: `${BASE}/turns?wait=0&kinds=activity`, headers })
  const turns = (got.json() as any).turns as any[]
  const act = turns.find((t) => t.kind === 'activity')
  assert.ok(act, '应有一个 activity 回合')
  assert.equal(act.packet.reply.format, 'text')
  await app.close()
})

// ---------------- 赚钱：打工 take → 到期结算 → 余额增加 ----------------
test('resident: jobs/take → 到期结算(tick) → 余额增加；账本 reason=job', async () => {
  const { app, db, engine, fish, headers } = await setup()
  const offer = createJobOffer(db, { title: '码头搬鱼', pay: 30, durationMin: 1 })

  const take = await app.inject({
    method: 'POST',
    url: `${BASE}/jobs/take`,
    headers,
    payload: { offer_id: offer.id },
  })
  assert.equal(take.statusCode, 200)
  const tb = take.json() as any
  assert.equal(tb.ok, true)
  assert.equal(tb.contract.state, 'working')
  assert.equal(tb.contract.pay, 30)

  // GET jobs：能看到招工与我的在岗合同
  const jobs = await app.inject({ method: 'GET', url: `${BASE}/jobs`, headers })
  const jb = jobs.json() as any
  assert.ok(jb.jobs.some((j: any) => j.id === offer.id && j.pay === 30))
  assert.ok(jb.mine.some((c: any) => c.state === 'working'))

  // 推进时间到合同到期并结算
  const settleRes = engine.tick(Date.now() + 120_000)
  assert.equal(settleRes.settledJobs.length, 1)
  assert.equal(settleRes.settledJobs[0].pay, 30)

  const st = await app.inject({ method: 'GET', url: `${BASE}/status`, headers })
  assert.equal((st.json() as any).balance, 130) // 100 + 30

  const ledger = db
    .prepare('SELECT delta, reason FROM ledger WHERE fish_id = ? AND reason = ?')
    .all(fish.id, 'job') as unknown as { delta: number; reason: string }[]
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].delta, 30)

  await app.close()
})

// ---------------- 赚钱：钓鱼卖钱 ----------------
test('resident: GET market 有市场价；POST sell 卖鱼获 → 余额增加、reason=fish_sell', async () => {
  const { app, db, fish, headers } = await setup()
  addCatch(db, fish.id, '鲈鱼', 2) // 20/条

  const market = await app.inject({ method: 'GET', url: `${BASE}/market`, headers })
  assert.equal(market.statusCode, 200)
  const mb = market.json() as any
  assert.ok(mb.items.some((m: any) => m.item === '鲈鱼' && m.price === 20))
  assert.ok(mb.catch.some((h: any) => h.item === '鲈鱼' && h.qty === 2))

  const sell = await app.inject({
    method: 'POST',
    url: `${BASE}/sell`,
    headers,
    payload: { item: '鲈鱼', qty: 2 },
  })
  assert.equal(sell.statusCode, 200)
  const sb = sell.json() as any
  assert.equal(sb.sale.amount, 40)
  assert.equal(sb.receipt.delta, 40)

  const st = await app.inject({ method: 'GET', url: `${BASE}/status`, headers })
  assert.equal((st.json() as any).balance, 140) // 100 + 40

  const rows = db
    .prepare('SELECT delta, reason FROM ledger WHERE fish_id = ? AND reason = ?')
    .all(fish.id, 'fish_sell') as unknown as { delta: number; reason: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].delta, 40)
  await app.close()
})

// ---------------- 自助：goto / lobby / settings / status / events ----------------
test('resident: goto(pier, do=fish) 产出鱼获并生成 activity 回合；lobby 有码头', async () => {
  const { app, db, fish, headers } = await setup()

  const lobby = await app.inject({ method: 'GET', url: `${BASE}/lobby`, headers })
  assert.equal(lobby.statusCode, 200)
  const lb = lobby.json() as any
  assert.ok(Array.isArray(lb.places) && lb.places.some((p: any) => p.place === 'pier'))

  const go = await app.inject({
    method: 'POST',
    url: `${BASE}/goto`,
    headers,
    payload: { place: 'pier', do: 'fish' },
  })
  assert.equal(go.statusCode, 200)
  const gb = go.json() as any
  assert.equal(gb.ok, true)
  assert.equal(gb.place, 'pier')
  assert.equal(gb.outcome.item, '小鱼')

  // 码头钓鱼产出进了 catch
  const holdings = await app.inject({ method: 'GET', url: `${BASE}/market`, headers })
  assert.ok((holdings.json() as any).catch.some((h: any) => h.item === '小鱼'))

  // 并且生成了一个 activity 回合
  const got = await app.inject({ method: 'GET', url: `${BASE}/turns?wait=0&kinds=activity`, headers })
  assert.ok(((got.json() as any).turns as any[]).some((t) => t.kind === 'activity'))
  await app.close()
})

test('resident: settings 白名单（paused/day_cap 拒绝，允许 wake/social）；status/events 结构', async () => {
  const { app, headers } = await setup()

  // F3：resident 不能自清 day_cap / 自解 paused（敏感字段仅主人可改）
  const forbid = await app.inject({
    method: 'POST',
    url: `${BASE}/settings`,
    headers,
    payload: { paused: true, day_cap: 50 },
  })
  assert.equal(forbid.statusCode, 403)
  assert.equal((forbid.json() as any).error, 'FIELD_FORBIDDEN')

  const st0 = await app.inject({ method: 'GET', url: `${BASE}/status`, headers })
  const s0 = st0.json() as any
  assert.equal(s0.paused, false)
  assert.equal(s0.day_cap, null)
  assert.equal(typeof s0.fish_id, 'string')

  // 允许的字段：wake_min_minutes / quiet_hours / social_day_cents（F2：响应带 settings 对象）
  const ok = await app.inject({
    method: 'POST',
    url: `${BASE}/settings`,
    headers,
    payload: { wake_min_minutes: 30, quiet_hours: '22-7', social_day_cents: 500 },
  })
  assert.equal(ok.statusCode, 200)
  const sb = ok.json() as any
  assert.equal(sb.ok, true)
  assert.equal(sb.settings.social_day_cents, 500)
  assert.equal(sb.settings.social_day_cents_effective, 500)
  assert.equal(sb.settings.wake_min_minutes, 30)

  // 改这些仍不影响 paused/day_cap
  const st = await app.inject({ method: 'GET', url: `${BASE}/status`, headers })
  assert.equal((st.json() as any).paused, false)
  assert.equal((st.json() as any).day_cap, null)

  // 事件接口结构：{items, next}
  const ev = await app.inject({ method: 'GET', url: `${BASE}/events?after=0&limit=50`, headers })
  assert.equal(ev.statusCode, 200)
  const eb = ev.json() as any
  assert.ok(Array.isArray(eb.items))
  assert.equal(typeof eb.next, 'number')
  await app.close()
})

test('resident: 活动回合回答后事件里能看到 activity_line', async () => {
  const { app, headers } = await setup()
  // 先 goto 码头制造 activity
  await app.inject({ method: 'POST', url: `${BASE}/goto`, headers, payload: { place: 'pier' } })
  const got = await app.inject({ method: 'GET', url: `${BASE}/turns?wait=0&kinds=activity`, headers })
  const act = ((got.json() as any).turns as any[]).find((t) => t.kind === 'activity')
  assert.ok(act)

  await app.inject({
    method: 'POST',
    url: `${BASE}/turns/${act.turn_id}`,
    headers,
    payload: { answer: '海风真舒服呀' },
  })
  const ev = await app.inject({ method: 'GET', url: `${BASE}/events?after=0`, headers })
  const items = (ev.json() as any).items as any[]
  assert.ok(items.some((i) => i.kind === 'activity_line' && i.data.line === '海风真舒服呀'))
  await app.close()
})

test('resident: kinds=activity 仍会收到核心 agency 回合（kinds 是可选加项，不是白名单）', async () => {
  const { app, headers } = await setup()
  const got = await app.inject({ method: 'GET', url: `${BASE}/turns?wait=0&kinds=activity`, headers })
  assert.equal(got.statusCode, 200)
  const turns = (got.json() as any).turns as any[]
  assert.ok(turns.some((t) => t.kind === 'agency'), 'agency 是核心类型，应随 kinds=activity 一起下发')
  await app.close()
})
