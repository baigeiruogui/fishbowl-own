import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import { getFish } from '../src/db/index.ts'
import type { DB } from '../src/db/index.ts'

const ADMIN = 't34-admin'
const RES = '/town/api/resident'

async function setup() {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN })
  const db = (app as unknown as { db: DB }).db
  return { app, db }
}

async function resident(app: Awaited<ReturnType<typeof buildServer>>, name: string, balance = 100) {
  const created = (
    await app.inject({ method: 'POST', url: '/api/owner/fish', headers: { 'x-admin-token': ADMIN }, payload: { name, balance } })
  ).json() as any
  return { id: created.fish.id, headers: { authorization: 'Bearer ' + created.code } }
}

// 1) 送礼扣款 + 社交预算校验
test('P3 接线：送礼扣款、GET /social 预算/已用；超预算被拒', async () => {
  const { app, db } = await setup()
  const a = await resident(app, '送礼鱼', 100)
  const b = await resident(app, '收礼鱼', 100)

  const g = await app.inject({ method: 'POST', url: `${RES}/social/gift`, headers: a.headers, payload: { to: b.id, item: '玫瑰花', price: 10, words: '谢谢你' } })
  const gb = g.json() as any
  assert.equal(gb.ok, true)
  assert.equal(gb.receipt.delta, -10)
  assert.equal(getFish(db, a.id)!.balance, 90)
  assert.equal(getFish(db, b.id)!.balance, 100, '送礼只扣送礼人（礼物不入账）')

  const social = await app.inject({ method: 'GET', url: `${RES}/social`, headers: a.headers })
  const sb = social.json() as any
  assert.equal(sb.ok, true)
  assert.equal(sb.used, 10)
  assert.equal(sb.remaining, sb.budget - 10)

  // 超预算（默认预算 50）→ 拒绝，不再扣
  const big = await app.inject({ method: 'POST', url: `${RES}/social/gift`, headers: a.headers, payload: { to: b.id, item: '大礼', price: 9999 } })
  assert.notEqual(big.statusCode, 200)
  assert.equal((big.json() as any).error, 'DAY_CAP')
  assert.equal(getFish(db, a.id)!.balance, 90)
  await app.close()
})

// 2) 加好友 + 发消息（仅好友）
test('P3 接线：加好友（幂等）、发消息仅好友可发、GET /phone 可见', async () => {
  const { app } = await setup()
  const a = await resident(app, '甲鱼', 100)
  const b = await resident(app, '乙鱼', 100)
  const c = await resident(app, '丙鱼', 100)

  const f1 = await app.inject({ method: 'POST', url: `${RES}/relations/friend`, headers: a.headers, payload: { fish: b.id } })
  assert.equal((f1.json() as any).ok, true)
  assert.equal((f1.json() as any).friend.created, true)
  const f2 = await app.inject({ method: 'POST', url: `${RES}/relations/friend`, headers: a.headers, payload: { fish: b.id } })
  assert.equal((f2.json() as any).friend.created, false, '重复加好友幂等')

  const relA = await app.inject({ method: 'GET', url: `${RES}/relations`, headers: a.headers })
  assert.ok((relA.json() as any).relations.some((r: any) => r.fishId === b.id))
  const relB = await app.inject({ method: 'GET', url: `${RES}/relations`, headers: b.headers })
  assert.ok((relB.json() as any).relations.some((r: any) => r.fishId === a.id), '关系对称')

  const msg = await app.inject({ method: 'POST', url: `${RES}/phone`, headers: a.headers, payload: { to: b.id, text: '晚上一起钓鱼吗' } })
  assert.equal((msg.json() as any).ok, true)

  const inbox = await app.inject({ method: 'GET', url: `${RES}/phone`, headers: b.headers })
  assert.ok((inbox.json() as any).messages.some((m: any) => m.text === '晚上一起钓鱼吗'))

  // 非好友不能发
  const denied = await app.inject({ method: 'POST', url: `${RES}/phone`, headers: a.headers, payload: { to: c.id, text: 'hi' } })
  assert.equal(denied.statusCode, 400)
  await app.close()
})

