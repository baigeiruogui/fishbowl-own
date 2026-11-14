import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import { hashCode } from '../src/api/auth.ts'
import type { DB } from '../src/db/index.ts'

const ADMIN = 't48-admin'

async function setup(opts: { openRegistration?: boolean; joinPriceYuan?: number } = {}) {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN, openRegistration: opts.openRegistration ?? true, joinPriceYuan: opts.joinPriceYuan ?? 0 })
  const db = (app as unknown as { db: DB }).db
  return { app, db }
}

const adminH = { 'x-admin-token': ADMIN }

async function register(app: Awaited<ReturnType<typeof buildServer>>, name: string) {
  const r = await app.inject({ method: 'POST', url: '/api/owner/register', payload: { name } })
  const b = r.json() as any
  return { status: r.statusCode, ownerId: b.ownerId as string, token: b.ownerToken as string, body: b }
}

const ownerH = (token: string) => ({ authorization: 'Bearer ' + token })

// 1) 注册 + token 只存哈希
test('owner: 注册返回 ownerId/ownerToken（明文只回一次），库里只存 sha256', async () => {
  const { app, db } = await setup()
  const a = await register(app, '甲主人')
  assert.equal(a.status, 200)
  assert.ok(a.ownerId.startsWith('owner_'))
  assert.ok(a.token.startsWith('own_'))

  const row = db.prepare('SELECT token_hash FROM owner_credential WHERE owner_id = ?').get(a.ownerId) as { token_hash: string }
  assert.ok(row, 'owner_credential 应有一行')
  assert.notEqual(row.token_hash, a.token, '不能明文存 token')
  assert.equal(row.token_hash, hashCode(a.token), '存的是 sha256(token)')

  const owner = db.prepare('SELECT name FROM owner WHERE id = ?').get(a.ownerId) as { name: string }
  assert.equal(owner.name, '甲主人')
  await app.close()
})

// 2) 两 owner 各建鱼拿码，互不可见
test('owner: 两个主人各建鱼，各自只能管自己的鱼（隔离）', async () => {
  const { app } = await setup({ openRegistration: true })
  const a = await register(app, '甲')
  const b = await register(app, '乙')

  const ca = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '甲鱼' } })
  const cb = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(b.token), payload: { name: '乙鱼' } })
  const fa = (ca.json() as any).fish
  const fb = (cb.json() as any).fish
  assert.equal(fa.ownerId, a.ownerId)
  assert.equal(fb.ownerId, b.ownerId)
  assert.equal(fa.status, 'active')
  assert.ok((ca.json() as any).code.startsWith('fbr_'))

  // B 看 A 的鱼 → 404；A 看 B 的鱼 → 404
  assert.equal((await app.inject({ method: 'GET', url: `/api/owner/fish/${fa.id}`, headers: ownerH(b.token) })).statusCode, 404)
  assert.equal((await app.inject({ method: 'GET', url: `/api/owner/fish/${fb.id}`, headers: ownerH(a.token) })).statusCode, 404)
  // 各自看自己 → 200
  assert.equal((await app.inject({ method: 'GET', url: `/api/owner/fish/${fa.id}`, headers: ownerH(a.token) })).statusCode, 200)
  await app.close()
})

// 3) 每人最多 3 条鱼
test('owner: 每人 3 条上限，第 4 条 409', async () => {
  const { app } = await setup({ openRegistration: true })
  const a = await register(app, '丙')
  for (const n of ['鱼一', '鱼二', '鱼三']) {
    const r = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: n } })
    assert.equal(r.statusCode, 200, n)
  }
  const r4 = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '鱼四' } })
  assert.equal(r4.statusCode, 409)
  assert.equal((r4.json() as any).error, 'CONFLICT')
  await app.close()
})

// 4) pending → approve → active
test('owner: OPEN_REGISTRATION=false 新鱼 pending，管理员 approve 后 active', async () => {
  const { app } = await setup({ openRegistration: false })
  const a = await register(app, '丁')
  const c = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '待审鱼' } })
  const fish = (c.json() as any).fish
  assert.equal(fish.status, 'pending')

  const list = await app.inject({ method: 'GET', url: '/api/admin/fish', headers: adminH })
  assert.ok((list.json() as any).fish.some((f: any) => f.id === fish.id && f.status === 'pending'))

  const appr = await app.inject({ method: 'POST', url: `/api/admin/fish/${fish.id}/approve`, headers: adminH })
  assert.equal((appr.json() as any).fish.status, 'active')
  const detail = await app.inject({ method: 'GET', url: `/api/owner/fish/${fish.id}`, headers: ownerH(a.token) })
  assert.equal((detail.json() as any).fish.status, 'active')
  await app.close()
})

