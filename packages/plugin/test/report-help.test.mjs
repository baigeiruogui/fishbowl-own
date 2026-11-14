// t54：/town report（举报，未实现则友好提示）+ /town help（列出全部命令）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSelfServe, runTownCommand } from '../lib/self-serve.js'
import { TownError } from '../lib/town-client.js'
import { createFakeHost } from './fake-dsh-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'report-help')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const journal = () => { const j = []; return { j, event: (kind, text) => j.push({ kind, text }) } }
const status = async () => ''

function fakeLive(overrides = {}) {
  const calls = []
  const client = { report: async (b) => { calls.push(['report', b]); return { ok: true, note: '举报已收到，镇长会看' } }, ...overrides }
  return { calls, live: () => ({ client }) }
}

test('/town report sends {to,reason} and reports success', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const ss = createSelfServe({ live, journal: jr })
  const r = await runTownCommand('report 阿鲸 在公共频道骂人', { selfServe: ss, status })
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /已举报阿鲸：在公共频道骂人（小镇说：举报已收到，镇长会看）/)
  assert.deepEqual(calls, [['report', { to: '阿鲸', reason: '在公共频道骂人' }]])
  assert.ok(jr.j.some((e) => /举报了阿鲸/.test(e.text)))
})

test('/town report on a town without the endpoint says so, never throws', async () => {
  for (const err of [new TownError('NOT_OPEN', 404, '举报还没开放'), new TownError('Not Found', 404, '', 0, { error: 'Not Found', message: 'Route POST:/report not found' })]) {
    const { live } = fakeLive({ report: async () => { throw err } })
    const ss = createSelfServe({ live, journal: journal() })
    const r = await runTownCommand('report 阿鲸 骂人', { selfServe: ss, status })
    assert.equal(r.kind, 'success')
    assert.match(r.text, /这个小镇还没有举报功能/)
  }
  const { live } = fakeLive()
  const ss = createSelfServe({ live, journal: journal() })
  assert.equal((await runTownCommand('report 阿鲸', { selfServe: ss, status })).kind, 'error')
  assert.equal((await runTownCommand('report', { selfServe: ss, status })).kind, 'error')
})

test('/town help lists every command with usage', async () => {
  const ss = createSelfServe({ live: () => null, journal: journal() })
  const help = (await runTownCommand('help', { selfServe: ss, status })).text
  for (const t of [
    '/town help', '/town report', '/town tables', '/town lobby', '/town table', '/town play', '/town cancel', '/town visit', '/town go',
    '/town shop open', '/town shop add', '/town shop list', '/town shop close',
    '/town bounty list', '/town bounty take', '/town bounty claim', '/town bounty post',
    '/town gift', '/town social', '/town phone', '/town phone send', '/town friends', '/town friend',
    '/town court', '/town photo', '/town song', '/town album', '/town bless', '/town rps', '/town dice', '/town lottery',
    '/town jobs', '/town work', '/town quit', '/town market', '/town sell',
    '/town today', '/town history', '/town status', '/town week', '/town room', '/town record', '/town receipts', '/town budget', '/town look',
  ]) assert.ok(help.includes(t), 'missing help line: ' + t)
  assert.equal((help.match(/^\/town album\b/gm) || []).length, 1, 'no duplicate album line')
  // an unknown verb still shows the help
  assert.match((await runTownCommand('bogus', { selfServe: ss, status })).text, /不认识「bogus」/)
})

// HTTP stub: prove the client actually POSTs /report {to,reason} through the real plugin + fake host.
const CODE = 'fbr_' + 'rpt'.repeat(6)
function readBody(req) { return new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) } }); req.on('error', () => resolve(null)) }) }
async function startStub() {
  const reports = []
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname
    const body = req.method === 'POST' ? await readBody(req) : null
    if (p === '/stub/report') return send(res, 200, { reports })
    if (String(req.headers.authorization || '') !== 'Bearer ' + CODE) return send(res, 401, { ok: false, error: 'RESIDENT_CODE', code: 'RESIDENT_CODE', reason: 'bad code' })
    if (p === '/town/api/resident/turns') return send(res, 200, { turns: [] })
    if (p === '/town/api/resident/events') return send(res, 200, { ok: true, items: [], next: 0 })
    if (p === '/town/api/resident/status') return send(res, 200, { ok: true, fish_id: 'f1', name: '小圆子', town_name: '小圆子', state: 'active', outside_state: 'active', balance: 100, piggy_yuan: 100 })
    if (p === '/town/api/resident/report' && req.method === 'POST') { reports.push(body); return send(res, 200, { ok: true, note: '镇长会看' }) }
    return send(res, 404, { ok: false, error: 'NOT_OPEN', code: 'NOT_OPEN', reason: 'no route ' + p })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { base: `http://127.0.0.1:${port}/town/api/resident/`, report: async () => (await fetch(`http://127.0.0.1:${port}/stub/report`)).json(), close: () => new Promise((r) => server.close(r)) }
}

test('the plugin actually POSTs /report {to,reason} (HTTP stub) and /town help works there too', { timeout: 30_000 }, async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  const stub = await startStub()
  process.env.DSH_HOME = join(WORK, 'home')
  const host = createFakeHost({ model: async () => '{}' })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: CODE, base: stub.base, eventsEverySeconds: 30 })
  try {
    const r = await host.runCommand('town', 'report 阿鲸 半夜刷屏骂人')
    assert.equal(r.kind, 'success', r.text)
    assert.match(r.text, /已举报阿鲸：半夜刷屏骂人（小镇说：镇长会看）/)
    assert.deepEqual((await stub.report()).reports, [{ to: '阿鲸', reason: '半夜刷屏骂人' }])
    const help = (await host.runCommand('town', 'help')).text
    assert.match(help, /\/town report <鱼名> <原因>/)
    assert.match(help, /\/town help/)
  } finally {
    await host.dispose()
    await stub.close()
  }
})
