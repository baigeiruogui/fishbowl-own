// t29 安全回归：F1 预设失败硬停不回退默认预设；F2 mask 失败 fail-closed（不发 followup）；
// F3 social_day_cents settings 往返不丢。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshBrain, maskDeny } from '../lib/dsh-brain.js'
import { createFakeHost } from './fake-dsh-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.dshtest', 'security')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function brainCtx({ stateDir, create }) {
  const calls = []
  const ws = { id: 'ws1', path: join(stateDir, 'room'), title: '鱼缸小镇 · 插件自用（别在这里聊天）' }
  const agents = new Map()
  const ctx = {
    get: (name) => ctx[name],
    sessionController: {
      create: async (opts) => { calls.push(opts); return create(opts) },
      rename: async () => ({ title: 'x', seq: 0 }),
      resolveAgent: async (sid) => (agents.get(sid) ? { agent: agents.get(sid) } : { error: { message: 'not found' } }),
      list: async () => ({ items: [] }),
      cancel: async () => ({ accepted: true }),
    },
    workspaceRegistry: {
      list: () => [ws],
      create: async (path, title) => ({ id: 'ws1', path, title }),
      archiveSession: async () => {},
      archivedSessionIds: [],
    },
    agents: { get: (sid) => agents.get(sid) || null },
  }
  return { ctx, calls, agents }
}

const silentLog = { error() {}, warn() {}, info() {}, debug() {} }

test('F1: a missing fishbowl-town preset hard-stops (never falls back to the default preset with tools)', async () => {
  const stateDir = join(WORK, 'f1-' + Math.random().toString(16).slice(2, 8))
  mkdirSync(stateDir, { recursive: true })
  const state = {}
  const fatal = []
  const { ctx, calls } = brainCtx({
    stateDir,
    create: async (opts) => {
      if (opts.agentPreset === 'fishbowl-town') throw new Error('preset missing')
      throw new Error('MUST NOT fallback')
    },
  })
  const brain = createDshBrain({ ctx, config: { preset: 'fishbowl-town', fastMode: false, turnsPerSession: 20 }, log: silentLog, stateDir, state, saveState: () => {}, onFatal: (m) => fatal.push(m) })
  await assert.rejects(() => brain.ask('game', '出牌', { timeoutMs: 2000 }), (e) => e && e.code === 'PRESET_FAILED')
  assert.ok(calls.length >= 1, 'it tried the preset')
  assert.equal(calls.filter((c) => !('agentPreset' in c)).length, 0, 'never fell back to a default-preset create')
  assert.ok(fatal.length >= 1, 'onFatal fired so the runner can stop')
  assert.match(state.pluginNotice.text, /绝不回退到带工具的默认预设/)
})

test('F2: when restrict throws, the turn is fail-closed — her model never gets the followup', async () => {
  const stateDir = join(WORK, 'f2-' + Math.random().toString(16).slice(2, 8))
  mkdirSync(stateDir, { recursive: true })
  const state = { sessions: { game: { sid: 's_g', turns: 0 } } }
  let followups = 0
  const { ctx, agents } = brainCtx({ stateDir, create: async () => ({ sessionId: 's_g' }) })
  agents.set('s_g', {
    id: 's_g', session: { id: 's_g' },
    ctx: { tools: { restrict() { throw new Error('unknown tool in deny list') } } },
    followup() { followups++ },
  })
  const brain = createDshBrain({ ctx, config: { preset: 'fishbowl-town', fastMode: false, turnsPerSession: 20, registeredChatTools: new Set(['fishbowl_town_go']) }, log: silentLog, stateDir, state, saveState: () => {} })
  await assert.rejects(() => brain.ask('game', '出牌', { timeoutMs: 2000 }), (e) => e && e.code === 'MASK_FAILED')
  assert.equal(followups, 0, 'no followup escaped the failed mask')
})

test('F2: the deny list is built only from actually-registered tool names', () => {
  assert.deepEqual(maskDeny('game', new Set(['fishbowl_town_go'])), ['fishbowl_town_go'])
  assert.deepEqual(maskDeny('game', new Set(['fishbowl_town_go', 'ghost_tool'])), ['fishbowl_town_go'], 'unregistered names never enter the deny list')
  assert.deepEqual(maskDeny('agency', new Set(['fishbowl_town_go', 'fishbowl_town_jobs'])), ['fishbowl_town_go'], 'her own earning tools stay available in 心思')
})

// ---------- F3：settings 往返 ----------
const CODE = 'fbr_' + 'sec'.repeat(6)
function readBody(req) {
  return new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) } }); req.on('error', () => resolve(null)) })
}
async function startSettingsStub() {
  const bodies = []
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname
    const body = req.method === 'POST' ? await readBody(req) : null
    if (p === '/stub/report') return send(res, 200, { bodies })
    if (String(req.headers.authorization || '') !== 'Bearer ' + CODE) return send(res, 401, { ok: false, error: 'RESIDENT_CODE', code: 'RESIDENT_CODE', reason: 'bad code' })
    if (p === '/town/api/resident/turns' && req.method === 'GET') return send(res, 200, { turns: [] })
    if (p === '/town/api/resident/events') return send(res, 200, { ok: true, items: [], next: 0 })
    if (p === '/town/api/resident/status') return send(res, 200, { ok: true, fish_id: 'f1', name: '小圆子', town_name: '小圆子', state: 'active', outside_state: 'active', balance: 137, piggy_yuan: 137, earned_today: 0, spent_today: 0 })
    if (p === '/town/api/resident/settings' && req.method === 'POST') {
      bodies.push(body)
      const cents = body?.social_day_cents ?? null
      return send(res, 200, { ok: true, settings: { wake_min_minutes: null, quiet_hours: null, social_day_cents: cents, social_day_cents_effective: cents }, paused: false, day_cap: null, balance: 137 })
    }
    return send(res, 404, { ok: false, error: 'NOT_OPEN', code: 'NOT_OPEN', reason: 'no route ' + p })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { base: `http://127.0.0.1:${port}/town/api/resident/`, report: async () => (await fetch(`http://127.0.0.1:${port}/stub/report`)).json(), close: () => new Promise((r) => server.close(r)) }
}

test('F3: social_day_cents round-trips through /settings and is read back into the page / budget', { timeout: 30_000 }, async () => {
  rmSync(join(WORK, 'f3'), { recursive: true, force: true })
  mkdirSync(join(WORK, 'f3'), { recursive: true })
  const stub = await startSettingsStub()
  process.env.DSH_HOME = join(WORK, 'f3', 'home')
  const host = createFakeHost({ model: async () => '{}' })
  const plugin = await import('../lib/index.js?' + Math.random())
  plugin.apply(host.ctx, { code: CODE, base: stub.base, eventsEverySeconds: 30 })
  try {
    const r = await host.runCommand('town', 'budget 1.5')
    assert.equal(r.kind, 'success', r.text)
    assert.match(r.text, /已设好/)
    assert.match(r.text, /¥1\.50/)
    const st = (await host.http('/fishbowl-town/state')).json
    assert.deepEqual(st.socialBudget, { cents: 150, effective: 150 }, JSON.stringify(st.socialBudget))
    const bodies = (await stub.report()).bodies.filter((b) => 'social_day_cents' in b)
    assert.deepEqual(bodies, [{ social_day_cents: 150 }], 'exactly the social budget was sent, nothing lost')
  } finally {
    await host.dispose()
    await stub.close()
  }
})
