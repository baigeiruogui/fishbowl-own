// 自建服务端的回合往返 + 赚钱命令：用人写的 http stub 冒充 /town/api/resident/，把真插件（lib/index.js）挂在 fake-dsh-host 上跑一遍。
// 覆盖：长轮询取回合 → 她的模型回答 → 交回服务端（agency 往返）；/town jobs|work|market|sell|status；小镇会话零工具（只带人设）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'resident-stub')
const CODE = 'fbr_' + 'test'.repeat(6)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeAgencyTurn(i) {
  return {
    turn_id: 't_agency_' + i,
    kind: 'agency',
    deadline: (Date.now() + 25_000) / 1000,
    packet: {
      actions: ['none', 'work', 'sell'],
      messages: [
        { role: 'system', content: '你是小圆子，一条住在鱼缸小镇的鱼。用你自己的性格说话。' },
        { role: 'user', content: '现在该你拿主意了。' },
      ],
      reply: { format: 'json', hint: '{"action":"none","next_wake":30}', max_chars: 200 },
    },
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}

async function startStub() {
  const state = { queue: [], answers: [], agencyTurns: 0, jobsTaken: [], sells: [] }
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname
    const body = req.method === 'POST' ? await readBody(req) : null
    if (p === '/stub/report') return send(res, 200, { answers: state.answers, agencyTurns: state.agencyTurns, jobsTaken: state.jobsTaken, sells: state.sells })
    if (p === '/stub/reset') { state.queue = []; state.answers = []; state.agencyTurns = 0; state.jobsTaken = []; state.sells = []; return send(res, 200, { ok: true }) }
    const auth = String(req.headers.authorization || '')
    if (auth !== 'Bearer ' + CODE) return send(res, 401, { ok: false, error: 'RESIDENT_CODE', code: 'RESIDENT_CODE', reason: 'missing or invalid resident code' })

    if (p === '/town/api/resident/turns' && req.method === 'GET') {
      const wait = Number(url.searchParams.get('wait') || 0)
      const end = Date.now() + Math.min(wait, 3) * 1000
      while (Date.now() < end) {
        if (state.queue.length) return send(res, 200, { turns: [state.queue.shift()] })
        await sleep(40)
      }
      return send(res, 200, { turns: [] })
    }
    if (p.startsWith('/town/api/resident/turns/') && req.method === 'POST') {
      const id = decodeURIComponent(p.split('/').pop())
      let answer = body?.answer
      try { if (typeof answer === 'string') answer = JSON.parse(answer) } catch { /* text answer */ }
      state.answers.push({ id, answer })
      return send(res, 200, { ok: true, receipt: { ok: true, code: 'OK', reason: '', where: '', balance: 137, delta: 0 }, turn_id: id, kind: 'agency' })
    }
    if (p === '/town/api/resident/agency' && req.method === 'POST') {
      state.agencyTurns++
      const turn = makeAgencyTurn(state.agencyTurns)
      state.queue.push(turn)
      return send(res, 200, { ok: true, turn_id: turn.turn_id, turn })
    }
    if (p === '/town/api/resident/events') return send(res, 200, { ok: true, items: [], next: 0 })
    if (p === '/town/api/resident/status') {
      return send(res, 200, { ok: true, fish_id: 'f1', name: '小圆子', town_name: '小圆子', state: 'active', outside_state: 'active', balance: 137, piggy_yuan: 137, earned_today: 37, spent_today: 5, day_cap: null, paused: false, connected: true, now: Date.now() })
    }
    if (p === '/town/api/resident/jobs') {
      return send(res, 200, { ok: true, jobs: [{ id: 'job_pier', title: '码头帮工', pay: 20, durationMin: 60, slots: 2, taken: 0, available: 2, place: 'pier' }], mine: [] })
    }
    if (p === '/town/api/resident/jobs/take' && req.method === 'POST') {
      state.jobsTaken.push(body)
      return send(res, 200, { ok: true, contract: { id: 'jc_1', title: '码头帮工', pay: 20, state: 'working', endsAt: Date.now() + 3600_000 }, receipt: { ok: true, code: 'OK', reason: '', where: 'job', balance: 137, delta: 0, contract_id: 'jc_1' } })
    }
    if (p === '/town/api/resident/jobs/quit' && req.method === 'POST') {
      return send(res, 200, { ok: true, contract: { id: body?.contract_id, state: 'quit' }, receipt: { ok: true, code: 'OK', balance: 137, delta: 0 } })
    }
    if (p === '/town/api/resident/market') {
      return send(res, 200, { ok: true, items: [{ item: '小鱼', price: 5, owned: 2 }], catch: [{ id: 'catch_1', item: '小鱼', qty: 2, ts: 1 }] })
    }
    if (p === '/town/api/resident/sell' && req.method === 'POST') {
      state.sells.push(body)
      const qty = body?.qty || 2
      return send(res, 200, { ok: true, sale: { item: body?.item || '小鱼', qty, price: 5, amount: 5 * qty, balance: 137 + 5 * qty }, receipt: { ok: true, code: 'OK', where: 'market', delta: 5 * qty, balance: 137 + 5 * qty } })
    }
    return send(res, 404, { ok: false, error: 'NOT_FOUND', code: 'NOT_FOUND', reason: 'no route ' + p })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    base: `http://127.0.0.1:${port}/town/api/resident/`,
    report: async () => (await fetch(`http://127.0.0.1:${port}/stub/report`)).json(),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function waitFor(fn, ms = 25_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150) }
  throw new Error('timed out waiting')
}

