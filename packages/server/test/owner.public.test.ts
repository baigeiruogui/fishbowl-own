import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/index.ts'
import { seedTown } from '../src/seed.ts'
import type { DB } from '../src/db/index.ts'

const ADMIN = 'test-admin-token'

async function setup(opts: Parameters<typeof buildServer>[0] = {}) {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN, ...opts })
  const db = (app as unknown as { db: DB }).db
  return { app, db }
}

const adminHeaders = { 'x-admin-token': ADMIN }

test('owner: 缺/错 admin token → 401', async () => {
  const { app } = await setup()
  const no = await app.inject({ method: 'POST', url: '/api/owner/fish', payload: { name: 'x' } })
  assert.equal(no.statusCode, 401)
  assert.equal(no.json().error, 'UNAUTHORIZED')
  const bad = await app.inject({ method: 'POST', url: '/api/owner/fish', headers: { authorization: 'Bearer nope' }, payload: { name: 'x' } })
  assert.equal(bad.statusCode, 401)
  await app.close()
})

test('owner: 建鱼返回明文 fbr_ 码，且能用该码访问 resident status', async () => {
  const { app } = await setup()
  const res = await app.inject({
    method: 'POST',
    url: '/api/owner/fish',
    headers: adminHeaders,
    payload: { name: '小银', kind: 'resident', persona: '爱钓鱼', intro: 'hi', balance: 120 },
  })
  assert.equal(res.statusCode, 200)
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.ok(b.code.startsWith('fbr_'), '应返回 fbr_ 明文接入码')
  assert.equal(b.fish.name, '小银')
  assert.equal(b.fish.balance, 120)
  assert.equal(b.fish.kind, 'resident')

  // 库里只存哈希：detail 不含 code / code_hash
  const detail = await app.inject({ method: 'GET', url: `/api/owner/fish/${b.fish.id}`, headers: adminHeaders })
  const db2 = detail.json() as any
  assert.equal(db2.hasCode, true)
  assert.equal(JSON.stringify(db2).includes('fbr_'), false)

  // 用明文码访问 resident status
  const st = await app.inject({
    method: 'GET',
    url: '/town/api/resident/status',
    headers: { authorization: 'Bearer ' + b.code },
  })
  assert.equal(st.statusCode, 200)
  const stb = st.json() as any
  assert.equal(stb.fish_id, b.fish.id)
  assert.equal(stb.balance, 120)
  await app.close()
})

test('owner: rotate 换码后旧码失效、新码可用', async () => {
  const { app } = await setup()
  const created = (await app.inject({ method: 'POST', url: '/api/owner/fish', headers: adminHeaders, payload: { name: '换码鱼' } })).json() as any
  const old = created.code

  const rot = await app.inject({ method: 'POST', url: `/api/owner/fish/${created.fish.id}/code/rotate`, headers: adminHeaders })
  assert.equal(rot.statusCode, 200)
  const rb = rot.json() as any
  assert.ok(rb.code.startsWith('fbr_'))
  assert.notEqual(rb.code, old)

  const oldSt = await app.inject({ method: 'GET', url: '/town/api/resident/status', headers: { authorization: 'Bearer ' + old } })
  assert.equal(oldSt.statusCode, 401)
  const newSt = await app.inject({ method: 'GET', url: '/town/api/resident/status', headers: { authorization: 'Bearer ' + rb.code } })
  assert.equal(newSt.statusCode, 200)
  await app.close()
})

test('owner: pause / resume 切换状态并在详情可见', async () => {
  const { app } = await setup()
  const created = (await app.inject({ method: 'POST', url: '/api/owner/fish', headers: adminHeaders, payload: { name: '暂停鱼' } })).json() as any
  const id = created.fish.id

  const pause = await app.inject({ method: 'POST', url: `/api/owner/fish/${id}/pause`, headers: adminHeaders })
  assert.equal((pause.json() as any).fish.status, 'paused')

  const detail = await app.inject({ method: 'GET', url: `/api/owner/fish/${id}`, headers: adminHeaders })
  assert.equal((detail.json() as any).fish.status, 'paused')

  const resume = await app.inject({ method: 'POST', url: `/api/owner/fish/${id}/resume`, headers: adminHeaders })
  assert.equal((resume.json() as any).fish.status, 'active')
  await app.close()
})

