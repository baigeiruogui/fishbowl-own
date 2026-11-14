import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  P3_TOOL_NAMES,
  p3FailText,
  renderSocial,
  renderGift,
  renderPhoneInbox,
  renderPhoneSend,
  renderRelations,
  renderFriend,
  renderCourts,
  renderCase,
  createP3Serve,
  createP3Tools,
  runP3Command,
} from '../lib/p3-tools.js'
import { CHAT_TOOL_NAMES } from '../lib/chat-tools.js'
import { TownError } from '../lib/town-client.js'

const SOCIAL = { ok: true, currency: '鱼币', budget: 50, used: 12, remaining: 38 }
const PHONE = { ok: true, messages: [{ id: 1, fromFishId: 'f_whale', toFishId: 'f_me', text: '晚上来码头吗？', ts: 1794000000, readAt: null }] }
const RELATIONS = { ok: true, relations: [{ fishId: 'f_whale', name: '阿鲸', since: 1794000000, kind: 'friend' }], friendCount: 1 }
const COURTS = { ok: true, cases: [{ id: 'case_1', kind: 'civil', state: 'hearing', plaintiff: 'f_me', defendant: 'f_whale', desc: '借的海藻面没还', verdict: null, evidenceCount: 2, voteCount: 0 }] }
const CASE = { ok: true, case: { id: 'case_1', kind: 'civil', state: 'verdict', plaintiff: 'f_me', defendant: 'f_whale', desc: '借的海藻面没还', evidence: [{ by: 'f_me', text: '有借条', ts: 1 }], votes: [{ jurorFishId: 'f_a', guilty: true, ts: 2 }, { jurorFishId: 'f_b', guilty: true, ts: 3 }], verdict: 'guilty', compensation: 20, paid: true, payoutNote: null, createdAt: 1, updatedAt: 4 } }

function fakeLive(overrides = {}) {
  const calls = []
  const client = {
    social: async () => { calls.push(['social']); return SOCIAL },
    socialGift: async (b) => { calls.push(['socialGift', b]); return { ok: true, receipt: { ok: true, code: 'OK', where: 'social', balance: 88, delta: -(b.price || 10) }, gift: { ref: 'g1', toFishId: 'f_whale', item: b.item, price: b.price, balance: 88, usedToday: 12 + (b.price || 10), budget: 50 } } },
    phone: async () => { calls.push(['phone']); return PHONE },
    phoneSend: async (b) => { calls.push(['phoneSend', b]); return { ok: true, message: { id: 2, fromFishId: 'f_me', toFishId: 'f_whale', text: b.text, ts: 1794000100, readAt: null } } },
    relations: async () => { calls.push(['relations']); return RELATIONS },
    addFriend: async (b) => { calls.push(['addFriend', b]); return { ok: true, friend: { a: 'f_me', b: 'f_whale', created: true, since: 1794000200 }, name: '阿鲸' } },
    courts: async () => { calls.push(['courts']); return COURTS },
    court: async (id) => { calls.push(['court', id]); return CASE },
    ...overrides,
  }
  return { calls, live: () => ({ client }) }
}
const journal = () => { const j = []; return { j, event: (kind, text) => j.push({ kind, text }) } }

test('renderers read the P3 town shapes plainly', () => {
  assert.match(renderSocial(SOCIAL), /今天的社交预算 50 鱼币 · 已用 12 · 还能花 38/)
  assert.match(renderGift({ gift: { item: '海藻面', price: 10, balance: 88, usedToday: 22, budget: 50 }, receipt: { balance: 88 } }, { to: '阿鲸' }), /送了阿鲸「海藻面」，花了 10 鱼币，余额 88 鱼币，今天社交已用 22\/50 鱼币/)
  assert.match(renderPhoneInbox(PHONE, { nameOf: (id) => (id === 'f_whale' ? '阿鲸' : '') }), /阿鲸：晚上来码头吗？（未读）/)
  assert.match(renderPhoneSend({ message: { text: '晚上见', toFishId: 'f_whale' } }, { to: '阿鲸' }), /给阿鲸发了：「晚上见」/)
  assert.match(renderRelations(RELATIONS), /她的好友（1 个）：\n- 阿鲸/)
  assert.match(renderFriend({ friend: { created: false }, name: '阿鲸' }), /本来就是好友/)
  assert.match(renderCourts(COURTS), /\[case_1\] civil：借的海藻面没还（举证中；举证 2、投票 0）/)
  const c = renderCase(CASE)
  assert.match(c, /案件 \[case_1\]：civil · 已判决/)
  assert.match(c, /举证：\n- f_me：有借条/)
  assert.match(c, /投票：2 票，其中有罪 2、无罪 0/)
  assert.match(c, /判决：有罪，赔付 20 鱼币（已赔付）/)
})

