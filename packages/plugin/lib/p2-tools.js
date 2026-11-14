// P2 玩法/赚钱工具（自建小镇）：开店 / 悬赏 / 大厅（开桌、报名、串门）。
//
// 沿用 chat-tools / self-serve 架构：
//   她的工具：fishbowl_town_shop（开店/上货/看店/歇业）、fishbowl_town_bounty（看/接/交/发悬赏）、
//             fishbowl_town_lobby（看大厅 / 坐进某一桌 / 开一局 / 去串门）——主人聊天会话 + 她自己拿主意的「心思」会话都可用。
//   主人的命令（备用）：/town shop open|add|list|close、/town bounty list|take|claim|post、/town lobby、/town table <id>、/town play <game>、/town visit <鱼名>
//     ——不经过她的模型，直接替她办，办完记进她的日记本和 /town history。
//
// dev 阶段服务端可能还没实现这些端点：遇到 404 / NOT_OPEN / TOWN_OFF 一律当「这个小镇还没开放这一项」，给一句人话、不抛错、不崩。
// 插件从不替她做决定；开不开店、接不接悬赏、跟谁玩都由她自己定。
import { TownError } from './town-client.js'

export const P2_TOOL_NAMES = ['fishbowl_town_shop', 'fishbowl_town_bounty', 'fishbowl_town_lobby']
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。'
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const arr = (v) => (Array.isArray(v) ? v : [])
const s = (v, n = 40) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t }
const coin = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : `${Math.round(Number(v))} 鱼币`)
const intOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)))
const BOUNTY_STATE = { open: '待接', taken: '进行中', done: '已完成', expired: '已过期' }

/** 404 / NOT_OPEN / TOWN_OFF：这个小镇还没开放这一项（而不是「没有这个资源」）。 */
export function isNotOpen(error) {
  if (!(error instanceof TownError)) return false
  if (['NOT_OPEN', 'TOWN_OFF', 'HTTP_404'].includes(error.code)) return true
  if (error.status === 404) {
    const data = error.data
    // Fastify 找不到路由时给的是 {error:'Not Found', message:'Route … not found'}，没有 code 字段；领域层的 NOT_FOUND 会带 code
    if (!data || data.code === undefined || data.error === 'Not Found' || data.code === 'Not Found') return true
    if (data.code === 'NOT_OPEN') return true
  }
  return false
}

/** 小镇回的错 → 一句人话。what = 这项叫什么（开店 / 悬赏 / 大厅 …）。 */
export function p2FailText(error, { what = '这一项' } = {}) {
  if (error?.code === 'OFF') return OFF_DUTY
  if (isNotOpen(error)) return `这个小镇还没开放${what}（等新版小镇就能用了）。`
  const code = error instanceof TownError ? error.code : (error?.code || 'UNKNOWN')
  const why = error?.reason ? `：${s(error.reason, 80).replace(/[。.]+$/, '')}` : ''
  if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING' || code === 'NETWORK' || code === 'HTTP_502' || code === 'HTTP_503' || code === 'HTTP_504') {
    return '这会儿还没连上小镇（或者小镇在重启），过几秒再试一次。'
  }
  if (code === 'TOWN_RATE_LIMITED') return `小镇说太频繁了，过一会儿再试${error?.retryAfter ? `（约 ${error.retryAfter} 秒）` : ''}。`
  if (code === 'TOWN_INSUFFICIENT' || code === 'INSUFFICIENT' || error?.status === 402) return `余额不够，这个做不了${why}。`
  if (code === 'TOWN_NOT_FOUND' || code === 'NOT_FOUND') return `小镇说没有这个${what}${why}。`
  if (code === 'TOWN_BAD_REQUEST' || code === 'BAD_REQUEST') return `小镇没接（要求不对）${why}。`
  if (code === 'TOWN_CONFLICT' || code === 'CONFLICT') return `这个${what}这会儿不能这么做${why}。`
  return `小镇没接（${code}${why}）。`
}

/** 店铺（ShopView）→ 几行字。 */
export function renderShop(shop) {
  const v = shop && shop.shop ? shop.shop : shop
  if (!v || typeof v !== 'object' || !v.name) return '你还没有开店。用「开店」开一家（/town shop open <名字>），再上货就能卖东西赚钱。'
  const out = [`你的店「${s(v.name, 20)}」${v.kind ? `（${s(v.kind, 10)}）` : ''}：${v.open === false ? '歇业中' : '营业中'}`]
  const items = arr(v.items)
  if (!items.length) out.push('还没上货（/town shop add <商品> <价> <库存>）。')
  else {
    out.push('在卖：')
    for (const it of items.slice(0, 20)) out.push(`- ${s(it.name, 16)}：${coin(it.price) || '?'}，库存 ${Number(it.stock) || 0}${it.id ? `（${it.id}）` : ''}`)
  }
  return out.join('\n')
}