test('public: town / fish / fish:id 结构正确（含种子数据）', async () => {
  const { app } = await setup()
  const created = (await app.inject({ method: 'POST', url: '/api/owner/fish', headers: adminHeaders, payload: { name: '公开鱼', balance: 60 } })).json() as any

  const town = await app.inject({ method: 'GET', url: '/api/public/town' })
  assert.equal(town.statusCode, 200)
  const tb = town.json() as any
  assert.equal(tb.ok, true)
  assert.equal(tb.name, '鱼缸小镇')
  assert.ok(tb.fishCount >= 7, '6 个 NPC + 1 条新鱼')
  assert.equal(typeof tb.today.earned, 'number')
  assert.equal(typeof tb.today.spent, 'number')
  assert.ok(Array.isArray(tb.recent))

  const list = await app.inject({ method: 'GET', url: '/api/public/fish' })
  assert.equal(list.statusCode, 200)
  const lb = list.json() as any
  assert.ok(Array.isArray(lb.fish))
  assert.ok(lb.fish.some((f: any) => f.id === created.fish.id && f.balance === 60))

  const one = await app.inject({ method: 'GET', url: `/api/public/fish/${created.fish.id}` })
  assert.equal(one.statusCode, 200)
  const ob = one.json() as any
  assert.equal(ob.fish.name, '公开鱼')
  assert.ok(Array.isArray(ob.ledger))
  assert.ok(ob.summary.some((s: any) => s.reason === 'init' && s.total === 60))

  const missing = await app.inject({ method: 'GET', url: '/api/public/fish/f_nope' })
  assert.equal(missing.statusCode, 404)
  await app.close()
})

test('seed: 幂等——重复调用不重复写入', async () => {
  const { app, db } = await setup()
  const cnt = (sql: string) => Number((db.prepare(sql).get() as { c: number }).c)
  const before = {
    jobs: cnt('SELECT COUNT(*) AS c FROM job_offer'),
    npcs: cnt(`SELECT COUNT(*) AS c FROM fish WHERE kind = 'npc'`),
    shops: cnt('SELECT COUNT(*) AS c FROM shop'),
    bounties: cnt('SELECT COUNT(*) AS c FROM bounty'),
  }
  assert.equal(before.jobs, 10, '默认招工 10 个')
  assert.equal(before.npcs, 6)
  assert.equal(before.shops, 2)
  assert.equal(before.bounties, 4)

  const second = seedTown(db)
  assert.equal(second.jobs, 0)
  assert.equal(second.npcs, 0)
  assert.equal(second.shops, 0)
  assert.equal(second.bounties, 0)

  const after = {
    jobs: cnt('SELECT COUNT(*) AS c FROM job_offer'),
    npcs: cnt(`SELECT COUNT(*) AS c FROM fish WHERE kind = 'npc'`),
    shops: cnt('SELECT COUNT(*) AS c FROM shop'),
    bounties: cnt('SELECT COUNT(*) AS c FROM bounty'),
  }
  assert.deepEqual(after, before)
  await app.close()
})

test('static: dist 存在时同源托管 index.html / 静态资源，SPA 回退，API 404 不受影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-static-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="app">鱼缸小镇</div>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("fishbowl")')

  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN, staticDir: dir })
  try {
    const root = await app.inject({ method: 'GET', url: '/' })
    assert.equal(root.statusCode, 200)
    assert.ok(String(root.headers['content-type']).includes('text/html'))
    assert.ok(root.payload.includes('鱼缸小镇'))

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' })
    assert.equal(asset.statusCode, 200)
    assert.ok(String(asset.headers['content-type']).includes('javascript'))
    assert.ok(asset.payload.includes('fishbowl'))

    // SPA 回退到 index.html
    const spa = await app.inject({ method: 'GET', url: '/dashboard/room' })
    assert.equal(spa.statusCode, 200)
    assert.ok(spa.payload.includes('鱼缸小镇'))

    // API 404 仍是 JSON
    const api404 = await app.inject({ method: 'GET', url: '/api/nope' })
    assert.equal(api404.statusCode, 404)
    assert.equal(api404.json().error, 'NOT_FOUND')
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