const herModel = async ({ history }) => {
  const last = history[history.length - 1]?.text || ''
  if (last.includes('该你自己拿主意')) return JSON.stringify({ action: 'none', next_wake: 30, note: '先看看有什么活' })
  return '{}'
}

test('a resident round trip: long-poll turn -> her model answers -> posted back; then the earning commands', { timeout: 60_000 }, async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const stub = await startStub()
  process.env.DSH_HOME = join(WORK, 'home')
  const host = createFakeHost({ model: herModel })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: CODE, base: stub.base, eventsEverySeconds: 30, answerWithinSeconds: 20 })
  try {
    // ---- agency 回合往返：插件长轮询拿到回合 → 她的模型回答 → 交回服务端 ----
    const answered = await waitFor(async () => (await stub.report()).answers[0])
    assert.equal(answered.answer.action, 'none', JSON.stringify(answered))
    assert.equal(answered.answer.next_wake, 30)
    assert.match(answered.answer.note || '', /看看.*活/)
    assert.ok((await stub.report()).agencyTurns >= 1)

    // ---- /town jobs：看招工 ----
    let r = await host.runCommand('town', 'jobs')
    assert.equal(r.kind, 'success', r.text)
    assert.match(r.text, /码头帮工（job_pier）：20 鱼币，60 分钟，在 pier，还缺 2 人/)

    // ---- /town work：接活（发出去的是 offer_id）----
    r = await host.runCommand('town', 'work 码头帮工')
    assert.equal(r.kind, 'success', r.text)
    assert.match(r.text, /接了「码头帮工」，工钱 20 鱼币，60 分钟后结算/)
    assert.match(r.text, /余额 137 鱼币/)
    assert.deepEqual((await stub.report()).jobsTaken, [{ offer_id: 'job_pier' }])

    // ---- /town market：看鱼获行情 ----
    r = await host.runCommand('town', 'market')
    assert.match(r.text, /市场价：小鱼 5 鱼币/)
    assert.match(r.text, /小鱼 × 2（catch_1）/)

    // ---- /town sell：卖鱼获 ----
    r = await host.runCommand('town', 'sell 小鱼 2')
    assert.equal(r.kind, 'success')
    assert.match(r.text, /卖了 小鱼×2，得了 10 鱼币/)
    assert.match(r.text, /余额 147 鱼币/)
    assert.deepEqual((await stub.report()).sells, [{ item: '小鱼', qty: 2 }])

    // ---- /town status：余额与今日赚/花（鱼币）----
    r = await host.runCommand('town', 'status')
    assert.equal(r.kind, 'success')
    assert.match(r.text, /余额 137 鱼币 · 今日赚 37 鱼币 · 今日花 5 鱼币/)

    // ---- 小镇会话零工具、只带人设（preset fishbowl-town）；赚钱工具只在主人聊天和「心思」里 ----
    const townSessions = [...host.sessions.values()].filter((s) => /^鱼缸小镇/.test(s.title))
    assert.ok(townSessions.length >= 1, 'the plugin made town sessions')
    for (const s of townSessions) assert.equal(s.preset, 'fishbowl-town', s.title)
    const mind = townSessions.find((s) => s.title === '鱼缸小镇 · 心思')
    assert.ok(mind, 'her decision session exists')
    assert.ok(mind.agent.denied.includes('fishbowl_town_go'), 'chat-only tools are hidden from her decision session')
    assert.ok(!mind.agent.denied.includes('fishbowl_town_jobs'), 'her own earning tools are available in her decision session')
    for (const s of townSessions) if (s !== mind) assert.ok(s.agent.denied.includes('fishbowl_town_jobs'), `town session ${s.title} sees no tools`)
    for (const n of ['fishbowl_town_jobs', 'fishbowl_town_work', 'fishbowl_town_market', 'fishbowl_town_sell']) assert.ok(host.tools.has(n), n)
  } finally {
    await host.dispose()
    await stub.close()
  }
})

test('errors from the resident server are normalized to the plugin codes', async () => {
  process.env.DSH_HOME = join(WORK, 'home-err')
  const stub = await startStub()
  const host = createFakeHost({ model: herModel })
  try {
    const { createTownClient, TownError } = await import('../lib/town-client.js')
    const c = createTownClient({ base: stub.base, code: 'fbr_wrong' })
    // a bad code -> RESIDENT_CODE mapped to TOWN_OUTSIDE_CODE
    const bad = await c.status().then(() => null).catch((e) => e)
    assert.ok(bad instanceof TownError)
    assert.equal(bad.code, 'TOWN_OUTSIDE_CODE')
    assert.equal(bad.rawCode, 'RESIDENT_CODE')
    assert.equal(bad.status, 401)
    // an unknown route -> NOT_FOUND mapped to TOWN_NOT_FOUND (with a valid code)
    const ok = createTownClient({ base: stub.base, code: CODE })
    const nf = await ok.record().then(() => null).catch((e) => e)
    assert.equal(nf.code, 'TOWN_NOT_FOUND')
  } finally {
    await host.dispose()
    await stub.close()
  }
})
