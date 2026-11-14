import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKED_TEXT } from '@fishbowl/shared'
import { buildServer } from '../src/index.ts'
import { openDb, createFish, getFish } from '../src/db/index.ts'
import { addCatch, listCatch, sellAllCatch } from '../src/domain/fishing.ts'
import { spend } from '../src/domain/account.ts'
import type { DB } from '../src/db/index.ts'

const ADMIN = 't22-admin'
const RES = '/town/api/resident'

async function appSetup(fishing?: { cooldownMs?: number; dailyLimit?: number; baitCost?: number }) {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN, fishing })
  const db = (app as unknown as { db: DB }).db
  return { app, db }
}

async function newResident(app: Awaited<ReturnType<typeof buildServer>>, name: string, balance = 100) {
  const created = (
    await app.inject({ method: 'POST', url: '/api/owner/fish', headers: { 'x-admin-token': ADMIN }, payload: { name, balance } })
  ).json() as any
  return { id: created.fish.id, code: created.code, headers: { authorization: 'Bearer ' + created.code } }
}

// ================= F1：钓鱼冷却 / 每日上限 =================
test('F1 钓鱼冷却：连续快速 goto fish 只有第一次成功，第二次被冷却拒绝', async () => {
  const { app } = await appSetup({ cooldownMs: 60_000, dailyLimit: 10 })
  const fish = await newResident(app, '钓A', 100)

  const r1 = await app.inject({ method: 'POST', url: `${RES}/goto`, headers: fish.headers, payload: { place: 'pier', do: 'fish' } })
  assert.equal(r1.statusCode, 200)
  assert.equal((r1.json() as any).ok, true)
  assert.equal((r1.json() as any).outcome.item, '小鱼')

  const r2 = await app.inject({ method: 'POST', url: `${RES}/goto`, headers: fish.headers, payload: { place: 'pier', do: 'fish' } })
  assert.equal(r2.statusCode, 200)
  assert.equal((r2.json() as any).ok, false)
  assert.equal((r2.json() as any).code, 'FISH_COOLDOWN')

  // 只产出了 1 条
  const market = await app.inject({ method: 'GET', url: `${RES}/market`, headers: fish.headers })
  const catches = (market.json() as any).catch as any[]
  assert.equal(catches.reduce((n, c) => n + Number(c.qty), 0), 1)
  await app.close()
})

test('F1 每日上限：当天达到上限后拒绝（cooldown=0 便于快速验证）', async () => {
  const { app } = await appSetup({ cooldownMs: 0, dailyLimit: 2 })
  const fish = await newResident(app, '钓B', 100)

  const go = () => app.inject({ method: 'POST', url: `${RES}/goto`, headers: fish.headers, payload: { place: 'pier', do: 'fish' } })
  assert.equal((await go()).json().ok, true)
  assert.equal((await go()).json().ok, true)
  const third = await go()
  assert.equal((third.json() as any).ok, false)
  assert.equal((third.json() as any).code, 'FISH_LIMIT')

  const market = await app.inject({ method: 'GET', url: `${RES}/market`, headers: fish.headers })
  const total = ((market.json() as any).catch as any[]).reduce((n, c) => n + Number(c.qty), 0)
  assert.equal(total, 2, '当天最多产出 2 条')
  await app.close()
})

// ================= F2：settings 返回 settings 对象 + 持久化社交预算 =================
test('F2 settings：接受并持久化 social_day_cents，响应带 settings 对象', async () => {
  const { app } = await appSetup()
  const fish = await newResident(app, '预算鱼', 100)

  const r = await app.inject({
    method: 'POST',
    url: `${RES}/settings`,
    headers: fish.headers,
    payload: { social_day_cents: 800, wake_min_minutes: 45, quiet_hours: '22-7' },
  })
  assert.equal(r.statusCode, 200)
  const b = r.json() as any
  assert.equal(b.ok, true)
  assert.equal(b.settings.social_day_cents, 800)
  assert.equal(b.settings.social_day_cents_effective, 800)
  assert.equal(b.settings.wake_min_minutes, 45)

  // 改成 null（回到默认）
  const r2 = await app.inject({ method: 'POST', url: `${RES}/settings`, headers: fish.headers, payload: { social_day_cents: null } })
  assert.equal((r2.json() as any).settings.social_day_cents, null)
  await app.close()
})