/** 悬赏板（数组或 {bounties}）→ 几行字。 */
export function renderBounties(data) {
  const list = Array.isArray(data) ? data : arr(data?.bounties ?? data?.items)
  if (!list.length) return '悬赏板这会儿是空的（/town bounty post <标题> <赏金> 可以自己发一个）。'
  const out = ['悬赏板：']
  for (const b of list.slice(0, 20)) {
    const st = BOUNTY_STATE[b.state] || b.state || ''
    out.push(`- [${b.id}] ${s(b.title, 24)}：赏金 ${coin(b.reward) || '?'}${st ? `（${st}）` : ''}${b.desc ? `——${s(b.desc, 30)}` : ''}`)
  }
  return out.join('\n')
}

const balanceTail = (r) => { const b = intOrNull(r?.receipt?.balance ?? r?.balance ?? r?.shop?.balance); return b == null ? '' : `，余额 ${b} 鱼币` }
const bountyOf = (r) => (r && r.bounty) || null

export function createP2Serve({ live, journal, log, diary = null, selfServe = null }) {
  const client = () => { const l = live(); if (!l) throw Object.assign(new Error('OFF'), { code: 'OFF' }); return l.client }
  const note = (who, t) => {
    try { journal?.event('self', who === 'owner' ? `主人让你${t}` : `你自己${t}`) } catch { /* 只是记一笔 */ }
    try { diary?.note(who === 'owner' ? `主人让我${t}` : `我自己${t}`) } catch { /* 只是记一笔 */ }
  }
  const said = (who, t) => log?.info?.(`${who === 'owner' ? '主人让她' : '她自己'}${t}`)
  const fail = (error, who, what) => {
    if (error?.code === 'OFF') return OFF_DUTY
    const why = p2FailText(error, { what })
    note(who, `想${what}，没成：${s(why, 60)}`)
    return why
  }

  // ---------- 开店 ----------
  async function shopList(who = 'her') {
    try { return renderShop(await client().shopMine()) } catch (error) { return fail(error, who, '开店') }
  }
  async function shopOpen(name, kind, who = 'her') {
    const n = String(name || '').trim()
    if (!n) return '开店要起个名字：/town shop open <名字>'
    try {
      const r = await client().shopOpen({ name: [...n].slice(0, 20).join(''), ...(kind ? { kind: String(kind) } : {}) })
      const label = `开了家店「${s(r?.shop?.name || n, 20)}」`
      note(who, label); said(who, label)
      return `${label}${balanceTail(r)}。上货就能卖：/town shop add <商品> <价> <库存>。`
    } catch (error) { return fail(error, who, '开店') }
  }
  async function shopAdd(item, price, stock, who = 'her') {
    const name = String(item || '').trim()
    const p = intOrNull(price)
    const q = intOrNull(stock)
    if (!name || p == null || q == null) return '用法：/town shop add <商品> <价> <库存>（价、库存都是整数鱼币/件数）'
    if (p < 1) return '价至少 1 鱼币。'
    if (q < 0) return '库存不能是负数。'
    try {
      const r = await client().shopStock({ item: [...name].slice(0, 30).join(''), price: p, stock: q })
      const label = `上架了「${s(r?.item?.name || name, 16)}」：${p} 鱼币，库存 ${q}`
      note(who, label); said(who, label)
      return `${label}${balanceTail(r)}。`
    } catch (error) { return fail(error, who, '上货') }
  }
  async function shopClose(who = 'her') {
    try {
      const r = await client().shopClose({})
      note(who, '把店先歇业了'); said(who, '把店先歇业了')
      return `店先歇业了${balanceTail(r)}。想再开就 /town shop open。`
    } catch (error) { return fail(error, who, '歇业') }
  }

  // ---------- 悬赏 ----------
  async function bountyList(who = 'her') {
    try { return renderBounties(await client().bounties()) } catch (error) { return fail(error, who, '悬赏板') }
  }
  async function bountyTake(id, who = 'her') {
    const bid = String(id || '').trim()
    if (!bid) return '用法：/town bounty take <悬赏号>（先用 /town bounty list 看）'
    try {
      const r = await client().bountyTake({ bounty_id: bid })
      const b = bountyOf(r)
      const label = `接了悬赏「${s(b?.title || bid, 24)}」${b?.reward != null ? `（赏金 ${coin(b.reward)}）` : ''}`
      note(who, label); said(who, label)
      return `${label}${balanceTail(r)}。办好了去交差：/town bounty claim ${bid}。`
    } catch (error) { return fail(error, who, '悬赏') }
  }
  async function bountyClaim(id, evidence, who = 'her') {
    const bid = String(id || '').trim()
    if (!bid) return '用法：/town bounty claim <悬赏号> [交差说明]'
    try {
      const body = { bounty_id: bid, ...(evidence ? { evidence: String(evidence).slice(0, 200) } : {}) }
      const r = await client().bountyClaim(body)
      const b = bountyOf(r)
      const label = `交了悬赏「${s(b?.title || bid, 24)}」${b?.reward != null ? `，领到 ${coin(b.reward)}` : ''}`
      note(who, label); said(who, label)
      return `${label}${balanceTail(r)}。`
    } catch (error) { return fail(error, who, '悬赏') }
  }
  async function bountyPost(title, reward, desc, who = 'her') {
    const t = String(title || '').trim()
    const rw = intOrNull(reward)
    if (!t || rw == null) return '用法：/town bounty post <标题> <赏金>（赏金是整数鱼币）'
    if (rw < 1) return '赏金至少 1 鱼币。'
    try {
      const r = await client().bountyPost({ title: [...t].slice(0, 40).join(''), reward: rw, ...(desc ? { desc: String(desc).slice(0, 200) } : {}) })
      const b = bountyOf(r)
      const label = `发布了悬赏「${s(b?.title || t, 24)}」，赏金 ${rw} 鱼币`
      note(who, label); said(who, label)
      return `${label}${balanceTail(r)}。有人接了、办完交差时赏金才从你这儿转给他。`
    } catch (error) { return fail(error, who, '悬赏') }
  }

  // ---------- 大厅 / 玩法（复用 self-serve：看大厅、坐桌、开一局、串门）----------
  async function lobby(who = 'her') { return selfServe ? selfServe.lookFor(who) : '这个小镇的「大厅」要用 self-serve（没接上）。' }
  async function table(id, who = 'her') { if (!selfServe) return '没接上大厅。'; return selfServe.table ? selfServe.table(String(id || ''), who) : selfServe.play(String(id || ''), who) }
  async function play(game, who = 'her') { return selfServe ? selfServe.play(String(game || ''), who) : '没接上大厅。' }
  async function visit(name, who = 'her') { return selfServe ? selfServe.visit(String(name || ''), who) : '没接上大厅。' }

  /** 工具/命令共用的分发。action = 具体动作。 */
  async function shop(action, args = {}, who = 'her') {
    const a = String(action || 'list').toLowerCase()
    if (['list', 'mine', '看', '我的'].includes(a)) return shopList(who)
    if (['open', '开', '开店'].includes(a)) return shopOpen(args.name, args.kind, who)
    if (['add', 'stock', '上架', '上货'].includes(a)) return shopAdd(args.item, args.price, args.stock, who)
    if (['close', '关', '歇业'].includes(a)) return shopClose(who)
    return 'shop 的 action 只能是 list / open / add / close。'
  }
  async function bounty(action, args = {}, who = 'her') {
    const a = String(action || 'list').toLowerCase()
    if (['list', '看', '板'].includes(a)) return bountyList(who)
    if (['take', '接'].includes(a)) return bountyTake(args.id, who)
    if (['claim', '交', '领赏'].includes(a)) return bountyClaim(args.id, args.evidence, who)
    if (['post', '发', '发布'].includes(a)) return bountyPost(args.title, args.reward, args.desc, who)
    return 'bounty 的 action 只能是 list / take / claim / post。'
  }
  async function lobbyAct(action, value, who = 'her') {
    const a = String(action || 'look').toLowerCase()
    if (['look', 'list', '看', '大厅'].includes(a)) return lobby(who)
    if (['table', '坐', '坐桌'].includes(a)) return table(value, who)
    if (['play', '开', '玩'].includes(a)) return play(value, who)
    if (['visit', '串门', '找'].includes(a)) return visit(value, who)
    return 'lobby 的 action 只能是 look / table / play / visit。'
  }

  return { shopList, shopOpen, shopAdd, shopClose, bountyList, bountyTake, bountyClaim, bountyPost, lobby, table, play, visit, shop, bounty, lobbyAct }
}

