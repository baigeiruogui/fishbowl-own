import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  P35_TOOL_NAMES,
  p35FailText,
  renderAlbum,
  renderPhoto,
  renderSong,
  renderBless,
  renderRps,
  renderDice,
  renderLottery,
  createP35Serve,
  createP35Tools,
  runP35Command,
} from '../lib/p35-tools.js'
import { CHAT_TOOL_NAMES } from '../lib/chat-tools.js'
import { TownError } from '../lib/town-client.js'

const ALBUM = { ok: true, items: [{ id: 'm1', kind: 'photo', title: '码头日落', path: '/api/public/album/m1/file', ts: 1794000000 }, { id: 'm2', kind: 'song', title: '晴天', ts: 1794000100 }] }

function fakeLive(overrides = {}) {
  const calls = []
  const client = {
    photo: async (b) => { calls.push(['photo', b]); return { ok: true, receipt: { ok: true, balance: 96, delta: -4 }, entry: { id: 'm1', kind: 'photo', title: b.scene || '照片', path: '/api/public/album/m1/file', ts: 1 } } },
    song: async (b) => { calls.push(['song', b]); return { ok: true, receipt: { ok: true, balance: 94, delta: -2 }, entry: { kind: 'song', title: b.title } } },
    album: async () => { calls.push(['album']); return ALBUM },
    bless: async (b) => { calls.push(['bless', b]); return { ok: true, blessId: 'bl1' } },
    rps: async (b) => { calls.push(['rps', b]); return { ok: true, result: 'win', stake: 5, balance: 105 } },
    dice: async (b) => { calls.push(['dice', b]); return { ok: true, you: 5, opp: 3, result: 'win', balance: 105 } },
    lottery: async (b) => { calls.push(['lottery', b]); return { ok: true, win: true, bonus: 20, balance: 125 } },
    ...overrides,
  }
  return { calls, live: () => ({ client }) }
}
const journal = () => { const j = []; return { j, event: (kind, text) => j.push({ kind, text }) } }

test('renderers read the P3.5 shapes plainly', () => {
  assert.match(renderAlbum(ALBUM), /你的相册（2 项，新的在前）：\n- \[照片\] 码头日落（\/api\/public\/album\/m1\/file）\n- \[歌\] 晴天/)
  assert.match(renderPhoto({ receipt: { balance: 96 }, entry: { title: '码头日落', path: '/x.svg' } }, { scene: '码头' }), /拍了一张照片「码头」：码头日落（存在 \/x\.svg），余额 96 鱼币/)
  assert.match(renderSong({ receipt: { balance: 94 }, entry: { title: '晴天' } }, { title: '晴天' }), /点了歌「晴天」，余额 94 鱼币/)
  assert.match(renderBless({ text: '今天也辛苦啦' }, { text: '今天也辛苦啦' }), /在夸夸群说了：「今天也辛苦啦」/)
  assert.match(renderRps({ result: 'win', stake: 5, balance: 105 }, { choice: 'rock' }), /猜拳：你出石头，赢了（押注 5 鱼币），余额 105 鱼币/)
  assert.match(renderDice({ you: 5, opp: 3, result: 'lose', balance: 100 }), /掷骰子：你 5，对手 3，输了，余额 100 鱼币/)
  assert.match(renderLottery({ win: true, bonus: 20, balance: 125 }), /抽奖中奖啦！得到 20 鱼币，余额 125 鱼币/)
  assert.match(renderLottery({ win: false, bonus: 0, balance: 100 }), /抽奖没中，明天再来，余额 100 鱼币/)
})

