import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  P2_TOOL_NAMES,
  isNotOpen,
  p2FailText,
  renderShop,
  renderBounties,
  createP2Serve,
  createP2Tools,
  runP2Command,
} from '../lib/p2-tools.js'
import { createSelfServe } from '../lib/self-serve.js'
import { CHAT_TOOL_NAMES } from '../lib/chat-tools.js'
import { TownError } from '../lib/town-client.js'

const SHOP = { ok: true, shop: { id: 'shop_1', name: '小圆子的小店', kind: '小吃', open: true, items: [{ id: 'it_1', name: '海藻面', price: 12, stock: 5 }] } }
const BOUNTIES = { ok: true, bounties: [{ id: 'b_1', title: '找回走丢的猫', desc: '在码头', reward: 30, state: 'open' }, { id: 'b_2', title: '写一首歌', reward: 12, state: 'done' }] }

function fakeLive(overrides = {}) {
  const calls = []
  const client = {
    shopMine: async () => { calls.push(['shopMine']); return SHOP },
    shopOpen: async (b) => { calls.push(['shopOpen', b]); return { ok: true, shop: { id: 'shop_1', name: b.name, kind: b.kind || null, open: true, items: [] }, receipt: { ok: true, balance: 100 } } },
    shopStock: async (b) => { calls.push(['shopStock', b]); return { ok: true, item: { id: 'it_2', name: b.item, price: b.price, stock: b.stock }, receipt: { ok: true, balance: 100 } } },
    shopClose: async () => { calls.push(['shopClose']); return { ok: true, receipt: { ok: true, balance: 100 } } },
    bounties: async () => { calls.push(['bounties']); return BOUNTIES },
    bountyTake: async (b) => { calls.push(['bountyTake', b]); return { ok: true, bounty: { id: b.bounty_id, title: '找回走丢的猫', reward: 30, state: 'taken' }, receipt: { ok: true, balance: 100 } } },
    bountyClaim: async (b) => { calls.push(['bountyClaim', b]); return { ok: true, bounty: { id: b.bounty_id, title: '找回走丢的猫', reward: 30, state: 'done' }, receipt: { ok: true, balance: 130, delta: 30 } } },
    bountyPost: async (b) => { calls.push(['bountyPost', b]); return { ok: true, bounty: { id: 'b_3', title: b.title, reward: b.reward, state: 'open' } } },
    ...overrides,
  }
  return { calls, live: () => ({ client }) }
}
const selfServe = {
  lookFor: async (who) => `大厅（${who}）：狼人杀、海龟汤`,
  table: async (id) => `坐进 [${id}] 那一桌`,
  play: async (g) => `开了一桌${g}`,
  visit: async (n) => `去敲${n}的门了`,
}
const journal = () => { const j = []; return { j, event: (kind, text) => j.push({ kind, text }) } }

test('renderShop / renderBounties read the town shapes plainly', () => {
  const shop = renderShop(SHOP)
  assert.match(shop, /你的店「小圆子的小店」（小吃）：营业中/)
  assert.match(shop, /海藻面：12 鱼币，库存 5（it_1）/)
  assert.match(renderShop(null), /你还没有开店/)
  const b = renderBounties(BOUNTIES)
  assert.match(b, /\[b_1\] 找回走丢的猫：赏金 30 鱼币（待接）——在码头/)
  assert.match(b, /\[b_2\] 写一首歌：赏金 12 鱼币（已完成）/)
  assert.match(renderBounties([]), /悬赏板这会儿是空的/)
})

test('404 / NOT_OPEN / route-missing / network become plain words (never throw)', () => {
  assert.equal(isNotOpen(new TownError('NOT_OPEN', 404, '还没开放')), true)
  assert.equal(isNotOpen(new TownError('Not Found', 404, '', 0, { error: 'Not Found', message: 'Route GET:/shop/mine not found' })), true)
  assert.equal(isNotOpen(new TownError('TOWN_NOT_FOUND', 404, '', 0, { code: 'NOT_FOUND' })), false, 'a missing bounty is not an unopened feature')
  assert.equal(isNotOpen(new TownError('NETWORK')), false)
  assert.match(p2FailText(new TownError('NOT_OPEN', 404, '还没开放'), { what: '开店' }), /这个小镇还没开放开店（等新版小镇就能用了）/)
  assert.match(p2FailText(new TownError('INSUFFICIENT', 409)), /余额不够/)
  assert.match(p2FailText(new TownError('TOWN_NOT_FOUND', 404, 'bounty not found', 0, { code: 'NOT_FOUND' }), { what: '悬赏' }), /没有这个悬赏/)
  assert.match(p2FailText(new TownError('NETWORK')), /还没连上小镇/)
})