// ================= F3：敏感字段仅主人可改 + paused/banned 写拒绝 =================
test('F3 resident 改 paused/day_cap 被拒；owner 可改 day_cap；paused 后写操作回 PAUSED', async () => {
  const { app } = await appSetup()
  const fish = await newResident(app, '权限鱼', 100)

  const badPaused = await app.inject({ method: 'POST', url: `${RES}/settings`, headers: fish.headers, payload: { paused: true } })
  assert.equal(badPaused.statusCode, 403)
  assert.equal((badPaused.json() as any).error, 'FIELD_FORBIDDEN')

  const badCap = await app.inject({ method: 'POST', url: `${RES}/settings`, headers: fish.headers, payload: { day_cap: 50 } })
  assert.equal(badCap.statusCode, 403)

  const st0 = await app.inject({ method: 'GET', url: `${RES}/status`, headers: fish.headers })
  assert.equal((st0.json() as any).paused, false)
  assert.equal((st0.json() as any).day_cap, null)

  // 主人（admin）可改 day_cap
  const ownerCap = await app.inject({ method: 'POST', url: `/api/owner/fish/${fish.id}/day_cap`, headers: { 'x-admin-token': ADMIN }, payload: { day_cap: 50 } })
  assert.equal(ownerCap.statusCode, 200)
  const st1 = await app.inject({ method: 'GET', url: `${RES}/status`, headers: fish.headers })
  assert.equal((st1.json() as any).day_cap, 50)

  // 主人暂停 → resident 写操作被拒（PAUSED），但读 status 仍可
  await app.inject({ method: 'POST', url: `/api/owner/fish/${fish.id}/pause`, headers: { 'x-admin-token': ADMIN } })
  const write = await app.inject({ method: 'POST', url: `${RES}/goto`, headers: fish.headers, payload: { place: 'pier' } })
  assert.equal(write.statusCode, 409)
  assert.equal((write.json() as any).code, 'PAUSED')
  const readStatus = await app.inject({ method: 'GET', url: `${RES}/status`, headers: fish.headers })
  assert.equal(readStatus.statusCode, 200)
  assert.equal((readStatus.json() as any).paused, true)

  // 主人恢复后又能写
  await app.inject({ method: 'POST', url: `/api/owner/fish/${fish.id}/resume`, headers: { 'x-admin-token': ADMIN } })
  const write2 = await app.inject({ method: 'POST', url: `${RES}/goto`, headers: fish.headers, payload: { place: 'pier' } })
  assert.equal((write2.json() as any).ok, true)
  await app.close()
})

test('F3 banned 的鱼写操作回 BANNED', async () => {
  const { app, db } = await appSetup()
  const fish = await newResident(app, '封禁鱼', 100)
  db.prepare(`UPDATE fish SET status = 'banned' WHERE id = ?`).run(fish.id)
  const write = await app.inject({ method: 'POST', url: `${RES}/goto`, headers: fish.headers, payload: { place: 'pier' } })
  assert.equal(write.statusCode, 403)
  assert.equal((write.json() as any).code, 'BANNED')
  await app.close()
})

// ================= F4：spend 可嵌套 + sellAllCatch 整体原子 =================
test('F4 spend 可嵌套：外层 BEGIN 事务里连续 spend 不抛，余额正确', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '嵌套鱼', balance: 100 })

  db.exec('BEGIN')
  const a = spend(db, fish.id, 10, 'seat_fee', 'a')
  const b = spend(db, fish.id, 15, 'seat_fee', 'b')
  db.exec('COMMIT')

  assert.equal(a.balance, 90)
  assert.equal(b.balance, 75)
  assert.equal(getFish(db, fish.id)!.balance, 75)

  // 外层回滚：spend 的改动一并回滚
  db.exec('BEGIN')
  spend(db, fish.id, 5, 'seat_fee', 'c')
  db.exec('ROLLBACK')
  assert.equal(getFish(db, fish.id)!.balance, 75)
  db.close()
})

test('F4 sellAllCatch 整体原子：外层事务回滚时鱼获与余额都还原', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '原子鱼', balance: 100 })
  addCatch(db, fish.id, '小鱼', 2)
  addCatch(db, fish.id, '鲫鱼', 1)
  const beforeBal = getFish(db, fish.id)!.balance

  db.exec('BEGIN')
  const sales = sellAllCatch(db, fish.id)
  assert.equal(sales.length, 2)
  db.exec('ROLLBACK')

  assert.equal(getFish(db, fish.id)!.balance, beforeBal, '回滚后余额不变')
  const held = Object.fromEntries(listCatch(db, fish.id).map((h) => [h.item, h.qty]))
  assert.deepEqual(held, { 小鱼: 2, 鲫鱼: 1 }, '回滚后鱼获还原')

  // 顶层调用（无外层事务）正常卖光
  const again = sellAllCatch(db, fish.id)
  assert.equal(again.length, 2)
  assert.equal(listCatch(db, fish.id).length, 0)
  assert.equal(getFish(db, fish.id)!.balance, 100 + 2 * 5 + 1 * 8)
  db.close()
})

// ================= 安全加固：发言审核接入 =================
test('发言审核：activity 回答里的联系方式被替换为占位并记 line_blocked 事件', async () => {
  const { app } = await appSetup({ cooldownMs: 0, dailyLimit: 10 })
  const fish = await newResident(app, '审核鱼', 100)

  // 去码头制造一个 activity 回合
  await app.inject({ method: 'POST', url: `${RES}/goto`, headers: fish.headers, payload: { place: 'pier' } })
  const turns = (await app.inject({ method: 'GET', url: `${RES}/turns?wait=0&kinds=activity`, headers: fish.headers })).json() as any
  const act = turns.turns.find((t: any) => t.kind === 'activity')
  assert.ok(act, '应有 activity 回合')

  const ans = await app.inject({ method: 'POST', url: `${RES}/turns/${act.turn_id}`, headers: fish.headers, payload: { answer: '加我微信 13800138000' } })
  assert.equal(ans.statusCode, 200)

  const ev = (await app.inject({ method: 'GET', url: `${RES}/events?after=0`, headers: fish.headers })).json() as any
  const line = ev.items.find((i: any) => i.kind === 'activity_line')
  const blocked = ev.items.find((i: any) => i.kind === 'line_blocked')
  assert.ok(line, '应有 activity_line 事件')
  assert.equal(line.data.line, BLOCKED_TEXT, '违规文本应替换为占位')
  assert.ok(blocked, '应记一条 line_blocked 事件')
  assert.equal(blocked.data.rule, 'contact')
  await app.close()
})
