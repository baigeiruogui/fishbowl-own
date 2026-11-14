// P2 端到端（HTTP stub 冒充 /town/api/resident/ + fake-dsh-host）：真插件注册 P2 工具/命令，
// 对 mock 服务端跑通 开店/悬赏/大厅，并验证服务端 NOT_OPEN 时优雅提示、小镇会话零工具。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'p2-stub')
const CODE = 'fbr_' + 'p2test'.repeat(4)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const AGENCY_TURN = {
  turn_id: 't_agency_1', kind: 'agency', deadline: (Date.now() + 25_000) / 1000,
  packet: {
    actions: ['none', 'shop', 'bounty', 'lobby'],
    messages: [{ role: 'system', content: '你是小圆子，一条住在鱼缸小镇的鱼。' }, { role: 'user', content: '现在该你拿主意了。' }],
    reply: { format: 'json', hint: '{"action":"none","next_wake":30}', max_chars: 200 },
  },
}
const SHOP = { ok: true, shop: { id: 'shop_1', name: '小圆子的小店', kind: '小吃', open: true, items: [{ id: 'it_1', name: '海藻面', price: 12, stock: 5 }] } }
const BOUNTY = { id: 'b_1', title: '找回走丢的猫', desc: '在码头', reward: 30, state: 'open' }

function readBody(req) {
  return new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) } }); req.on('error', () => resolve(null)) })
}