// 3) 法庭：立案→举证→投票→判决（有罪赔付）
test('P3 接线：法庭 立案→举证→投票→判决，有罪从镇财政赔付给原告', async () => {
  const { app, db } = await setup()
  const plaintiff = await resident(app, '原告', 100)
  const defendant = await resident(app, '被告', 100)
  const j1 = await resident(app, '陪审甲', 0)
  const j2 = await resident(app, '陪审乙', 0)

  const filed = await app.inject({ method: 'POST', url: `${RES}/court/file`, headers: plaintiff.headers, payload: { defendant: defendant.id, kind: 'theft', desc: '偷了我的鱼干' } })
  const caseId = (filed.json() as any).case.id as string
  assert.equal((filed.json() as any).case.state, 'filed')

  const ev = await app.inject({ method: 'POST', url: `${RES}/court/evidence`, headers: plaintiff.headers, payload: { case_id: caseId, text: '监控截图' } })
  assert.equal((ev.json() as any).case.state, 'hearing')

  await app.inject({ method: 'POST', url: `${RES}/court/vote`, headers: j1.headers, payload: { case_id: caseId, guilty: true } })
  const voted = await app.inject({ method: 'POST', url: `${RES}/court/vote`, headers: j2.headers, payload: { case_id: caseId, guilty: true } })
  assert.equal((voted.json() as any).case.state, 'jury')

  const verdict = await app.inject({ method: 'POST', url: `${RES}/court/verdict`, headers: plaintiff.headers, payload: { case_id: caseId, damages: 20 } })
  const vb = verdict.json() as any
  assert.equal(vb.ok, true)
  assert.equal(vb.result.case.verdict, 'guilty')
  assert.equal(vb.result.paid, true)
  assert.equal(vb.result.amount, 20)
  assert.equal(getFish(db, plaintiff.id)!.balance, 120, '原告收到 20 赔付')

  const courtRows = db.prepare(`SELECT COALESCE(SUM(delta),0) AS s, COUNT(*) AS c FROM ledger WHERE reason='court'`).get() as { s: number; c: number }
  assert.equal(Number(courtRows.c), 2)
  assert.equal(Number(courtRows.s), 0, '赔付账本守恒')

  const one = await app.inject({ method: 'GET', url: `${RES}/court/${caseId}`, headers: plaintiff.headers })
  assert.equal((one.json() as any).case.state, 'verdict')
  const list = await app.inject({ method: 'GET', url: `${RES}/court`, headers: plaintiff.headers })
  assert.ok((list.json() as any).cases.some((c: any) => c.id === caseId))
  await app.close()
})

// 4) 公开端点：court / relations / phone（隐私占位）
test('P3 接线：public court/relations/phone 可用（phone 隐私占位）', async () => {
  const { app } = await setup()
  const a = await resident(app, '公开甲', 100)
  const b = await resident(app, '公开乙', 100)
  await app.inject({ method: 'POST', url: `${RES}/relations/friend`, headers: a.headers, payload: { fish: b.id } })
  await app.inject({ method: 'POST', url: `${RES}/court/file`, headers: a.headers, payload: { defendant: b.id, kind: 'civil', desc: '小纠纷' } })

  const court = await app.inject({ method: 'GET', url: '/api/public/court' })
  assert.equal(court.statusCode, 200)
  assert.ok(Array.isArray((court.json() as any).cases))
  assert.ok((court.json() as any).cases.length >= 1)

  const relations = await app.inject({ method: 'GET', url: '/api/public/relations' })
  assert.equal((relations.json() as any).ok, true)
  assert.ok(Array.isArray((relations.json() as any).relations))
  assert.ok((relations.json() as any).relations.some((r: any) => r.a.id === a.id || r.b.id === a.id))

  const phone = await app.inject({ method: 'GET', url: '/api/public/phone' })
  const pb = phone.json() as any
  assert.equal(pb.ok, true)
  assert.equal(pb.public, false)
  assert.deepEqual(pb.messages, [])
  await app.close()
})