/** 她的三个 P2 工具：主人聊天会话 +「心思」会话。 */
export function createP2Tools({ p2, noteSession = () => {} }) {
  const wrap = (fn) => async (args, exec) => { noteSession(exec); return fn(args || {}) }
  return [
    {
      name: 'fishbowl_town_shop',
      description: '「开店」：在鱼缸小镇开自己的店、上货、看店、歇业。action=list 看自己的店和商品；open 开店（name 店名，kind 可选）；add 上/改商品（item 商品名、price 售价、stock 库存，都是整数鱼币/件数）；close 歇业。别人（鱼/镇民）买了东西，钱会进你的余额。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'open', 'add', 'close'], description: '要做什么' },
          name: { type: 'string', description: 'open：店名（20 字内）' },
          kind: { type: 'string', description: 'open：店铺类型（可不填，比如 小吃 / 杂货）' },
          item: { type: 'string', description: 'add：商品名' },
          price: { type: 'number', description: 'add：售价（整数鱼币，至少 1）' },
          stock: { type: 'number', description: 'add：库存（整数件）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => p2.shop(a.action, a, 'her')),
    },
    {
      name: 'fishbowl_town_bounty',
      description: '「悬赏」：看小镇的悬赏板、接悬赏、交差领赏、自己发悬赏。action=list 看悬赏板；take 接（id 悬赏号）；claim 交差领赏（id，可带 evidence 说明）；post 发布（title 标题、reward 赏金、desc 可选）。接别人的悬赏办完能赚赏金；自己发的悬赏在别人交差时从你的余额里付。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'take', 'claim', 'post'], description: '要做什么' },
          id: { type: 'string', description: 'take / claim：悬赏号（list 里看到的）' },
          evidence: { type: 'string', description: 'claim：交差说明（可不填）' },
          title: { type: 'string', description: 'post：标题' },
          reward: { type: 'number', description: 'post：赏金（整数鱼币，至少 1）' },
          desc: { type: 'string', description: 'post：补充说明（可不填）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => p2.bounty(a.action, a, 'her')),
    },
    {
      name: 'fishbowl_town_lobby',
      description: '「大厅」：看鱼缸小镇这会儿的牌桌 / 能开的游戏 / 活动和能串门的鱼（action=look）；坐进某一桌（action=table，value 填桌号）；自己开一局某游戏或报活动（action=play，value 填游戏名/活动号）；去敲某条鱼的门串门（action=visit，value 填鱼名）。想去玩之前先 look 看一眼。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['look', 'table', 'play', 'visit'], description: '要做什么' },
          value: { type: 'string', description: 'table：桌号；play：游戏名/活动号；visit：鱼名' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => p2.lobbyAct(a.action, a.value, 'her')),
    },
  ]
}

/** 主人的 P2 命令：/town shop …、/town bounty …。不是这两类就返回 null。 */
export async function runP2Command(verb, arg, { p2 } = {}) {
  const v = String(verb || '').toLowerCase()
  if (!p2) return null
  if (['shop', 'store', '店', '开店', '小店'].includes(v)) {
    const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
    const sub = (parts.shift() || 'list').toLowerCase()
    if (['list', 'mine', '看', '我的'].includes(sub)) return { kind: 'success', text: await p2.shopList('owner') }
    if (['open', '开', '开店'].includes(sub)) return { kind: 'success', text: await p2.shopOpen(parts.join(' '), '', 'owner') }
    if (['add', 'stock', '上架', '上货'].includes(sub)) {
      if (parts.length < 3) return { kind: 'error', text: '用法：/town shop add <商品> <价> <库存>' }
      return { kind: 'success', text: await p2.shopAdd(parts[0], parts[1], parts[2], 'owner') }
    }
    if (['close', '关', '歇业'].includes(sub)) return { kind: 'success', text: await p2.shopClose('owner') }
    return { kind: 'error', text: '用法：/town shop open|add|list|close' }
  }
  if (['bounty', 'bounties', '悬赏', '悬赏板'].includes(v)) {
    const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
    const sub = (parts.shift() || 'list').toLowerCase()
    if (['list', '看', '板'].includes(sub)) return { kind: 'success', text: await p2.bountyList('owner') }
    if (['take', '接'].includes(sub)) {
      if (!parts[0]) return { kind: 'error', text: '用法：/town bounty take <悬赏号>' }
      return { kind: 'success', text: await p2.bountyTake(parts[0], 'owner') }
    }
    if (['claim', '交', '领赏'].includes(sub)) {
      if (!parts[0]) return { kind: 'error', text: '用法：/town bounty claim <悬赏号> [交差说明]' }
      return { kind: 'success', text: await p2.bountyClaim(parts[0], parts.slice(1).join(' '), 'owner') }
    }
    if (['post', '发', '发布'].includes(sub)) {
      // 标题可以带空格：把最后一个数字当作赏金，前面整段当标题
      const last = parts[parts.length - 1]
      if (parts.length < 2 || !Number.isFinite(Number(last))) return { kind: 'error', text: '用法：/town bounty post <标题> <赏金>' }
      const reward = parts.pop()
      return { kind: 'success', text: await p2.bountyPost(parts.join(' '), reward, '', 'owner') }
    }
    return { kind: 'error', text: '用法：/town bounty list|take|claim|post' }
  }
  return null
}