test('shop: open / add / list / close via her tools, journalled as hers', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const p2 = createP2Serve({ live, journal: jr, selfServe })
  const tools = Object.fromEntries(createP2Tools({ p2 }).map((t) => [t.name, t]))
  assert.match(await tools.fishbowl_town_shop.execute({ action: 'open', name: '小圆子的小店', kind: '小吃' }), /开了家店「小圆子的小店」/)
  assert.match(await tools.fishbowl_town_shop.execute({ action: 'add', item: '海藻面', price: 12, stock: 5 }), /上架了「海藻面」：12 鱼币，库存 5/)
  assert.match(await tools.fishbowl_town_shop.execute({ action: 'list' }), /你的店「小圆子的小店」/)
  assert.match(await tools.fishbowl_town_shop.execute({ action: 'close' }), /歇业了/)
  assert.deepEqual(calls.filter((c) => c[0] !== 'shopMine'), [['shopOpen', { name: '小圆子的小店', kind: '小吃' }], ['shopStock', { item: '海藻面', price: 12, stock: 5 }], ['shopClose']])
  assert.ok(jr.j.every((e) => e.text.startsWith('你自己')))
})

test('shop add validates price/stock and refuses garbage', async () => {
  const { live } = fakeLive()
  const p2 = createP2Serve({ live, journal: journal(), selfServe })
  assert.match(await p2.shopAdd('海藻面', 'abc', 5), /用法：\/town shop add/)
  assert.match(await p2.shopAdd('海藻面', 0, 5), /价至少 1 鱼币/)
  assert.match(await p2.shopAdd('海藻面', 12, -1), /库存不能是负数/)
})

test('bounty: list / take / claim / post; claim reports the earned fish coins', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const p2 = createP2Serve({ live, journal: jr, selfServe })
  const tools = Object.fromEntries(createP2Tools({ p2 }).map((t) => [t.name, t]))
  assert.match(await tools.fishbowl_town_bounty.execute({ action: 'list' }), /找回走丢的猫/)
  assert.match(await tools.fishbowl_town_bounty.execute({ action: 'take', id: 'b_1' }), /接了悬赏「找回走丢的猫」（赏金 30 鱼币）/)
  const claim = await tools.fishbowl_town_bounty.execute({ action: 'claim', id: 'b_1', evidence: '猫找到了' })
  assert.match(claim, /交了悬赏「找回走丢的猫」，领到 30 鱼币/)
  assert.match(claim, /余额 130 鱼币/)
  assert.match(await tools.fishbowl_town_bounty.execute({ action: 'post', title: '找回小猫', reward: 25 }), /发布了悬赏「找回小猫」，赏金 25 鱼币/)
  assert.deepEqual(calls.filter((c) => c[0] !== 'bounties'), [['bountyTake', { bounty_id: 'b_1' }], ['bountyClaim', { bounty_id: 'b_1', evidence: '猫找到了' }], ['bountyPost', { title: '找回小猫', reward: 25 }]])
})

test('lobby tool delegates look / table / play / visit to the self-serve hall', async () => {
  const { live } = fakeLive()
  const p2 = createP2Serve({ live, journal: journal(), selfServe })
  const tools = Object.fromEntries(createP2Tools({ p2 }).map((t) => [t.name, t]))
  assert.match(await tools.fishbowl_town_lobby.execute({ action: 'look' }), /大厅（her）/)
  assert.match(await tools.fishbowl_town_lobby.execute({ action: 'table', value: 'v_boardgame_ww' }), /坐进 \[v_boardgame_ww\]/)
  assert.match(await tools.fishbowl_town_lobby.execute({ action: 'play', value: '狼人杀' }), /开了一桌狼人杀/)
  assert.match(await tools.fishbowl_town_lobby.execute({ action: 'visit', value: '阿鲸' }), /去敲阿鲸的门了/)
})

