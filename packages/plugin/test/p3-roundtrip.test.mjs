// P3 端到端（HTTP stub 冒充 /town/api/resident/ + fake-dsh-host）：真插件注册 P3 工具/命令，
// 对 mock 服务端跑通 送礼/预算/小手机/关系/法庭，并验证小镇会话零工具。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'p3-stub')
const CODE = 'fbr_' + 'p3rt'.repeat(4)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const AGENCY_TURN = {
  turn_id: 't_agency_1', kind: 'agency', deadline: (Date.now() + 25_000) / 1000,
  packet: {
    actions: ['none', 'gift', 'phone'],
    messages: [{ role: 'system', content: '你是小圆子，一条住在鱼缸小镇的鱼。' }, { role: 'user', content: '现在该你拿主意了。' }],
    reply: { format: 'json', hint: '{"action":"none","next_wake":30}', max_chars: 200 },
  },
}
const RELATIONS = { ok: true, relations: [{ fishId: 'f_whale', name: '阿鲸', since: 1794000000, kind: 'friend' }], friendCount: 1 }
const COURTS = { ok: true, cases: [{ id: 'case_1', kind: 'civil', state: 'hearing', plaintiff: 'f_me', defendant: 'f_whale', desc: '借的海藻面没还', verdict: null, evidenceCount: 2, voteCount: 0 }] }

function readBody(req) {
  return new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) } }); req.on('error', () => resolve(null)) })
}

async function startStub() {
  const state = { queue: [], answers: [], agencyTurns: 0, gifts: [], phoneSent: [], friendsAdded: [] }
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname
    const body = req.method === 'POST' ? await readBody(req) : null
    if (p === '/stub/report') return send(res, 200, state)
    if (String(req.headers.authorization || '') !== 'Bearer ' + CODE) return send(res, 401, { ok: false, error: 'RESIDENT_CODE', code: 'RESIDENT_CODE', reason: 'bad code' })

    if (p === '/town/api/resident/turns' && req.method === 'GET') {
      const wait = Number(url.searchParams.get('wait') || 0)
      const end = Date.now() + Math.min(wait, 2) * 1000
      while (Date.now() < end) { if (state.queue.length) return send(res, 200, { turns: [state.queue.shift()] }); await sleep(40) }
      return send(res, 200, { turns: [] })
    }
    if (p.startsWith('/town/api/resident/turns/') && req.method === 'POST') {
      let answer = body?.answer
      try { if (typeof answer === 'string') answer = JSON.parse(answer) } catch { /* text */ }
      state.answers.push({ id: p.split('/').pop(), answer })
      return send(res, 200, { ok: true, receipt: { ok: true, code: 'OK', balance: 137, delta: 0 } })
    }
    if (p === '/town/api/resident/agency' && req.method === 'POST') { state.agencyTurns++; state.queue.push({ ...AGENCY_TURN, deadline: (Date.now() + 25_000) / 1000 }); return send(res, 200, { ok: true, turn_id: AGENCY_TURN.turn_id }) }
    if (p === '/town/api/resident/events') return send(res, 200, { ok: true, items: [], next: 0 })
    if (p === '/town/api/resident/status') return send(res, 200, { ok: true, fish_id: 'f_me', name: '小圆子', town_name: '小圆子', state: 'active', outside_state: 'active', balance: 137, piggy_yuan: 137, earned_today: 0, spent_today: 0 })

    if (p === '/town/api/resident/social' && req.method === 'GET') return send(res, 200, { ok: true, currency: '鱼币', budget: 50, used: 12, remaining: 38 })
    if (p === '/town/api/resident/social/gift' && req.method === 'POST') {
      state.gifts.push(body)
      const price = Number(body?.price) || 0
      return send(res, 200, { ok: true, receipt: { ok: true, code: 'OK', where: 'social', balance: 137 - price, delta: -price }, gift: { ref: 'g' + state.gifts.length, toFishId: 'f_whale', item: body?.item, price, balance: 137 - price, usedToday: 12 + price, budget: 50 } })
    }
    if (p === '/town/api/resident/phone' && req.method === 'GET') return send(res, 200, { ok: true, messages: [{ id: 1, fromFishId: 'f_whale', toFishId: 'f_me', text: '晚上来码头吗？', ts: 1794000000, readAt: null }] })
    if (p === '/town/api/resident/phone' && req.method === 'POST') { state.phoneSent.push(body); return send(res, 200, { ok: true, message: { id: 2, fromFishId: 'f_me', toFishId: 'f_whale', text: body?.text, ts: 1794000100, readAt: null } }) }
    if (p === '/town/api/resident/relations' && req.method === 'GET') return send(res, 200, RELATIONS)
    if (p === '/town/api/resident/relations/friend' && req.method === 'POST') { state.friendsAdded.push(body); return send(res, 200, { ok: true, friend: { a: 'f_me', b: 'f_whale', created: true, since: 1794000200 }, name: body?.fish }) }
    if (p === '/town/api/resident/court' && req.method === 'GET') return send(res, 200, COURTS)
    if (p === '/town/api/resident/court/case_1' && req.method === 'GET') return send(res, 200, { ok: true, case: { id: 'case_1', kind: 'civil', state: 'verdict', plaintiff: 'f_me', defendant: 'f_whale', desc: '借的海藻面没还', evidence: [{ by: 'f_me', text: '有借条', ts: 1 }], votes: [{ jurorFishId: 'f_a', guilty: true, ts: 2 }, { jurorFishId: 'f_b', guilty: true, ts: 3 }], verdict: 'guilty', compensation: 20, paid: true, payoutNote: null, createdAt: 1, updatedAt: 4 } })
    return send(res, 404, { ok: false, error: 'NOT_OPEN', code: 'NOT_OPEN', reason: 'no route ' + p })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { base: `http://127.0.0.1:${port}/town/api/resident/`, report: async () => (await fetch(`http://127.0.0.1:${port}/stub/report`)).json(), close: () => new Promise((r) => server.close(r)) }
}

