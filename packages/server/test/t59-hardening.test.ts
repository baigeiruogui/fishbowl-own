import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'

const ADMIN = 't59-admin'
const adminH = { 'x-admin-token': ADMIN }

async function setup(opts: Parameters<typeof buildServer>[0] = {}) {
  return buildServer({ dbPath: ':memory:', adminToken: ADMIN, openRegistration: true, ...opts })
}

async function register(app: Awaited<ReturnType<typeof buildServer>>, name: string, xff?: string) {
  const headers: Record<string, string> = {}
  if (xff) headers['x-forwarded-for'] = xff
  const r = await app.inject({ method: 'POST', url: '/api/owner/register', headers, payload: { name } })
  return { status: r.statusCode, body: r.json() as any }
}

const ownerH = (t: string) => ({ authorization: 'Bearer ' + t })

// M2：trustProxy + XFF 让不同真实 IP 各算各的桶
test('M2: trustProxy 下注册限流按 x-forwarded-for 的真实 IP 分桶', async () => {
  const app = await setup({ trustProxy: true })
  const s1: number[] = []
  for (let i = 0; i < 6; i++) s1.push((await register(app, 'a' + i, '1.1.1.1')).status)
  assert.deepEqual(s1.slice(0, 5), [200, 200, 200, 200, 200])
  assert.equal(s1[5], 429, '同一真实 IP 第 6 次应被限流')

  // 另一个真实 IP 不受影响（若按 socket IP 会共用全局桶而误伤）
  const other = await register(app, 'b', '2.2.2.2')
  assert.equal(other.status, 200)
  await app.close()
})

// M2 反例：不信任时 XFF 被忽略（同 socket IP 共用一个桶）
test('M2: 未开启 trustProxy 时 x-forwarded-for 被忽略（同桶）', async () => {
  const app = await setup({ trustProxy: false })
  const s: number[] = []
  for (let i = 0; i < 6; i++) s.push((await register(app, 'c' + i, `9.9.9.${i}`)).status)
  assert.equal(s[5], 429)
  await app.close()
})

// M3：ownerToken 轮换 → 旧 401 新可用
test('M3: /api/owner/token/rotate 轮换后旧 token 401、新 token 可用', async () => {
  const app = await setup()
  const a = await register(app, '甲')
  const old = a.body.ownerToken as string
  assert.equal((await app.inject({ method: 'GET', url: '/api/owner/me', headers: ownerH(old) })).statusCode, 200)

  const rot = await app.inject({ method: 'POST', url: '/api/owner/token/rotate', headers: ownerH(old) })
  const nb = rot.json() as any
  assert.equal(rot.statusCode, 200)
  const fresh = nb.ownerToken as string
  assert.ok(fresh.startsWith('own_'))
  assert.notEqual(fresh, old)

  assert.equal((await app.inject({ method: 'GET', url: '/api/owner/me', headers: ownerH(old) })).statusCode, 401, '旧 token 失效')
  assert.equal((await app.inject({ method: 'GET', url: '/api/owner/me', headers: ownerH(fresh) })).statusCode, 200, '新 token 可用')
  await app.close()
})

// M3：撤销 → 401
test('M3: /api/owner/token/revoke 后 token 立即 401', async () => {
  const app = await setup()
  const a = await register(app, '乙')
  const token = a.body.ownerToken as string
  const rev = await app.inject({ method: 'POST', url: '/api/owner/token/revoke', headers: ownerH(token) })
  assert.equal(rev.statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/owner/me', headers: ownerH(token) })).statusCode, 401)
  // 撤销后再轮换也 401（无有效凭证）
  assert.equal((await app.inject({ method: 'POST', url: '/api/owner/token/rotate', headers: ownerH(token) })).statusCode, 401)
  await app.close()
})

// Low：/api/admin/* 限流
test('Low: /api/admin/* 超阈值返回 429', async () => {
  const app = await setup({ rateLimit: { adminMax: 2, windowMs: 60_000 } })
  const r1 = await app.inject({ method: 'GET', url: '/api/admin/fish', headers: adminH })
  const r2 = await app.inject({ method: 'GET', url: '/api/admin/fish', headers: adminH })
  const r3 = await app.inject({ method: 'GET', url: '/api/admin/fish', headers: adminH })
  assert.equal(r1.statusCode, 200)
  assert.equal(r2.statusCode, 200)
  assert.equal(r3.statusCode, 429)
  assert.equal((r3.json() as any).error, 'RATE_LIMITED')
  await app.close()
})

// Low：owner 建鱼 persona ≤500
test('Low: owner 建鱼 persona 长度 ≤500（501 → 400，500 → 200）', async () => {
  const app = await setup()
  const a = await register(app, '丙')
  const token = a.body.ownerToken as string
  const tooLong = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(token), payload: { name: '长人设', persona: 'x'.repeat(501) } })
  assert.equal(tooLong.statusCode, 400)
  const ok = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(token), payload: { name: '正常人设', persona: 'x'.repeat(500) } })
  assert.equal(ok.statusCode, 200)
  await app.close()
})

// Low：admin approve 不得把 banned 直接置 active（需先 unban）
test('Low: admin approve 对 banned 鱼返回 409，需先 unban', async () => {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN, openRegistration: false })
  const a = await register(app, '丁')
  const token = a.body.ownerToken as string
  const c = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: ownerH(token), payload: { name: '待审鱼' } })
  const id = (c.json() as any).fish.id as string

  await app.inject({ method: 'POST', url: `/api/admin/fish/${id}/ban`, headers: adminH })
  const appr = await app.inject({ method: 'POST', url: `/api/admin/fish/${id}/approve`, headers: adminH })
  assert.equal(appr.statusCode, 409)
  assert.equal((appr.json() as any).error, 'CONFLICT')

  await app.inject({ method: 'POST', url: `/api/admin/fish/${id}/unban`, headers: adminH })
  const appr2 = await app.inject({ method: 'POST', url: `/api/admin/fish/${id}/approve`, headers: adminH })
  assert.equal(appr2.statusCode, 200)
  assert.equal((appr2.json() as any).fish.status, 'active')
  await app.close()
})
