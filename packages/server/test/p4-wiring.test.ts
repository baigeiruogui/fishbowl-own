import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import { createFish } from '../src/db/index.ts'
import type { DB } from '../src/db/index.ts'
import { issueResidentCode } from '../src/api/auth.ts'

// 健康检查：db 可读 / driver 就绪
test('P4 接线：/healthz 带 dbReadable / driverReady / db 字段', async () => {
  const app = await buildServer({ dbPath: ':memory:', adminToken: 'x' })
  const res = await app.inject({ method: 'GET', url: '/healthz' })
  assert.equal(res.statusCode, 200)
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.equal(b.service, 'fishbowl-own')
  assert.equal(b.dbReadable, true)
  assert.equal(b.db, 'ok')
  assert.equal(b.driverReady, true)
  await app.close()
})

// ADMIN_TOKEN 为空：只告警，owner 写被拒；public 仍可用
test('P4 接线：ADMIN_TOKEN 为空 → owner 写被拒，public 可用', async () => {
  const app = await buildServer({ dbPath: ':memory:', adminToken: '' })
  const owner = await app.inject({ method: 'POST', url: '/api/owner/fish', payload: { name: 'x' } })
  assert.equal(owner.statusCode, 401)
  const pub = await app.inject({ method: 'GET', url: '/api/public/ping' })
  assert.equal(pub.statusCode, 200)
  await app.close()
})

// 限流：resident 阈值打满后 429 + retry-after
test('P4 接线：resident 限流超阈值返回 429 RATE_LIMITED', async () => {
  const app = await buildServer({ dbPath: ':memory:', adminToken: 'x', rateLimit: { residentMax: 2, windowMs: 60_000 } })
  const db = (app as unknown as { db: DB }).db
  const fish = createFish(db, { name: '限流鱼', balance: 100 })
  const { code } = issueResidentCode(db, fish.id)
  const headers = { authorization: 'Bearer ' + code }

  const r1 = await app.inject({ method: 'GET', url: '/town/api/resident/status', headers })
  const r2 = await app.inject({ method: 'GET', url: '/town/api/resident/status', headers })
  const r3 = await app.inject({ method: 'GET', url: '/town/api/resident/status', headers })
  assert.equal(r1.statusCode, 200)
  assert.equal(r2.statusCode, 200)
  assert.equal(r3.statusCode, 429)
  assert.equal((r3.json() as any).error, 'RATE_LIMITED')
  assert.equal(typeof (r3.json() as any).retry_after, 'number')
  await app.close()
})