test('owner commands: /town shop … and /town bounty … (including a title with spaces)', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const p2 = createP2Serve({ live, journal: jr, selfServe })
  assert.match((await runP2Command('shop', '', { p2 })).text, /你的店「小圆子的小店」/)
  assert.match((await runP2Command('shop', 'open 我的小店', { p2 })).text, /开了家店「我的小店」/)
  assert.match((await runP2Command('shop', 'add 海藻面 12 5', { p2 })).text, /上架了「海藻面」/)
  assert.match((await runP2Command('shop', 'close', { p2 })).text, /歇业/)
  assert.match((await runP2Command('bounty', 'list', { p2 })).text, /找回走丢的猫/)
  assert.match((await runP2Command('bounty', 'take b_1', { p2 })).text, /接了悬赏/)
  assert.match((await runP2Command('bounty', 'claim b_1 找到了', { p2 })).text, /领到 30 鱼币/)
  assert.match((await runP2Command('bounty', 'post 找回 小猫 25', { p2 })).text, /发布了悬赏「找回 小猫」，赏金 25 鱼币/)
  assert.equal((await runP2Command('shop', 'add 海藻面 12', { p2 })).kind, 'error')
  assert.equal((await runP2Command('bounty', 'take', { p2 })).kind, 'error')
  assert.equal((await runP2Command('bounty', 'post 没有赏金', { p2 })).kind, 'error')
  assert.equal(await runP2Command('today', '', { p2 }), null, 'not a P2 verb')
  assert.ok(jr.j.every((e) => e.text.startsWith('主人让你')))
})

test('an unopened shop / bounty endpoint degrades to a plain sentence, no throw', async () => {
  const notOpen = () => { throw new TownError('NOT_OPEN', 404, '还没开放') }
  const p2 = createP2Serve({ live: fakeLive({ shopMine: notOpen, bounties: notOpen }).live, journal: journal(), selfServe })
  assert.match(await p2.shopList('owner'), /这个小镇还没开放开店/)
  assert.match(await p2.bountyList('owner'), /这个小镇还没开放悬赏板/)
  // a route missing entirely (Fastify 'Not Found')
  const missing = () => { throw new TownError('Not Found', 404, '', 0, { error: 'Not Found', message: 'Route POST:/shop/open not found' }) }
  const p2b = createP2Serve({ live: fakeLive({ shopOpen: missing }).live, journal: journal(), selfServe })
  assert.match(await p2b.shopOpen('小店'), /这个小镇还没开放开店/)
})

test('self-serve lobby/play/visit handle the server NOT_OPEN receipt without pretending it worked', async () => {
  const client = {
    lobby: async () => ({ games: [{ game: 'werewolf', game_zh: '狼人杀' }], tables: [], activities: [], places: [], fish: [], mine: { signups: [] } }),
    play: async () => ({ ok: false, code: 'NOT_OPEN', reason: '牌桌将在新版开放' }),
    visit: async () => ({ ok: false, code: 'NOT_OPEN', reason: '串门暂未开放，等新版' }),
  }
  const ss = createSelfServe({ live: () => ({ client }), journal: journal() })
  assert.match(await ss.play('狼人杀', 'owner'), /这个小镇还没开放牌桌 \/ 开一局（牌桌将在新版开放）/)
  assert.match(await ss.table('v_boardgame_ww', 'owner'), /这个小镇还没开放牌桌（牌桌将在新版开放）/)
  assert.match(await ss.visit('阿鲸', 'owner'), /这个小镇还没开放串门（串门暂未开放，等新版）/)
})

test('the P2 tools are registered for her chat and her own decisions', () => {
  for (const n of P2_TOOL_NAMES) assert.ok(CHAT_TOOL_NAMES.includes(n), n)
  assert.deepEqual(P2_TOOL_NAMES, ['fishbowl_town_shop', 'fishbowl_town_bounty', 'fishbowl_town_lobby'])
})