test('her media tool: photo / song / album', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const p35 = createP35Serve({ live, journal: jr })
  const tools = Object.fromEntries(createP35Tools({ p35 }).map((t) => [t.name, t]))
  assert.match(await tools.fishbowl_town_media.execute({ action: 'photo', scene: '码头' }), /拍了一张照片「码头」/)
  assert.match(await tools.fishbowl_town_media.execute({ action: 'song', title: '晴天' }), /点了歌「晴天」/)
  assert.match(await tools.fishbowl_town_media.execute({ action: 'album' }), /你的相册/)
  assert.deepEqual(calls, [['photo', { scene: '码头' }], ['song', { title: '晴天' }], ['album']])
  assert.ok(jr.j.every((e) => e.text.startsWith('你自己')))
})

test('owner commands: /town photo | song | album | bless | rps | dice | lottery', async () => {
  const { calls, live } = fakeLive()
  const jr = journal()
  const p35 = createP35Serve({ live, journal: jr })
  assert.match((await runP35Command('photo', '海边', { p35 })).text, /拍了一张照片「海边」/)
  assert.match((await runP35Command('song', '晴天', { p35 })).text, /点了歌「晴天」/)
  assert.match((await runP35Command('album', '', { p35 })).text, /你的相册/)
  assert.match((await runP35Command('bless', '今天也辛苦啦', { p35 })).text, /在夸夸群说了：「今天也辛苦啦」/)
  assert.match((await runP35Command('rps', '石头', { p35 })).text, /猜拳：你出石头，赢了/)
  assert.match((await runP35Command('dice', '', { p35 })).text, /掷骰子/)
  assert.match((await runP35Command('lottery', '', { p35 })).text, /抽奖/)
  assert.equal((await runP35Command('bless', '', { p35 })).kind, 'error')
  assert.equal((await runP35Command('rps', '锤子', { p35 })).kind, 'error')
  assert.equal(await runP35Command('court', '', { p35 }), null, 'not a P3.5 verb')
  assert.ok(jr.j.every((e) => e.text.startsWith('主人让你')))
  assert.deepEqual(calls.find((c) => c[0] === 'rps'), ['rps', { choice: 'rock' }])
})

test('official-style album (item_id) is left to the existing extras renderer', async () => {
  const official = { ok: true, items: [{ item_id: 'al_00000000000000a1', kind: 'photo', what: '普通照（合影）' }] }
  const { live } = fakeLive({ album: async () => official })
  const p35 = createP35Serve({ live, journal: journal() })
  assert.equal(await runP35Command('album', '', { p35 }), null)
})

test('not wired / insufficient / route-missing become plain words, never throw', async () => {
  const notOpen = () => { throw new TownError('NOT_OPEN', 404, '还没开放') }
  const p35 = createP35Serve({ live: fakeLive({ photo: notOpen, song: notOpen, album: notOpen, bless: notOpen, rps: notOpen, dice: notOpen, lottery: notOpen }).live, journal: journal() })
  for (const [name, call] of [
    ['photo', () => p35.photo('海边')],
    ['song', () => p35.song('晴天')],
    ['album', () => p35.album()],
    ['bless', () => p35.bless('好话')],
    ['rps', () => p35.rps('rock')],
    ['dice', () => p35.dice()],
    ['lottery', () => p35.lottery()],
  ]) assert.match(await call(), /还没有这一项/, name)
  assert.match(p35FailText(new TownError('INSUFFICIENT', 409, 'stake 5 > balance 3')), /余额不够/)
  assert.match(p35FailText(new TownError('DAY_CAP', 409, '已经抽过了')), /次数用完了/)
  assert.match(p35FailText(new TownError('NOT_FOUND', 404, 'no such entry', 0, { code: 'NOT_FOUND' }), { what: '照片' }), /没有这个照片/)
  // album command on an unopened service also degrades (never throws)
  assert.match((await runP35Command('album', '', { p35 })).text, /还没有这一项/)
})

test('the media tool is registered for her chat and her own decisions', () => {
  for (const n of P35_TOOL_NAMES) assert.ok(CHAT_TOOL_NAMES.includes(n), n)
  assert.deepEqual(P35_TOOL_NAMES, ['fishbowl_town_media'])
})
