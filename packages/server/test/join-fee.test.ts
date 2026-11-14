import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import type { DB } from '../src/db/index.ts'

const ADMIN = 'join-admin'
const adminH = { 'x-admin-token': ADMIN }

async function setup(joinPriceYuan: number, opts: { openRegistration?: boolean; paymentNote?: string; paymentQrUrl?: string } = {}) {
  const app = await buildServer({
    dbPath: ':memory:',
    adminToken: ADMIN,
    joinPriceYuan,
    openRegistration: opts.openRegistration ?? true,
    paymentNote: opts.paymentNote,
    paymentQrUrl: opts.paymentQrUrl,
  })
  const db = (app as unknown as { db: DB }).db
  return { app, db }
}

async function register(app: Awaited<ReturnType<typeof buildServer>>, name: string) {
  const r = await app.inject({ method: 'POST', url: '/api/owner/register', payload: { name } })
  return { token: (r.json() as any).ownerToken as string, ownerId: (r.json() as any).ownerId as string }
}

const ownerH = (t: string) => ({ authorization: 'Bearer ' + t })

test('join-info: 公开返回价格/说明/二维码', async () => {
  const { app } = await setup(10, { paymentNote: '扫码支付后核销', paymentQrUrl: 'https://example/qr.png' })
  const r = await app.inject({ method: 'GET', url: '/api/public/join-info' })
  assert.equal(r.statusCode, 200)
  const b = r.json() as any
  assert.equal(b.ok, true)
  assert.equal(b.priceYuan, 10)
  assert.equal(b.paymentNote, '扫码支付后核销')
  assert.equal(b.qrUrl, 'https://example/qr.png')
  await app.close()
})

test('join-fee: priceYuan>0 建鱼 → pending_payment、余额照发、payment{paid:false}', async () => {
  const { app } = await setup(10)
  const a = await register(app, '甲')
  const c = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '付费鱼' } })
  const cb = c.json() as any
  assert.equal(c.statusCode, 200)
  assert.equal(cb.fish.status, 'pending_payment')
  assert.equal(cb.fish.balance, 100)
  assert.deepEqual(cb.fish.payment, { priceYuan: 10, paid: false })

  const me = await app.inject({ method: 'GET', url: '/api/owner/me', headers: ownerH(a.token) })
  assert.deepEqual((me.json() as any).fish[0].payment, { priceYuan: 10, paid: false })

  const detail = await app.inject({ method: 'GET', url: `/api/owner/fish/${cb.fish.id}`, headers: ownerH(a.token) })
  assert.deepEqual((detail.json() as any).fish.payment, { priceYuan: 10, paid: false })

  const list = await app.inject({ method: 'GET', url: '/api/admin/fish', headers: adminH })
  const adminItem = (list.json() as any).fish.find((f: any) => f.id === cb.fish.id)
  assert.equal(adminItem.status, 'pending_payment')
  await app.close()
})

test('join-fee: admin approve 视为已付款 → active + payment 事件；pay_confirm 同义', async () => {
  const { app, db } = await setup(10)
  const a = await register(app, '乙')
  const c1 = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '核销一' } })
  const id1 = (c1.json() as any).fish.id as string
  const c2 = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '核销二' } })
  const id2 = (c2.json() as any).fish.id as string

  const ap = await app.inject({ method: 'POST', url: `/api/admin/fish/${id1}/approve`, headers: adminH })
  assert.equal(ap.statusCode, 200)
  assert.equal((ap.json() as any).fish.status, 'active')

  const pc = await app.inject({ method: 'POST', url: `/api/admin/fish/${id2}/pay_confirm`, headers: adminH })
  assert.equal(pc.statusCode, 200)
  assert.equal((pc.json() as any).fish.status, 'active')

  const ev = db.prepare(`SELECT COUNT(*) AS c FROM event WHERE fish_id = ? AND kind = 'payment'`).get(id1) as { c: number }
  assert.equal(Number(ev.c), 1, 'approve 应记 payment 事件')
  const ev2 = db.prepare(`SELECT COUNT(*) AS c FROM event WHERE fish_id = ? AND kind = 'payment'`).get(id2) as { c: number }
  assert.equal(Number(ev2.c), 1, 'pay_confirm 应记 payment 事件')

  const detail = await app.inject({ method: 'GET', url: `/api/owner/fish/${id1}`, headers: ownerH(a.token) })
  assert.equal((detail.json() as any).fish.status, 'active')
  await app.close()
})

test('join-fee: priceYuan=0 且 OPEN_REGISTRATION=true → 直接 active（不回归）', async () => {
  const { app } = await setup(0, { openRegistration: true })
  const a = await register(app, '丙')
  const c = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '免费鱼' } })
  assert.equal(c.statusCode, 200)
  const b = c.json() as any
  assert.equal(b.fish.status, 'active')
  assert.equal(b.fish.payment, null)
  await app.close()
})

test('join-fee: priceYuan=0 且 OPEN_REGISTRATION=false → pending（保持旧审批流）', async () => {
  const { app } = await setup(0, { openRegistration: false })
  const a = await register(app, '丁')
  const c = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '待审鱼' } })
  assert.equal((c.json() as any).fish.status, 'pending')
  await app.close()
})