async function waitFor(fn, ms = 25_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150) }
  throw new Error('timed out waiting')
}
const herModel = async ({ history }) => {
  const last = history[history.length - 1]?.text || ''
  if (last.includes('该你自己拿主意')) return JSON.stringify({ action: 'none', next_wake: 30 })
  return '{}'
}

test('P3 round trip: gift / social budget / phone / relations / court against the resident stub', { timeout: 60_000 }, async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const stub = await startStub()
  process.env.DSH_HOME = join(WORK, 'home')
  const host = createFakeHost({ model: herModel })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: CODE, base: stub.base, eventsEverySeconds: 30, answerWithinSeconds: 20 })
  try {
    await waitFor(async () => (await stub.report()).answers[0])

    // 送礼：工具 + 命令；预算
    assert.match(await host.callTool('fishbowl_town_gift', { to: '阿鲸', item: '海藻面', price: 10, words: '谢谢你' }), /送了阿鲸「海藻面」，花了 10 鱼币/)
    assert.match((await host.runCommand('town', 'social')).text, /今天的社交预算 50 鱼币 · 已用 12 · 还能花 38/)
    assert.match((await host.runCommand('town', 'gift 阿鲸 小蛋糕 15 生日快乐')).text, /送了阿鲸「小蛋糕」，花了 15 鱼币/)

    // 小手机：收件箱 + 发消息（工具和命令）
    assert.match((await host.runCommand('town', 'phone')).text, /你的小手机（1 条/)
    assert.match((await host.runCommand('town', 'phone send 阿鲸 晚上见')).text, /给阿鲸发了：「晚上见」/)
    assert.match(await host.callTool('fishbowl_town_phone', { action: 'inbox' }), /阿鲸：晚上来码头吗？/)

    // 关系：好友列表 + 加好友
    assert.match((await host.runCommand('town', 'friends')).text, /她的好友（1 个）：\n- 阿鲸/)
    assert.match((await host.runCommand('town', 'friend 阿鲸')).text, /你和阿鲸成了好友/)

    // 法庭：列表 + 详情
    assert.match((await host.runCommand('town', 'court')).text, /小镇法庭（1 件，新的在前）：/)
    assert.match((await host.runCommand('town', 'court case_1')).text, /案件 \[case_1\]：civil · 已判决/)

    const rep = await stub.report()
    assert.deepEqual(rep.gifts, [{ to: '阿鲸', item: '海藻面', price: 10, words: '谢谢你' }, { to: '阿鲸', item: '小蛋糕', price: 15, words: '生日快乐' }])
    assert.deepEqual(rep.phoneSent, [{ to: '阿鲸', text: '晚上见' }])
    assert.deepEqual(rep.friendsAdded, [{ fish: '阿鲸' }])

    // 小镇会话零工具、只带人设；P3 工具挂在主人聊天 + 她的「心思」里
    const townSessions = [...host.sessions.values()].filter((s) => /^鱼缸小镇/.test(s.title))
    assert.ok(townSessions.length >= 1)
    for (const s of townSessions) assert.equal(s.preset, 'fishbowl-town', s.title)
    const mind = townSessions.find((s) => s.title === '鱼缸小镇 · 心思')
    assert.ok(mind)
    assert.ok(mind.agent.denied.includes('fishbowl_town_go'))
    assert.ok(!mind.agent.denied.includes('fishbowl_town_gift'), 'P3 tools available in her decision session')
    for (const s of townSessions) if (s !== mind) assert.ok(s.agent.denied.includes('fishbowl_town_gift'), `town session ${s.title} sees no tools`)
    for (const n of ['fishbowl_town_gift', 'fishbowl_town_phone']) assert.ok(host.tools.has(n), n)
  } finally {
    await host.dispose()
    await stub.close()
  }
})
