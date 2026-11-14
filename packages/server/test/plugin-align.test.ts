import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/index.ts'
import { createFish, getFish } from '../src/db/index.ts'
import type { DB } from '../src/db/index.ts'
import { issueResidentCode } from '../src/api/auth.ts'

const BASE = '/town/api/resident'
const ADMIN = 'align-admin'

async function setup() {
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN })
  const db = (app as unknown as { db: DB }).db
  const fish = createFish(db, { name: '对齐鱼', balance: 100, persona: '爱钓鱼' })
  const { code } = issueResidentCode(db, fish.id)
  const headers = { authorization: 'Bearer ' + code }
  return { app, db, fish, code, headers }
}

// ---------------- 逐端点 inject：状态码 + 最小结构 ----------------
test('align: record / receipts / spending / bonds / status 字段结构', async () => {
  const { app, headers } = await setup()

  const record = await app.inject({ method: 'GET', url: `${BASE}/record`, headers })
  assert.equal(record.statusCode, 200)
  const r = record.json() as any
  assert.equal(r.ok, true)
  assert.equal(typeof r.name, 'string')
  assert.equal(typeof r.line, 'string')
  assert.ok(Array.isArray(r.recent))
  assert.ok(r.places && r.places.pier && typeof r.places.pier.catches === 'number')
  assert.ok(r.social && typeof r.social.friends === 'number')
  assert.ok(Array.isArray(r.recent_receipts))

  const receipts = await app.inject({ method: 'GET', url: `${BASE}/receipts?limit=20`, headers })
  assert.equal(receipts.statusCode, 200)
  const rb = receipts.json() as any
  assert.ok(Array.isArray(rb.receipts))
  assert.ok(rb.receipts.length >= 1) // 至少有 init 那条
  assert.equal(typeof rb.receipts[0].ts, 'number')

  const spending = await app.inject({ method: 'GET', url: `${BASE}/spending`, headers })
  assert.equal(spending.statusCode, 200)
  const sp = spending.json() as any
  for (const k of ['today', 'd7', 'd30', 'total']) assert.equal(typeof sp[k], 'number', k)
  assert.ok(Array.isArray(sp.by_kind))

  const bonds = await app.inject({ method: 'GET', url: `${BASE}/bonds`, headers })
  assert.equal(bonds.statusCode, 200)
  const bb = bonds.json() as any
  assert.ok(Array.isArray(bb.friends))
  assert.ok(Array.isArray(bb.ties))
  assert.equal(typeof bb.guidance, 'string')

  const status = await app.inject({ method: 'GET', url: `${BASE}/status`, headers })
  const st = status.json() as any
  assert.equal(typeof st.earned_today, 'number')
  assert.equal(typeof st.today_earned, 'number')
  assert.equal(typeof st.today_spent, 'number')
  assert.equal(typeof st.day_cap !== 'undefined', true)
  await app.close()
})

test('align: card 改名/自我介绍，过长截断', async () => {
  const { app, db, fish, headers } = await setup()
  const longIntro = '我爱在码头钓鱼。'.repeat(40) // > 200
  const res = await app.inject({
    method: 'POST',
    url: `${BASE}/card`,
    headers,
    payload: { name: '名'.repeat(30), intro: longIntro },
  })
  assert.equal(res.statusCode, 200)
  const b = res.json() as any
  assert.equal(b.ok, true)
  assert.ok([...b.name].length <= 20)
  assert.ok([...b.intro].length <= 200)
  // 落库生效
  const fresh = getFish(db, fish.id)!
  assert.ok([...fresh.name].length <= 20)
  assert.ok([...fresh.intro].length <= 200)
  await app.close()
})

test('align: visit / play 真实返回 ok；signup_cancel 成功', async () => {
  const { app, headers } = await setup()
  const visit = await app.inject({ method: 'POST', url: `${BASE}/visit`, headers, payload: { name: '阿浪' } })
  assert.equal(visit.statusCode, 200)
  const vb = visit.json() as any
  assert.equal(vb.ok, true)
  assert.ok(vb.note)

  const play = await app.inject({ method: 'POST', url: `${BASE}/play`, headers, payload: { game: 'ddz' } })
  assert.equal(play.statusCode, 200)
  const pb = play.json() as any
  assert.equal(pb.ok, true)
  assert.ok(pb.table && pb.table.id)
  assert.equal(pb.state, 'waiting')

  const cancel = await app.inject({ method: 'POST', url: `${BASE}/signup_cancel`, headers, payload: {} })
  assert.equal(cancel.statusCode, 200)
  assert.equal((cancel.json() as any).ok, true)
  await app.close()
})

