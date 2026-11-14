import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import { createFish } from '../src/db/index.ts'
import type { DB } from '../src/db/index.ts'

const ADMIN = 'av-admin'

async function setup() {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN, openRegistration: true })
  const db = (app as unknown as { db: DB }).db
  return { app, db }
}

const AV = (id: string) => `/api/public/fish/${id}/avatar.svg`

test('avatar: SVG 200 + 同 id 确定 + 不同 id 不同 + 名字转义', async () => {
  const { app, db } = await setup()
  const f1 = createFish(db, { name: '<珊瑚>' })
  const f2 = createFish(db, { name: '普通鱼' })

  const r1 = await app.inject({ method: 'GET', url: AV(f1.id) })
  assert.equal(r1.statusCode, 200)
  assert.ok(String(r1.headers['content-type']).includes('image/svg+xml'))
  assert.ok(r1.payload.includes('<svg'))

  // 确定性：同 id 两次完全一致
  const r1b = await app.inject({ method: 'GET', url: AV(f1.id) })
  assert.equal(r1.payload, r1b.payload)

  // 不同 id → 不同
  const r2 = await app.inject({ method: 'GET', url: AV(f2.id) })
  assert.notEqual(r2.payload, r1.payload)

  // 名字首字 '<' 被转义，不出现原样 '<珊瑚>'
  assert.ok(!r1.payload.includes('<珊瑚>'), '原始名字不应原样出现')
  assert.ok(r1.payload.includes('&lt;'), '首字 < 应转义成 &lt;')
  await app.close()
})

test('avatar: 安全/缓存头（Cache-Control / X-Content-Type-Options / CSP）', async () => {
  const { app, db } = await setup()
  const f = createFish(db, { name: '头鱼' })
  const r = await app.inject({ method: 'GET', url: AV(f.id) })
  assert.equal(r.statusCode, 200)
  assert.match(String(r.headers['cache-control']), /max-age=\d+/)
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.ok(String(r.headers['content-security-policy']).includes("default-src 'none'"))
  await app.close()
})

test('avatar: public 列表/详情、town recent、owner /me 都带 avatar 字段', async () => {
  const { app, db } = await setup()
  const f = createFish(db, { name: '珊瑚鱼', balance: 50 })

  const list = await app.inject({ method: 'GET', url: '/api/public/fish' })
  const item = (list.json() as any).items.find((x: any) => x.id === f.id)
  assert.equal(item.avatar, AV(f.id))

  const detail = await app.inject({ method: 'GET', url: `/api/public/fish/${f.id}` })
  assert.equal((detail.json() as any).fish.avatar, AV(f.id))

  // town recent（createFish 写了 init 账本，会出现在 recent）
  const town = await app.inject({ method: 'GET', url: '/api/public/town' })
  const rec = (town.json() as any).recent.find((x: any) => x.fishId === f.id)
  assert.ok(rec, '应有该鱼的 recent 条目')
  assert.equal(rec.avatar, AV(f.id))
  assert.equal(rec.fish.avatar, AV(f.id))

  // owner /me
  const reg = await app.inject({ method: 'POST', url: '/api/owner/register', payload: { name: '头像主人' } })
  const token = (reg.json() as any).ownerToken as string
  const created = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: { authorization: 'Bearer ' + token }, payload: { name: '我的鱼' } })
  const myFishId = (created.json() as any).fish.id as string
  const me = await app.inject({ method: 'GET', url: '/api/owner/me', headers: { authorization: 'Bearer ' + token } })
  const mine = (me.json() as any).fish.find((x: any) => x.id === myFishId)
  assert.equal(mine.avatar, AV(myFishId))
  await app.close()
})
