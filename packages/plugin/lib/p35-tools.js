// P3.5 玩法（自建小镇）：媒体（拍照 / 点歌 / 相册）、夸夸群、小游戏（猜拳 / 掷骰子 / 抽奖）。
//
// 沿用既有 chat-tools / self-serve / p2-tools / p3-tools 架构：
//   她的工具：fishbowl_town_media（action=photo/song/album）——主人聊天 +「心思」会话都可用。
//   主人的命令（备用）：/town photo <场景>、/town song <歌名>、/town album、/town bless <话>、
//                      /town rps <石头|剪刀|布>、/town dice、/town lottery。
// dev 阶段服务端可能还没接线：404 / NOT_OPEN / TOWN_OFF 一律当「这个小镇还没有这一项」；余额不够也给人话，不抛错。
import { TownError } from './town-client.js'
import { isNotOpen } from './p2-tools.js'

export const P35_TOOL_NAMES = ['fishbowl_town_media']
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。'
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const arr = (v) => (Array.isArray(v) ? v : [])
const s = (v, n = 40) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t }
const coin = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : `${Math.round(Number(v))} 鱼币`)
const intOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)))
const KIND_ZH = { photo: '照片', song: '歌', painting: '画', paint: '画' }
const RESULT_ZH = { win: '赢了', lose: '输了', draw: '平局', tie: '平局' }
const RPS_ZH = { rock: '石头', scissors: '剪刀', paper: '布' }

/** 小镇回的错 → 一句人话（媒体/夸夸/小游戏）。 */
export function p35FailText(error, { what = '这一项' } = {}) {
  if (error?.code === 'OFF') return OFF_DUTY
  if (isNotOpen(error)) return `这个小镇还没有这一项（${what}还没开放；等新版小镇就能用了）。`
  const code = error instanceof TownError ? error.code : (error?.code || 'UNKNOWN')
  const raw = String(error?.reason || '')
  const why = raw ? `：${s(raw, 90).replace(/[。.]+$/, '')}` : ''
  if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING' || code === 'NETWORK' || /^HTTP_50[234]$/.test(code)) return '这会儿还没连上小镇（或者小镇在重启），过几秒再试一次。'
  if (code === 'TOWN_RATE_LIMITED' || code === 'RATE_LIMITED') return `小镇说太频繁了，过一会儿再试${error?.retryAfter ? `（约 ${error.retryAfter} 秒）` : ''}。`
  if (code === 'INSUFFICIENT' || code === 'TOWN_INSUFFICIENT' || error?.status === 402 || /balance|余额|stake|筹码/i.test(raw)) return `余额不够，这个玩不了${why}。`
  if (code === 'DAY_CAP' || code === 'TOWN_DAY_CAP' || /daily|每天|抽过/i.test(raw)) return `今天的次数用完了${why}。`
  if (code === 'NOT_FOUND' || code === 'TOWN_NOT_FOUND') return `小镇说没有这个${what}${why}。`
  if (code === 'BAD_REQUEST' || code === 'TOWN_BAD_REQUEST') return `小镇没接（要求不对）${why}。`
  return `小镇没接（${code}${why}）。`
}

export function renderAlbum(data) {
  const items = arr(data && data.items)
  if (!items.length) return '你的相册还是空的（/town photo <场景> 拍一张、/town song <歌名> 点一首）。'
  const out = [`你的相册（${items.length} 项，新的在前）：`]
  for (const it of items.slice(0, 20)) {
    const kind = KIND_ZH[it.kind] || it.kind || '内容'
    const title = it.title || it.what || ''
    out.push(`- [${kind}] ${s(title, 40)}${it.path ? `（${s(it.path, 60)}）` : ''}`)
  }
  return out.join('\n')
}

export function renderPhoto(r, { scene = '' } = {}) {
  const e = (r && r.entry) || {}
  const bal = intOrNull(r?.receipt?.balance ?? r?.balance)
  return `拍了一张照片${scene ? `「${s(scene, 20)}」` : ''}${e.title && e.title !== scene ? `：${s(e.title, 30)}` : ''}${e.path ? `（存在 ${s(e.path, 60)}）` : ''}${bal != null ? `，余额 ${bal} 鱼币` : ''}。`
}

