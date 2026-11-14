import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EARN_TOOL_NAMES,
  renderJobs,
  renderMarket,
  renderVault,
  pickOffer,
  pickCatch,
  earnFailText,
  createEarnServe,
  createEarnTools,
  runEarnCommand,
} from '../lib/earn.js'
import { CHAT_TOOL_NAMES } from '../lib/chat-tools.js'
import { TownError, DEFAULT_BASE } from '../lib/town-client.js'

const JOBS = {
  jobs: [
    { id: 'job_1', title: '码头帮工', pay: 20, durationMin: 60, slots: 2, taken: 0, available: 2, place: 'pier' },
    { id: 'job_2', title: '咖啡店', pay: 12, durationMin: 30, slots: 1, taken: 1, available: 0 },
  ],
  mine: [{ id: 'jc_old', title: '书店', pay: 10, state: 'working', endsAt: Date.now() + 10 * 60_000 }],
}
const MARKET = {
  items: [{ item: '小鱼', price: 5, owned: 3 }, { item: '鲤鱼', price: 12, owned: 0 }],
  catch: [{ id: 'catch_1', item: '小鱼', qty: 3, ts: 1 }],
}

function fakeLive(overrides = {}) {
  const calls = []
  const client = {
    jobs: async () => { calls.push(['jobs']); return JOBS },
    takeJob: async (b) => { calls.push(['takeJob', b]); return { ok: true, contract: { id: 'jc_new', title: '码头帮工', pay: 20, endsAt: Date.now() + 3600_000, state: 'working' }, receipt: { ok: true, balance: 105, delta: 0 } } },
    quitJob: async (b) => { calls.push(['quitJob', b]); return { ok: true, contract: { id: b.contract_id, state: 'quit' }, receipt: { ok: true, balance: 100 } } },
    market: async () => { calls.push(['market']); return MARKET },
    sell: async (b) => { calls.push(['sell', b]); const qty = b.qty || 3; return { ok: true, sale: { item: b.item || '小鱼', qty, price: 5, amount: 5 * qty, balance: 100 + 5 * qty }, receipt: { ok: true, delta: 5 * qty, balance: 100 + 5 * qty } } },
    status: async () => ({ ok: true, balance: 115, earned_today: 15, spent_today: 5, day_cap: null }),
    ...overrides,
  }
  return { calls, live: () => ({ client }) }
}
const journal = () => { const j = []; return { j, event: (kind, text) => j.push({ kind, text }) } }

test('renderJobs shows open jobs, the ones she already took and their settlement', () => {
  const out = renderJobs(JOBS)
  assert.match(out, /你已经接的活/)
  assert.match(out, /\[jc_old\] 书店：10 鱼币，在干（约 \d+ 分钟后完）/)
  assert.match(out, /码头帮工（job_1）：20 鱼币，60 分钟，在 pier，还缺 2 人/)
  assert.match(out, /咖啡店（job_2）：12 鱼币，30 分钟，还缺 0 人/)
})

test('renderMarket lists her catch and the market prices', () => {
  const out = renderMarket(MARKET)
  assert.match(out, /你手上的鱼获/)
  assert.match(out, /小鱼 × 3（catch_1）/)
  assert.match(out, /市场价：小鱼 5 鱼币（你有 3）、鲤鱼 12 鱼币/)
  assert.match(renderMarket({ items: [], catch: [] }), /还没有鱼获/)
})

test('renderVault: balance and today earned / spent in fish coins', () => {
  assert.equal(renderVault({ balance: 115, earned_today: 15, spent_today: 5 }), '余额 115 鱼币 · 今日赚 15 鱼币 · 今日花 5 鱼币')
  assert.equal(renderVault({ piggy_yuan: 100, spent_today: 0 }), '余额 100 鱼币 · 今日赚 — · 今日花 0 鱼币')
  assert.match(renderVault({ balance: 10, earned_today: 1, spent_today: 2, day_cap: 50 }), /每日上限 50 鱼币/)
  assert.equal(renderVault(null), '')
})

test('pickOffer and pickCatch resolve by id, exact name and substring', () => {
  assert.equal(pickOffer(JOBS, 'job_1').id, 'job_1')
  assert.equal(pickOffer(JOBS, '码头帮工').id, 'job_1')
  assert.equal(pickOffer(JOBS, '咖啡').id, 'job_2')
  assert.equal(pickOffer(JOBS, '不存在'), null)
  assert.equal(pickCatch(MARKET, 'catch_1').id, 'catch_1')
  assert.equal(pickCatch(MARKET, '小鱼').id, 'catch_1')
  assert.equal(pickCatch(MARKET, '鲤鱼'), null)
})