async function startStub() {
  const state = { queue: [], answers: [], agencyTurns: 0, shopOpened: [], stocks: [], closed: 0, bountyPosted: [], takes: [], claims: [] }
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname
    const body = req.method === 'POST' ? await readBody(req) : null
    if (p === '/stub/report') return send(res, 200, state)
    if (p === '/stub/reset') { Object.assign(state, { queue: [], answers: [], agencyTurns: 0, shopOpened: [], stocks: [], closed: 0, bountyPosted: [], takes: [], claims: [] }); return send(res, 200, { ok: true }) }
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
    if (p === '/town/api/resident/status') return send(res, 200, { ok: true, fish_id: 'f1', name: '小圆子', town_name: '小圆子', state: 'active', outside_state: 'active', balance: 137, piggy_yuan: 137, earned_today: 37, spent_today: 5, paused: false })

    if (p === '/town/api/resident/shop/mine') return send(res, 200, SHOP)
    if (p === '/town/api/resident/shop/open' && req.method === 'POST') { state.shopOpened.push(body); return send(res, 200, { ok: true, shop: { id: 'shop_1', name: body?.name, kind: body?.kind || null, open: true, items: [] }, receipt: { ok: true, balance: 137 } }) }
    if (p === '/town/api/resident/shop/stock' && req.method === 'POST') { state.stocks.push(body); return send(res, 200, { ok: true, item: { id: 'it_2', name: body?.item, price: body?.price, stock: body?.stock }, receipt: { ok: true, balance: 137 } }) }
    if (p === '/town/api/resident/shop/close' && req.method === 'POST') { state.closed++; return send(res, 200, { ok: true, receipt: { ok: true, balance: 137 } }) }

    if (p === '/town/api/resident/bounties' && req.method === 'GET') return send(res, 200, { ok: true, bounties: [BOUNTY] })
    if (p === '/town/api/resident/bounties' && req.method === 'POST') { state.bountyPosted.push(body); return send(res, 200, { ok: true, bounty: { id: 'b_9', title: body?.title, reward: body?.reward, state: 'open' } }) }
    if (p === '/town/api/resident/bounties/take' && req.method === 'POST') { state.takes.push(body); return send(res, 200, { ok: true, bounty: { ...BOUNTY, id: body?.bounty_id, state: 'taken' }, receipt: { ok: true, balance: 137 } }) }
    if (p === '/town/api/resident/bounties/claim' && req.method === 'POST') { state.claims.push(body); return send(res, 200, { ok: true, bounty: { ...BOUNTY, id: body?.bounty_id, state: 'done' }, receipt: { ok: true, balance: 167, delta: 30 } }) }

    if (p === '/town/api/resident/lobby') return send(res, 200, { ok: true, games: [{ game: 'werewolf', game_zh: '狼人杀', seats_min: 6, seats_max: 9, fee_yuan_from: 0 }], tables: [], activities: [], places: [], fish: [], mine: { signups: [], at_table: null, visiting: null } })
    if (p === '/town/api/resident/play' && req.method === 'POST') return send(res, 200, { ok: false, code: 'NOT_OPEN', reason: '牌桌将在新版开放', where: 'table', balance: 137 })
    if (p === '/town/api/resident/visit' && req.method === 'POST') return send(res, 200, { ok: false, code: 'NOT_OPEN', reason: '串门暂未开放，等新版', where: 'home', balance: 137 })

    return send(res, 404, { ok: false, error: 'NOT_FOUND', code: 'NOT_FOUND', reason: 'no route ' + p })
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

test('P2 round trip: shop / bounty tools + commands against the resident stub, and NOT_OPEN lobby/play/visit do not crash', { timeout: 60_000 }, async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const stub = await startStub()
  process.env.DSH_HOME = join(WORK, 'home')
  const host = createFakeHost({ model: herModel })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: CODE, base: stub.base, eventsEverySeconds: 30, answerWithinSeconds: 20 })
  try {
    await waitFor(async () => (await stub.report()).answers[0])

    // 开店：工具 + 命令
    assert.match(await host.callTool('fishbowl_town_shop', { action: 'open', name: '小圆子的小店', kind: '小吃' }), /开了家店「小圆子的小店」/)
    assert.match(await host.callTool('fishbowl_town_shop', { action: 'add', item: '海藻面', price: 12, stock: 5 }), /上架了「海藻面」：12 鱼币，库存 5/)
    assert.match((await host.runCommand('town', 'shop list')).text, /你的店「小圆子的小店」/)
    assert.match((await host.runCommand('town', 'shop close')).text, /歇业/)

    // 悬赏：工具 + 命令
    assert.match(await host.callTool('fishbowl_town_bounty', { action: 'list' }), /\[b_1\] 找回走丢的猫：赏金 30 鱼币（待接）/)
    assert.match(await host.callTool('fishbowl_town_bounty', { action: 'take', id: 'b_1' }), /接了悬赏「找回走丢的猫」/)
    assert.match(await host.callTool('fishbowl_town_bounty', { action: 'claim', id: 'b_1', evidence: '在码头找到' }), /领到 30 鱼币/)
    assert.match((await host.runCommand('town', 'bounty post 找回 小猫 25')).text, /发布了悬赏「找回 小猫」，赏金 25 鱼币/)

    // 大厅：能看；桌/玩/串门服务端 NOT_OPEN → 一句人话，不崩
    assert.match((await host.runCommand('town', 'lobby')).text, /狼人杀/)
    assert.match((await host.runCommand('town', 'table v_boardgame_ww')).text, /这个小镇还没开放牌桌/)
    assert.match((await host.runCommand('town', 'play 狼人杀')).text, /这个小镇还没开放牌桌 \/ 开一局/)
    assert.match((await host.runCommand('town', 'visit 阿鲸')).text, /这个小镇还没开放串门/)

    // 发出去的请求正确
    const rep = await stub.report()
    assert.deepEqual(rep.shopOpened, [{ name: '小圆子的小店', kind: '小吃' }])
    assert.deepEqual(rep.stocks, [{ item: '海藻面', price: 12, stock: 5 }])
    assert.equal(rep.closed, 1)
    assert.deepEqual(rep.takes, [{ bounty_id: 'b_1' }])
    assert.deepEqual(rep.claims, [{ bounty_id: 'b_1', evidence: '在码头找到' }])
    assert.deepEqual(rep.bountyPosted, [{ title: '找回 小猫', reward: 25 }])

    // 小镇会话零工具、只带人设；P2 工具挂在主人聊天（和她的「心思」）里
    const townSessions = [...host.sessions.values()].filter((s) => /^鱼缸小镇/.test(s.title))
    assert.ok(townSessions.length >= 1)
    for (const s of townSessions) assert.equal(s.preset, 'fishbowl-town', s.title)
    const mind = townSessions.find((s) => s.title === '鱼缸小镇 · 心思')
    assert.ok(mind)
    assert.ok(mind.agent.denied.includes('fishbowl_town_go'), 'chat-only tools hidden from her decision session')
    assert.ok(!mind.agent.denied.includes('fishbowl_town_shop'), 'P2 tools available in her decision session')
    for (const s of townSessions) if (s !== mind) assert.ok(s.agent.denied.includes('fishbowl_town_shop'), `town session ${s.title} sees no tools`)
    for (const n of ['fishbowl_town_shop', 'fishbowl_town_bounty', 'fishbowl_town_lobby']) assert.ok(host.tools.has(n), n)
  } finally {
    await host.dispose()
    await stub.close()
  }
})