// 5) 注册限流（5/小时）
test('owner: 注册按 IP 限流，第 6 次 429', async () => {
  const { app } = await setup()
  const statuses: number[] = []
  for (let i = 0; i < 6; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/owner/register', payload: { name: 'o' + i } })
    statuses.push(r.statusCode)
  }
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200])
  assert.equal(statuses[5], 429)
  await app.close()
})

// 6) 兼容旧 ADMIN_TOKEN 建鱼 + admin 封禁/解封
test('owner: ADMIN_TOKEN 兼容建鱼（active, 无 owner）；admin ban/unban', async () => {
  const { app } = await setup({ openRegistration: false })
  const r = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: adminH, payload: { name: '管理鱼' } })
  const fish = (r.json() as any).fish
  assert.equal(r.statusCode, 200)
  assert.equal(fish.status, 'active')
  assert.equal(fish.ownerId, null)

  const ban = await app.inject({ method: 'POST', url: `/api/admin/fish/${fish.id}/ban`, headers: adminH })
  assert.equal((ban.json() as any).fish.status, 'banned')
  const unban = await app.inject({ method: 'POST', url: `/api/admin/fish/${fish.id}/unban`, headers: adminH })
  assert.equal((unban.json() as any).fish.status, 'active')
  await app.close()
})

// 7) 公网护栏：鱼名过长 / 违规被拒
test('owner: 鱼名 ≤12、过 checkLine（过长/违规 400）', async () => {
  const { app } = await setup({ openRegistration: true })
  const a = await register(app, '戊')
  const long = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '一二三四五六七八九十甲乙丙' } })
  assert.equal(long.statusCode, 400)
  const bad = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '傻逼鱼' } })
  assert.equal(bad.statusCode, 400)
  await app.close()
})

// 8) GET /api/owner/me：只列本人鱼 + hasCode + 别名 /fish
test('owner: GET /me 只列本人鱼，含 owner 与 hasCode；别名 /fish 同返回', async () => {
  const { app } = await setup({ openRegistration: true })
  const a = await register(app, '己')
  const b = await register(app, '庚')
  const fa = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(a.token), payload: { name: '己鱼' } })
  await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(b.token), payload: { name: '庚鱼' } })
  const faId = (fa.json() as any).fish.id

  const me = await app.inject({ method: 'GET', url: '/api/owner/me', headers: ownerH(a.token) })
  const mb = me.json() as any
  assert.equal(me.statusCode, 200)
  assert.equal(mb.ok, true)
  assert.equal(mb.owner.id, a.ownerId)
  assert.equal(mb.owner.name, '己')
  assert.equal(mb.fish.length, 1, '只应看到自己的 1 条鱼')
  assert.equal(mb.fish[0].id, faId)
  assert.equal(mb.fish[0].hasCode, true)
  assert.equal(mb.fish[0].name, '己鱼')
  assert.equal(typeof mb.fish[0].balance, 'number')

  // 不越权：B 的列表里没有 A 的鱼
  const meB = (await app.inject({ method: 'GET', url: '/api/owner/me', headers: ownerH(b.token) })).json() as any
  assert.ok(!meB.fish.some((f: any) => f.id === faId))
  assert.equal(meB.fish.length, 1)

  // 别名 /fish 同返回
  const alias = await app.inject({ method: 'GET', url: '/api/owner/fish', headers: ownerH(a.token) })
  assert.deepEqual(alias.json(), mb)
  await app.close()
})

// 9) /me 无/错 token → 401
test('owner: /me 无 token 或错 token → 401', async () => {
  const { app } = await setup()
  assert.equal((await app.inject({ method: 'GET', url: '/api/owner/me' })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/owner/me', headers: { authorization: 'Bearer own_deadbeef' } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/owner/fish', headers: { authorization: 'Bearer nope' } })).statusCode, 401)
  await app.close()
})