test('align: 未开放端点返回 404 + NOT_OPEN（extras 可识别）', async () => {
  const { app, headers } = await setup()
  // P3/P3.5 已接线 social/phone/album → 应 200
  for (const p of ['social', 'phone', 'album']) {
    const res = await app.inject({ method: 'GET', url: `${BASE}/${p}`, headers })
    assert.equal(res.statusCode, 200, p)
    assert.equal((res.json() as any).ok, true, p)
  }
  const gets = ['week', 'room']
  for (const p of gets) {
    const res = await app.inject({ method: 'GET', url: `${BASE}/${p}`, headers })
    assert.equal(res.statusCode, 404, p)
    assert.equal((res.json() as any).code, 'NOT_OPEN', p)
  }
  // POST /social(socialDo)、consent、paint_social、look、paint_file 仍未接线 → 404
  const posts = ['consent', 'paint_social', 'look', 'paint_file', 'social']
  for (const p of posts) {
    const res = await app.inject({ method: 'POST', url: `${BASE}/${p}`, headers, payload: {} })
    assert.equal(res.statusCode, 404, p)
    assert.equal((res.json() as any).code, 'NOT_OPEN', p)
  }
  await app.close()
})

// ---------------- 插件调用矩阵：用真实 town-client 打服务端，覆盖每个方法 ----------------
test('align: 插件调用矩阵——town-client 每个方法都有可用/可识别未开放的响应', async () => {
  const { app, code } = await setup()
  const townMod = (await import(new URL('../../plugin/lib/town-client.js', import.meta.url).href)) as any
  const { createTownClient, TownError } = townMod

  // 把 fastify.inject 适配成 fetch，让插件客户端按真实用法打服务端
  const injectFetch = (input: any, init: any = {}) => {
    const u = typeof input === 'string' ? new URL(input) : input
    const path = u.pathname + (u.search || '')
    const resP = app.inject({ method: init.method || 'GET', url: path, headers: init.headers || {}, payload: init.body })
    return resP.then((res) => {
      const buf = Buffer.from(res.payload ?? '')
      return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: { get: (k: string) => res.headers[k.toLowerCase()] ?? null },
        text: async () => res.payload ?? '',
        json: async () => JSON.parse(res.payload ?? '{}'),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      }
    })
  }

  const client = createTownClient({ base: 'http://local/town/api/resident/', code, fetchImpl: injectFetch })
  const covered = new Set<string>()
  const ok = async (name: string, fn: () => Promise<any>) => {
    covered.add(name)
    return await fn()
  }
  const gone = async (name: string, fn: () => Promise<any>) => {
    covered.add(name)
    try {
      await fn()
    } catch (e: any) {
      assert.ok(e instanceof TownError || e?.name === 'TownError', `${name} 应抛 TownError，实际 ${e?.name || e}`)
      assert.ok(
        e.status === 404 || e.code === 'NOT_OPEN' || e.code === 'HTTP_404' || e.code === 'BAD_ALBUM_ID',
        `${name} 应为可识别未开放，实际 status=${e.status} code=${e.code}`,
      )
      return
    }
    assert.fail(`${name} 应抛未开放错误但成功返回了`)
  }

  // --- 核心：应 200 ---
  const page = await ok('turns', () => client.turns(0))
  assert.ok(Array.isArray(page.turns) && page.turns.length >= 1)
  const turn = page.turns[0]
  assert.equal(typeof turn.turn_id, 'string')

  await ok('answer', () => client.answer(turn.turn_id, JSON.stringify({ action: 'none' })))
  const events = await ok('events', () => client.events(0, 50))
  assert.ok(Array.isArray(events.items))
  const status = await ok('status', () => client.status())
  assert.equal(typeof status.balance, 'number')
  await ok('settings', () => client.settings({ wake_min_minutes: 30, quiet_hours: '22-7', social_day_cents: 500 }))
  const agency = await ok('agency', () => client.agency())
  assert.equal(agency.ok, true)
  const lobby = await ok('lobby', () => client.lobby())
  assert.ok(Array.isArray(lobby.places))
  const goto = await ok('goto', () => client.goto({ place: 'pier', do: 'fish' }))
  assert.equal(goto.ok, true)
  await ok('bonds', () => client.bonds())
  await ok('record', () => client.record())
  const receipts = await ok('receipts', () => client.receipts(20))
  assert.ok(Array.isArray(receipts.receipts))
  const spending = await ok('spending', () => client.spending())
  assert.equal(typeof spending.total, 'number')
  const card = await ok('card', () => client.card({ intro: '我喜欢在码头钓鱼' }))
  assert.equal(card.ok, true)
  await ok('signupCancel', () => client.signupCancel({}))

  const play = await ok('play', () => client.play({ game: 'ddz' }))
  assert.equal(play.ok, true)
  assert.ok(play.table && play.table.id)
  const visit = await ok('visit', () => client.visit({ name: '阿浪' }))
  assert.equal(visit.ok, true)

  // 赚钱链路：jobs → takeJob → quitJob，market → sell
  const jobs = await ok('jobs', () => client.jobs())
  assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.length >= 1)
  const taken = await ok('takeJob', () => client.takeJob({ offer_id: jobs.jobs[0].id }))
  assert.ok(taken.contract && taken.contract.id)
  await ok('quitJob', () => client.quitJob({ contract_id: taken.contract.id }))
  const market = await ok('market', () => client.market())
  assert.ok(Array.isArray(market.items))
  const sold = await ok('sell', () => client.sell({ item: '小鱼' }))
  assert.ok(sold.sale && sold.sale.amount >= 1)

  // --- 已接线（P3）：social 预算 / phone 列表 / phoneSend（需先加好友）---
  const socialInfo = await ok('social', () => client.social())
  assert.equal(typeof socialInfo.budget, 'number')
  const phone = await ok('phone', () => client.phone())
  assert.ok(Array.isArray(phone.messages))
  const authH = { authorization: 'Bearer ' + code }
  await app.inject({ method: 'POST', url: `${BASE}/relations/friend`, headers: authH, payload: { name: '阿浪' } })
  const rel = (await app.inject({ method: 'GET', url: `${BASE}/relations`, headers: authH })).json() as any
  const npcFriend = rel.relations.find((r: any) => r.name === '阿浪')
  assert.ok(npcFriend, '应已和 NPC 阿浪 成为好友')
  await ok('phoneSend', () => client.phoneSend({ to: npcFriend.fishId, text: 'hi' }))
  // 关系 / 送礼 / 法庭（P3 真实 200）
  const relOk = await ok('relations', () => client.relations())
  assert.ok(Array.isArray(relOk.relations))
  const addF = await ok('addFriend', () => client.addFriend({ fish: npcFriend.fishId }))
  assert.equal(addF.ok, true)
  const giftRes = await ok('socialGift', () => client.socialGift({ to: npcFriend.fishId, item: '小鱼干', price: 1, words: '谢谢' }))
  assert.equal(giftRes.ok, true)
  const filed = await app.inject({ method: 'POST', url: `${BASE}/court/file`, headers: authH, payload: { defendant: npcFriend.fishId, kind: 'civil', desc: '矩阵案件' } })
  const caseId = (filed.json() as any).case.id as string
  const courts = await ok('courts', () => client.courts())
  assert.ok(Array.isArray(courts.cases))
  const oneCourt = await ok('court', () => client.court(caseId))
  assert.equal(oneCourt.ok, true)

  // --- 仍未开放：应可识别（404 / NOT_OPEN）---
  await gone('socialDo', () => client.socialDo({ do: 'gift' }))
  await gone('week', () => client.week(7))
  await gone('room', () => client.room())
  await gone('paintSocial', () => client.paintSocial({ venue_id: 'v' }))
  await gone('look', () => client.look({}))
  await gone('consent', () => client.consent({ do: 'end', with: 'x' }))
  await gone('paintFile', () => client.paintFile('o', 0, 0))
  await gone('albumFile', () => client.albumFile('al_0000000000000000', false))
  await gone('report', () => client.report({ target: 'x', reason: 'spam' }))

  // --- 媒体 / 夸夸 / 小游戏（P3.5 已接线：真实 200；价格压低避免余额不足）---
  const album = await ok('album', () => client.album(30))
  assert.ok(Array.isArray(album.album))
  const photo = await ok('photo', () => client.photo({ scene: '码头', price: 1 }))
  assert.equal(photo.ok, true)
  const song = await ok('song', () => client.song({ to: 'x', title: '小曲', price: 1 }))
  assert.equal(song.ok, true)
  const paint = await ok('paint', () => client.paint({ title: '一只猫', price: 1 }))
  assert.equal(paint.ok, true)
  const bless = await ok('bless', () => client.bless({ text: '大家真棒' }))
  assert.equal(bless.ok, true)
  const rps = await ok('rps', () => client.rps({ choice: 'rock', stake: 1 }))
  assert.equal(rps.ok, true)
  const dice = await ok('dice', () => client.dice({ stake: 1 }))
  assert.equal(dice.ok, true)
  const lot = await ok('lottery', () => client.lottery({}))
  assert.equal(lot.ok, true)
  // 店铺 / 悬赏（P2 已接线：真实 200）
  const mine = await ok('shopMine', () => client.shopMine())
  assert.equal(mine.ok, true)
  const opened = await ok('shopOpen', () => client.shopOpen({ name: '矩阵小铺', kind: 'general' }))
  assert.equal(opened.ok, true)
  const stocked = await ok('shopStock', () => client.shopStock({ item: '鱼干', price: 10, stock: 5 }))
  assert.equal(stocked.ok, true)
  await ok('shopClose', () => client.shopClose({}))

  const bs = await ok('bounties', () => client.bounties({}))
  assert.ok(Array.isArray(bs.bounties))
  const posted = await ok('bountyPost', () => client.bountyPost({ title: '矩阵悬赏', reward: 20 }))
  assert.ok(posted.bounty && posted.bounty.id)
  const seededOpen = bs.bounties.find((b: any) => b.state === 'open')
  assert.ok(seededOpen, '种子应有一条 open 悬赏')
  await ok('bountyTake', () => client.bountyTake({ bounty_id: seededOpen.id }))
  await ok('bountyClaim', () => client.bountyClaim({ bounty_id: seededOpen.id }))

  // 覆盖了 town-client 的每一个方法
  const clientKeys = Object.keys(client).sort()
  const missed = clientKeys.filter((k) => !covered.has(k))
  assert.deepEqual(missed, [], '有 town-client 方法未覆盖：' + missed.join(', '))

  await app.close()
})