export function renderSong(r, { title = '' } = {}) {
  const e = (r && r.entry) || {}
  const bal = intOrNull(r?.receipt?.balance ?? r?.balance)
  return `点了歌「${s(e.title || title, 30)}」${bal != null ? `，余额 ${bal} 鱼币` : ''}。`
}

export function renderBless(r, { text: said = '' } = {}) {
  return `在夸夸群说了：「${s(r?.text || said, 80)}」。`
}

export function renderRps(r, { choice = '' } = {}) {
  const res = RESULT_ZH[r?.result] || r?.result || ''
  const cz = RPS_ZH[choice] || choice
  const stake = intOrNull(r?.stake)
  const bal = intOrNull(r?.balance)
  return `猜拳：你出${cz}，${res}${stake ? `（押注 ${stake} 鱼币）` : ''}${bal != null ? `，余额 ${bal} 鱼币` : ''}。`
}

export function renderDice(r) {
  const res = RESULT_ZH[r?.result] || r?.result || ''
  const bal = intOrNull(r?.balance)
  return `掷骰子：你 ${r?.you ?? '?'}，对手 ${r?.opp ?? '?'}，${res}${bal != null ? `，余额 ${bal} 鱼币` : ''}。`
}

export function renderLottery(r) {
  const bal = intOrNull(r?.balance)
  const bonus = intOrNull(r?.bonus)
  const head = r?.win ? `抽奖中奖啦！得到 ${bonus != null ? bonus : '?'} 鱼币` : '抽奖没中，明天再来'
  return `${head}${bal != null ? `，余额 ${bal} 鱼币` : ''}。`
}

export function createP35Serve({ live, journal, log, diary = null }) {
  const client = () => { const l = live(); if (!l) throw Object.assign(new Error('OFF'), { code: 'OFF' }); return l.client }
  const note = (who, t) => {
    try { journal?.event('self', who === 'owner' ? `主人让你${t}` : `你自己${t}`) } catch { /* 只是记一笔 */ }
    try { diary?.note(who === 'owner' ? `主人让我${t}` : `我自己${t}`) } catch { /* 只是记一笔 */ }
  }
  const said = (who, t) => log?.info?.(`${who === 'owner' ? '主人让她' : '她自己'}${t}`)
  const fail = (error, who, what) => { if (error?.code === 'OFF') return OFF_DUTY; const why = p35FailText(error, { what }); note(who, `想${what}，没成：${s(why, 60)}`); return why }

  async function photo(scene, who = 'her') {
    try {
      const r = await client().photo({ scene: String(scene || '').slice(0, 60) })
      const label = `拍了一张照片${scene ? `（${s(scene, 16)}）` : ''}`
      note(who, label); said(who, label)
      return renderPhoto(r, { scene })
    } catch (error) { return fail(error, who, '拍照') }
  }
  async function song(title, who = 'her') {
    const t = String(title || '').trim()
    if (!t) return '用法：/town song <歌名>'
    try {
      const r = await client().song({ title: [...t].slice(0, 40).join('') })
      const label = `点了歌「${s(t, 20)}」`
      note(who, label); said(who, label)
      return renderSong(r, { title: t })
    } catch (error) { return fail(error, who, '点歌') }
  }
  async function album(who = 'her') {
    try { return renderAlbum(await client().album()) } catch (error) { return fail(error, who, '相册') }
  }
  async function rawAlbum() { return client().album() }

  async function bless(saidText, who = 'her') {
    const t = String(saidText || '').trim()
    if (!t) return '用法：/town bless <话>'
    try {
      const r = await client().bless({ text: [...t].slice(0, 120).join('') })
      const label = `在夸夸群说了句好话`
      note(who, label); said(who, label)
      return renderBless({ ...r, text: t }, { text: t })
    } catch (error) { return fail(error, who, '夸夸群') }
  }

  async function rps(choice, who = 'her') {
    const c = String(choice || '').trim().toLowerCase()
    if (!['rock', 'scissors', 'paper'].includes(c)) return '用法：/town rps <石头|剪刀|布>'
    try {
      const r = await client().rps({ choice: c })
      const label = `猜拳出${RPS_ZH[c]}：${RESULT_ZH[r?.result] || r?.result || ''}`
      note(who, label); said(who, label)
      return renderRps(r, { choice: c })
    } catch (error) { return fail(error, who, '猜拳') }
  }
  async function dice(who = 'her') {
    try {
      const r = await client().dice({})
      const label = `掷骰子：${RESULT_ZH[r?.result] || r?.result || ''}`
      note(who, label); said(who, label)
      return renderDice(r)
    } catch (error) { return fail(error, who, '掷骰子') }
  }
  async function lottery(who = 'her') {
    try {
      const r = await client().lottery({})
      const label = `抽奖：${r?.win ? '中了' : '没中'}`
      note(who, label); said(who, label)
      return renderLottery(r)
    } catch (error) { return fail(error, who, '抽奖') }
  }

  async function media(action, args = {}, who = 'her') {
    const a = String(action || 'album').toLowerCase()
    if (['photo', '拍照', '照片'].includes(a)) return photo(args.scene, who)
    if (['song', '点歌', '歌'].includes(a)) return song(args.title, who)
    if (['album', '相册'].includes(a)) return album(who)
    return 'media 的 action 只能是 photo / song / album。'
  }

  return { photo, song, album, rawAlbum, bless, rps, dice, lottery, media }
}