test('her earning tools: look at jobs, take one, see market, sell her catch', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const earn = createEarnServe({ live, journal: jr })
  const tools = Object.fromEntries(createEarnTools({ earnServe: earn }).map((t) => [t.name, t]))
  for (const n of EARN_TOOL_NAMES) assert.ok(tools[n], n)

  assert.match(await tools.fishbowl_town_jobs.execute({}), /码头帮工/)
  const take = await tools.fishbowl_town_work.execute({ job: '码头帮工' })
  assert.match(take, /接了「码头帮工」，工钱 20 鱼币，60 分钟后结算/)
  assert.match(take, /余额 105 鱼币/)
  assert.match(await tools.fishbowl_town_market.execute({}), /市场价/)
  const sell = await tools.fishbowl_town_sell.execute({ item: '小鱼', qty: 2 })
  assert.match(sell, /卖了 小鱼×2，得了 10 鱼币/)
  assert.match(sell, /余额 110 鱼币/)

  const acts = calls.filter((c) => c[0] !== 'jobs' && c[0] !== 'market')
  assert.deepEqual(acts, [['takeJob', { offer_id: 'job_1' }], ['sell', { item: '小鱼', qty: 2 }]])
  assert.ok(jr.j.some((e) => e.text.startsWith('你自己接了')))
  assert.ok(jr.j.some((e) => e.text.startsWith('你自己卖了')))
})

test('selling with no item sells everything she holds and totals the fish coins', async () => {
  const { calls, live } = fakeLive()
  const earn = createEarnServe({ live, journal: journal() })
  const out = await earn.sell('', undefined, 'owner')
  assert.match(out, /把鱼获全卖了：小鱼×3（15 鱼币），一共 15 鱼币/)
  assert.deepEqual(calls.filter((c) => c[0] === 'sell'), [['sell', { item: '小鱼' }]])
})

test('owner earning commands: /town jobs | work | quit | market | sell', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const earn = createEarnServe({ live, journal: jr })
  assert.match((await runEarnCommand('jobs', '', { earn })).text, /码头帮工/)
  assert.match((await runEarnCommand('work', '咖啡', { earn })).text, /接了「码头帮工」/)
  assert.match((await runEarnCommand('quit', 'jc_old', { earn })).text, /辞了 \[jc_old\]/)
  assert.match((await runEarnCommand('market', '', { earn })).text, /市场价/)
  assert.match((await runEarnCommand('sell', '小鱼 2', { earn })).text, /卖了 小鱼×2/)
  assert.equal((await runEarnCommand('work', '', { earn })).kind, 'error')
  assert.equal((await runEarnCommand('quit', '', { earn })).kind, 'error')
  assert.equal(await runEarnCommand('today', '', { earn }), null, 'not an earning verb')
  assert.ok(jr.j.every((e) => e.text.startsWith('主人让你')))
  assert.deepEqual(calls.find((c) => c[0] === 'quitJob'), ['quitJob', { contract_id: 'jc_old' }])
})

test('earning errors become plain words and never throw; no top-up link (self-hosted fish coins)', async () => {
  assert.match(earnFailText(new TownError('ALREADY_WORKING', 409, '手上还有一份')), /已经有一份活/)
  assert.match(earnFailText(new TownError('NO_SLOTS', 409)), /招满了/)
  assert.match(earnFailText(new TownError('INSUFFICIENT', 409)), /余额不够/)
  assert.match(earnFailText(new TownError('NOT_FOUND', 404)), /没有这个/)
  assert.match(earnFailText(new TownError('CONTRACT_CLOSED', 409)), /已经结束或辞过了/)
  for (const e of ['ALREADY_WORKING', 'NO_SLOTS', 'INSUFFICIENT', 'NOT_FOUND', 'CONTRACT_CLOSED']) {
    assert.doesNotMatch(earnFailText(new TownError(e, 409)), /充值|afdian/)
  }
  const { live } = fakeLive({ takeJob: async () => { throw new TownError('ALREADY_WORKING', 409, '手上还有一份') } })
  const earn = createEarnServe({ live, journal: journal() })
  assert.match(await earn.work('码头帮工', 'her'), /已经有一份活/)
  const off = createEarnServe({ live: () => null, journal: journal() })
  assert.match(await off.jobs('her'), /没在小镇值班/)
})

test('the earning tools are registered for her chat and for her own decisions', () => {
  for (const n of EARN_TOOL_NAMES) assert.ok(CHAT_TOOL_NAMES.includes(n), n)
  assert.deepEqual(EARN_TOOL_NAMES, ['fishbowl_town_jobs', 'fishbowl_town_work', 'fishbowl_town_market', 'fishbowl_town_sell'])
})

test('the default base points at the self-hosted resident api', () => {
  assert.match(DEFAULT_BASE, /\/town\/api\/resident\/$/)
  assert.doesNotMatch(DEFAULT_BASE, /outside/)
})
