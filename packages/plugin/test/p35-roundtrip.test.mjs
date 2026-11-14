// P3.5 端到端（HTTP stub + fake-dsh-host）：媒体 / 夸夸 / 小游戏工具与命令，且小镇会话零工具。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost } from './fake-dsh-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'p35-stub')
const CODE = 'fbr_' + 'p35rt'.repeat(4)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const AGENCY_TURN = {
  turn_id: 't_agency_1', kind: 'agency', deadline: (Date.now() + 25_000) / 1000,
  packet: { actions: ['none', 'photo', 'rps'], messages: [{ role: 'system', content: '你是小圆子。' }, { role: 'user', content: '拿主意。' }], reply: { format: 'json', hint: '{"action":"none","next_wake":30}', max_chars: 200 } },
}
const ALBUM = { ok: true, items: [{ id: 'm1', kind: 'photo', title: '码头日落', path: '/api/public/album/m1/file', ts: 1794000000 }, { id: 'm2', kind: 'song', title: '晴天', ts: 1794000100 }] }

function readBody(req) { return new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) } }); req.on('error', () => resolve(null)) }) }

async function startStub() {
  const state = { queue: [], answers: [], photos: [], songs: [], blesses: [], rps: [], dice: [], lottery: 0 }
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
    if (p.startsWith('/town/api/resident/turns/') && req.method === 'POST') { let answer = body?.answer; try { if (typeof answer === 'string') answer = JSON.parse(answer) } catch { /* text */ } state.answers.push({ id: p.split('/').pop(), answer }); return send(res, 200, { ok: true, receipt: { ok: true, balance: 100, delta: 0 } }) }
    if (p === '/town/api/resident/agency' && req.method === 'POST') { state.queue.push({ ...AGENCY_TURN, deadline: (Date.now() + 25_000) / 1000 }); return send(res, 200, { ok: true, turn_id: AGENCY_TURN.turn_id }) }
    if (p === '/town/api/resident/events') return send(res, 200, { ok: true, items: [], next: 0 })
    if (p === '/town/api/resident/status') return send(res, 200, { ok: true, fish_id: 'f_me', name: '小圆子', town_name: '小圆子', state: 'active', outside_state: 'active', balance: 100, piggy_yuan: 100, earned_today: 0, spent_today: 0 })
    if (p === '/town/api/resident/photo' && req.method === 'POST') { state.photos.push(body); return send(res, 200, { ok: true, receipt: { ok: true, balance: 96, delta: -4 }, entry: { id: 'm1', kind: 'photo', title: body?.scene || '照片', path: '/api/public/album/m1/file', ts: 1 } }) }
    if (p === '/town/api/resident/song' && req.method === 'POST') { state.songs.push(body); return send(res, 200, { ok: true, receipt: { ok: true, balance: 94, delta: -2 }, entry: { kind: 'song', title: body?.title } }) }
    if (p === '/town/api/resident/album' && req.method === 'GET') return send(res, 200, ALBUM)
    if (p === '/town/api/resident/bless' && req.method === 'POST') { state.blesses.push(body); return send(res, 200, { ok: true, blessId: 'bl1' }) }
    if (p === '/town/api/resident/rps' && req.method === 'POST') { state.rps.push(body); return send(res, 200, { ok: true, result: 'win', stake: 5, balance: 105 }) }
    if (p === '/town/api/resident/dice' && req.method === 'POST') { state.dice.push(body); return send(res, 200, { ok: true, you: 5, opp: 3, result: 'win', balance: 105 }) }
    if (p === '/town/api/resident/lottery' && req.method === 'POST') { state.lottery++; return send(res, 200, { ok: true, win: true, bonus: 20, balance: 125 }) }
    return send(res, 404, { ok: false, error: 'NOT_OPEN', code: 'NOT_OPEN', reason: 'no route ' + p })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { base: `http://127.0.0.1:${port}/town/api/resident/`, report: async () => (await fetch(`http://127.0.0.1:${port}/stub/report`)).json(), close: () => new Promise((r) => server.close(r)) }
}
async function waitFor(fn, ms = 25_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150) } throw new Error('timed out waiting') }
const herModel = async ({ history }) => { const last = history[history.length - 1]?.text || ''; return last.includes('该你自己拿主意') ? JSON.stringify({ action: 'none', next_wake: 30 }) : '{}' }

test('P3.5 round trip: media / bless / minigames against the resident stub', { timeout: 60_000 }, async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const stub = await startStub()
  process.env.DSH_HOME = join(WORK, 'home')
  const host = createFakeHost({ model: herModel })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: CODE, base: stub.base, eventsEverySeconds: 30, answerWithinSeconds: 20 })
  try {
    await waitFor(async () => (await stub.report()).answers[0])

    // 媒体：工具 + 命令
    assert.match(await host.callTool('fishbowl_town_media', { action: 'photo', scene: '海边' }), /拍了一张照片「海边」/)
    assert.match(await host.callTool('fishbowl_town_media', { action: 'song', title: '晴天' }), /点了歌「晴天」/)
    assert.match(await host.callTool('fishbowl_town_media', { action: 'album' }), /你的相册（2 项/)
    assert.match((await host.runCommand('town', 'photo 码头')).text, /拍了一张照片「码头」/)
    assert.match((await host.runCommand('town', 'song 小星星')).text, /点了歌「小星星」/)
    assert.match((await host.runCommand('town', 'album')).text, /\[照片\] 码头日落/)

    // 夸夸 + 小游戏
    assert.match((await host.runCommand('town', 'bless 今天也辛苦啦')).text, /在夸夸群说了：「今天也辛苦啦」/)
    assert.match((await host.runCommand('town', 'rps 石头')).text, /猜拳：你出石头，赢了（押注 5 鱼币），余额 105 鱼币/)
    assert.match((await host.runCommand('town', 'dice')).text, /掷骰子：你 5，对手 3，赢了，余额 105 鱼币/)
    assert.match((await host.runCommand('town', 'lottery')).text, /抽奖中奖啦！得到 20 鱼币，余额 125 鱼币/)

    const rep = await stub.report()
    assert.deepEqual(rep.photos, [{ scene: '海边' }, { scene: '码头' }])
    assert.deepEqual(rep.songs, [{ title: '晴天' }, { title: '小星星' }])
    assert.deepEqual(rep.blesses, [{ text: '今天也辛苦啦' }])
    assert.deepEqual(rep.rps, [{ choice: 'rock' }])
    assert.equal(rep.dice.length, 1)
    assert.equal(rep.lottery, 1)

    // 小镇会话零工具、只带人设；媒体工具挂在主人聊天 + 她的「心思」里
    const townSessions = [...host.sessions.values()].filter((s) => /^鱼缸小镇/.test(s.title))
    assert.ok(townSessions.length >= 1)
    for (const s of townSessions) assert.equal(s.preset, 'fishbowl-town', s.title)
    const mind = townSessions.find((s) => s.title === '鱼缸小镇 · 心思')
    assert.ok(mind)
    assert.ok(mind.agent.denied.includes('fishbowl_town_go'))
    assert.ok(!mind.agent.denied.includes('fishbowl_town_media'), 'media tool available in her decision session')
    for (const s of townSessions) if (s !== mind) assert.ok(s.agent.denied.includes('fishbowl_town_media'), `town session ${s.title} sees no tools`)
    assert.ok(host.tools.has('fishbowl_town_media'))
  } finally {
    await host.dispose()
    await stub.close()
  }
})