test('her tools: send a gift, read the phone inbox, send a phone message', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const p3 = createP3Serve({ live, journal: jr })
  const tools = Object.fromEntries(createP3Tools({ p3 }).map((t) => [t.name, t]))
  for (const n of P3_TOOL_NAMES) assert.ok(tools[n], n)
  assert.match(await tools.fishbowl_town_gift.execute({ to: '阿鲸', item: '海藻面', price: 10, words: '谢谢你' }), /送了阿鲸「海藻面」，花了 10 鱼币/)
  assert.match(await tools.fishbowl_town_phone.execute({ action: 'inbox' }), /你的小手机（1 条/)
  assert.match(await tools.fishbowl_town_phone.execute({ action: 'send', to: '阿鲸', text: '晚上见' }), /给阿鲸发了：「晚上见」/)
  assert.deepEqual(calls.filter((c) => c[0] !== 'phone' && c[0] !== 'relations'), [['socialGift', { to: '阿鲸', item: '海藻面', price: 10, words: '谢谢你' }], ['phoneSend', { to: '阿鲸', text: '晚上见' }]])
  assert.ok(jr.j.every((e) => e.text.startsWith('你自己')))
})

test('owner commands: /town gift | social | phone | friends | friend | court', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const p3 = createP3Serve({ live, journal: jr })
  assert.match((await runP3Command('gift', '阿鲸 海藻面 10 谢谢你', { p3 })).text, /送了阿鲸「海藻面」，花了 10 鱼币/)
  assert.match((await runP3Command('social', '', { p3 })).text, /今天的社交预算/)
  assert.match((await runP3Command('phone', '', { p3 })).text, /你的小手机/)
  assert.match((await runP3Command('phone', 'send 阿鲸 晚上见', { p3 })).text, /给阿鲸发了/)
  assert.match((await runP3Command('friends', '', { p3 })).text, /她的好友/)
  assert.match((await runP3Command('friend', '阿鲸', { p3 })).text, /成了好友/)
  assert.match((await runP3Command('court', '', { p3 })).text, /小镇法庭/)
  assert.match((await runP3Command('court', 'case_1', { p3 })).text, /案件 \[case_1\]/)
  assert.equal((await runP3Command('gift', '阿鲸 海藻面', { p3 })).kind, 'error')
  assert.equal((await runP3Command('friend', '', { p3 })).kind, 'error')
  assert.equal((await runP3Command('phone', 'bogus', { p3 })).kind, 'error')
  assert.equal(await runP3Command('jobs', '', { p3 }), null, 'not a P3 verb')
  assert.ok(jr.j.every((e) => e.text.startsWith('主人让你')))
  assert.deepEqual(calls.find((c) => c[0] === 'court'), ['court', 'case_1'])
})

test('a service that is not wired yet (404 / NOT_OPEN) degrades to a plain sentence', async () => {
  const notOpen = () => { throw new TownError('NOT_OPEN', 404, '社交礼物还没开放') }
  const p3 = createP3Serve({ live: fakeLive({ social: notOpen, socialGift: notOpen, phone: notOpen, phoneSend: notOpen, relations: notOpen, addFriend: notOpen, courts: notOpen, court: notOpen }).live, journal: journal() })
  for (const [name, call] of [
    ['social', () => p3.social('owner')],
    ['gift', () => p3.gift('阿鲸', '海藻面', 10)],
    ['phone', () => p3.phoneInbox('owner')],
    ['phoneSend', () => p3.phoneSend('阿鲸', 'hi')],
    ['relations', () => p3.relations('owner')],
    ['addFriend', () => p3.addFriend('阿鲸')],
    ['courts', () => p3.courts('owner')],
    ['case', () => p3.caseDetail('case_1')],
  ]) assert.match(await call(), /还没有这一项|还没开放/, name)
  // Fastify route-missing (error='Not Found', status 404)
  const missing = () => { throw new TownError('Not Found', 404, '', 0, { error: 'Not Found', message: 'Route GET:/relations not found' }) }
  const p3b = createP3Serve({ live: fakeLive({ relations: missing }).live, journal: journal() })
  assert.match(await p3b.relations('owner'), /还没有这一项|还没开放/)
  // a genuinely missing resource is not treated as "unopened"
  assert.match(p3FailText(new TownError('NOT_FOUND', 404, 'case not found', 0, { code: 'NOT_FOUND' }), { what: '法庭' }), /没有这个法庭/)
  assert.match(p3FailText(new TownError('BAD_REQUEST', 400, 'can only message friends')), /只能给好友发消息/)
  assert.match(p3FailText(new TownError('DAY_CAP', 409, 'social budget 50 exceeded')), /社交预算/)
})

test('the P3 tools are registered for her chat and her own decisions', () => {
  for (const n of P3_TOOL_NAMES) assert.ok(CHAT_TOOL_NAMES.includes(n), n)
  assert.deepEqual(P3_TOOL_NAMES, ['fishbowl_town_gift', 'fishbowl_town_phone'])
})
