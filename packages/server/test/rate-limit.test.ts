import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createRateLimiter, perIpKey, perResidentKey } from '../src/api/rate-limit.ts'

function makeApp(opts: { windowMs: number; max: number; keyOf?: (req: any) => string; clock: () => number }) {
  const app = Fastify()
  const limiter = createRateLimiter({ windowMs: opts.windowMs, max: opts.max, keyOf: opts.keyOf, now: opts.clock })
  app.get('/x', { preHandler: limiter }, async () => ({ ok: true }))
  return app
}

// 1. 窗口内超限 429，结构正确
test('rate-limit：窗口内超过 max 次返回 429 RATE_LIMITED + retry_after', async () => {
  let now = 1000
  const app = makeApp({ windowMs: 1000, max: 3, clock: () => now })

  for (let i = 0; i < 3; i++) {
    const r = await app.inject({ method: 'GET', url: '/x' })
    assert.equal(r.statusCode, 200, `第 ${i + 1} 次应放行`)
  }
  const over = await app.inject({ method: 'GET', url: '/x' })
  assert.equal(over.statusCode, 429)
  const body = over.json() as any
  assert.equal(body.error, 'RATE_LIMITED')
  assert.equal(body.code, 'RATE_LIMITED')
  assert.equal(typeof body.retry_after, 'number')
  assert.ok(body.retry_after >= 0)
  assert.equal(over.headers['retry-after'], String(body.retry_after))
  await app.close()
})

// 2. 窗口过后恢复
test('rate-limit：窗口过后计数重置，重新放行', async () => {
  let now = 1000
  const app = makeApp({ windowMs: 1000, max: 2, clock: () => now })
  assert.equal((await app.inject({ method: 'GET', url: '/x' })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/x' })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/x' })).statusCode, 429)

  now = 2000 // 窗口边界过去
  assert.equal((await app.inject({ method: 'GET', url: '/x' })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/x' })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/x' })).statusCode, 429)
  await app.close()
})

// 3. 不同 key 互不影响
test('rate-limit：不同 key 独立计数', async () => {
  const now = 1000
  const keyOf = (req: any) => String(req.headers['x-key'] ?? 'none')
  const app = makeApp({ windowMs: 1000, max: 2, keyOf, clock: () => now })

  const hit = (key: string) => app.inject({ method: 'GET', url: '/x', headers: { 'x-key': key } })
  assert.equal((await hit('a')).statusCode, 200)
  assert.equal((await hit('a')).statusCode, 200)
  assert.equal((await hit('a')).statusCode, 429) // a 超限
  assert.equal((await hit('b')).statusCode, 200) // b 不受影响
  assert.equal((await hit('b')).statusCode, 200)
  assert.equal((await hit('b')).statusCode, 429)
  await app.close()
})

// 4. max=0 一律拒绝
test('rate-limit：max=0 时全部 429', async () => {
  const app = makeApp({ windowMs: 1000, max: 0, clock: () => 1000 })
  const r = await app.inject({ method: 'GET', url: '/x' })
  assert.equal(r.statusCode, 429)
  await app.close()
})

// 5. keyOf 便捷函数
test('perIpKey / perResidentKey：按 IP 与按接入码取 key', () => {
  assert.equal(perIpKey({ ip: '1.2.3.4' } as any), 'ip:1.2.3.4')
  assert.equal(perIpKey({} as any), 'ip:unknown')

  assert.equal(perResidentKey({ ip: '1.2.3.4', headers: { authorization: 'Bearer fbr_abc' } } as any), 'resident:fbr_abc')
  // 无 Bearer → 回落 IP
  assert.equal(perResidentKey({ ip: '1.2.3.4', headers: {} } as any), 'ip:1.2.3.4')
})

// 6. 参数校验
test('createRateLimiter：非法参数抛错', () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 1 }), /windowMs/)
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: -1 }), /max/)
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 1.5 as number }), /max/)
})