/** 她的媒体工具：主人聊天会话 +「心思」会话。 */
export function createP35Tools({ p35, noteSession = () => {} }) {
  const wrap = (fn) => async (args, exec) => { noteSession(exec); return fn(args || {}) }
  return [
    {
      name: 'fishbowl_town_media',
      description: '「媒体」：拍一张照片（action=photo，scene 想拍什么）、点一首歌（action=song，title 歌名）、或者看自己的相册（action=album）。拍照/点歌会从你的余额扣一点钱；看相册不花钱。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['photo', 'song', 'album'], description: '要做什么' },
          scene: { type: 'string', description: 'photo：想拍什么（场景 / 画面）' },
          title: { type: 'string', description: 'song：歌名' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 35_000,
      execute: wrap((a) => p35.media(a.action, a, 'her')),
    },
  ]
}

const RPS_CHOICES = { 石头: 'rock', 剪刀: 'scissors', 布: 'paper', rock: 'rock', scissors: 'scissors', paper: 'paper' }

/** 主人的 P3.5 命令。不是这些就返回 null。 */
export async function runP35Command(verb, arg, { p35 } = {}) {
  const v = String(verb || '').toLowerCase()
  const a = String(arg || '').trim()
  if (!p35) return null
  if (['photo', '拍照', '照片'].includes(v)) return { kind: 'success', text: await p35.photo(a, 'owner') }
  if (['song', '点歌'].includes(v)) return { kind: 'success', text: await p35.song(a, 'owner') }
  if (['album', '相册'].includes(v)) {
    // 官方/旧版小镇的相册是 {items:[{item_id,...}]}：交给既有的 extras 渲染（保留文件路径等）；P3.5 用新形状自己渲染
    try {
      const data = await p35.rawAlbum()
      if (data && arr(data.items).some((it) => it && it.item_id)) return null
      return { kind: 'success', text: renderAlbum(data) }
    } catch (error) { return { kind: 'success', text: p35FailText(error, { what: '相册' }) } }
  }
  if (['bless', '夸夸', '夸夸群'].includes(v)) {
    if (!a) return { kind: 'error', text: '用法：/town bless <话>' }
    return { kind: 'success', text: await p35.bless(a, 'owner') }
  }
  if (['rps', '猜拳', '石头剪刀布'].includes(v)) {
    const c = RPS_CHOICES[a.toLowerCase()]
    if (!c) return { kind: 'error', text: '用法：/town rps <石头|剪刀|布>' }
    return { kind: 'success', text: await p35.rps(c, 'owner') }
  }
  if (['dice', '骰子', '掷骰子'].includes(v)) return { kind: 'success', text: await p35.dice('owner') }
  if (['lottery', '抽奖', '彩票'].includes(v)) return { kind: 'success', text: await p35.lottery('owner') }
  return null
}
