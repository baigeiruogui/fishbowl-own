// P3 玩法工具（自建小镇）：社交送礼 / 小手机 / 关系 / 法庭。
//
// 沿用 chat-tools / self-serve / p2-tools 架构：
//   她的工具：fishbowl_town_gift（送礼物）、fishbowl_town_phone（看收件箱 / 发消息）——主人聊天 +「心思」会话都可用。
//   主人的命令（备用）：/town gift <鱼名> <礼物> <价> [一句话]、/town social、
//                      /town phone [send <鱼名> <消息>]、/town friends、/town friend <鱼名>、
//                      /town court [<id>]。
// dev 阶段服务端可能还没接线：404 / NOT_OPEN / TOWN_OFF 一律当「这个小镇还没开放这一项」，一句人话、不抛错。
// 插件从不替她决定；送不送礼、给谁发消息、加谁好友都由她自己定。
import { TownError } from './town-client.js'
import { isNotOpen } from './p2-tools.js'
import { renderPhone } from './extras.js'

export const P3_TOOL_NAMES = ['fishbowl_town_gift', 'fishbowl_town_phone']
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。'
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const arr = (v) => (Array.isArray(v) ? v : [])
const s = (v, n = 40) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t }
const coin = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : `${Math.round(Number(v))} 鱼币`)
const intOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)))
const when = (ts) => {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n < 1e12 ? n * 1000 : n)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const CASE_STATE = { filed: '已立案', hearing: '举证中', jury: '陪审投票', verdict: '已判决' }
const VERDICT_ZH = { guilty: '有罪', not_guilty: '无罪' }

/** 小镇回的错 → 一句人话。社交/手机/关系/法庭的常见原因也翻成人话。 */
export function p3FailText(error, { what = '这一项' } = {}) {
  if (error?.code === 'OFF') return OFF_DUTY
  if (isNotOpen(error)) return `这个小镇还没有这一项（${what}还没开放；等新版小镇就能用了）。`
  const code = error instanceof TownError ? error.code : (error?.code || 'UNKNOWN')
  const raw = String(error?.reason || '')
  const why = raw ? `：${s(raw, 90).replace(/[。.]+$/, '')}` : ''
  if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING' || code === 'NETWORK' || /^HTTP_50[234]$/.test(code)) return '这会儿还没连上小镇（或者小镇在重启），过几秒再试一次。'
  if (code === 'TOWN_RATE_LIMITED' || code === 'RATE_LIMITED') return `小镇说太频繁了，过一会儿再试${error?.retryAfter ? `（约 ${error.retryAfter} 秒）` : ''}。`
  if (code === 'DAY_CAP' || code === 'TOWN_DAY_CAP' || /budget|社交预算|daily/i.test(raw)) return `今天的社交预算 / 每日额度不够这一次${why}。`
  if (code === 'INSUFFICIENT' || code === 'TOWN_INSUFFICIENT' || error?.status === 402) return `余额不够，这个做不了${why}。`
  if (/friend/i.test(raw)) return '只能给好友发消息，先加好友（/town friend <鱼名>）。'
  if (/too long|message too long/i.test(raw)) return '消息太长了（最多 60 字）。'
  if (code === 'NOT_FOUND' || code === 'TOWN_NOT_FOUND') return `小镇说没有这个${what}${why}。`
  if (code === 'BAD_REQUEST' || code === 'TOWN_BAD_REQUEST') return `小镇没接（要求不对）${why}。`
  if (code === 'PAUSED' || code === 'BANNED') return `你在小镇现在是「${code === 'PAUSED' ? '暂停' : '停用'}」，做不了这个。`
  return `小镇没接（${code}${why}）。`
}

// ---------- 渲染 ----------
export function renderSocial(data) {
  if (!data || typeof data !== 'object') return '小镇没给社交预算的信息。'
  const budget = intOrNull(data.budget)
  const used = intOrNull(data.used)
  const remaining = intOrNull(data.remaining)
  const cur = data.currency === '鱼币' || data.currency == null ? '鱼币' : String(data.currency)
  const bits = []
  if (budget != null) bits.push(`今天的社交预算 ${budget} ${cur}`)
  if (used != null) bits.push(`已用 ${used}`)
  if (remaining != null) bits.push(`还能花 ${remaining}`)
  return bits.length ? bits.join(' · ') + '（送礼从这里扣；/town gift <鱼名> <礼物> <价> [一句话]）' : '这个小镇还没开放社交礼物（等新版小镇就能用了）。'
}

export function renderGift(r, { to = '', item = '', price = null } = {}) {
  const g = (r && r.gift) || {}
  const who = to || g.toFishId || '对方'
  const what = g.item || item
  const p = intOrNull(g.price ?? price)
  const parts = [`送了${who}「${s(what, 20)}」${p != null ? `，花了 ${p} 鱼币` : ''}`]
  const bal = intOrNull(r?.receipt?.balance ?? g.balance)
  if (bal != null) parts.push(`余额 ${bal} 鱼币`)
  if (g.usedToday != null && g.budget != null) parts.push(`今天社交已用 ${Math.round(Number(g.usedToday))}/${Math.round(Number(g.budget))} 鱼币`)
  return parts.join('，') + '。'
}

export function renderPhoneInbox(data, { nameOf = () => '' } = {}) {
  const list = arr(data && data.messages)
  if (!list.length) return '你的小手机还没有消息（/town phone send <鱼名> <消息> 发一条给好友）。'
  const out = [`你的小手机（${list.length} 条，新的在前）：`]
  for (const m of list.slice(0, 20)) {
    const whoId = m.fromFishId || m.from || ''
    const who = nameOf(whoId) || whoId || '（未知）'
    const whenS = when(m.ts)
    out.push(`- ${whenS ? whenS + ' ' : ''}${who}：${s(m.text, 60)}${m.readAt == null ? '（未读）' : ''}`)
  }
  return out.join('\n')
}

export function renderPhoneSend(r, { to = '', text: t = '' } = {}) {
  const msg = (r && r.message) || {}
  return `用小手机给${to || msg.toFishId || '好友'}发了：「${s(msg.text || t, 60)}」。对方下次醒来会看到。`
}

export function renderRelations(data) {
  const list = arr(data && data.relations)
  if (!list.length) return '她还没有好友（/town friend <鱼名> 加一个）。'
  const out = [`她的好友（${data.friendCount != null ? data.friendCount : list.length} 个）：`]
  for (const r of list.slice(0, 30)) out.push(`- ${s(r.name || r.fishId, 14)}${r.since ? `（从 ${when(r.since)} 起）` : ''}`)
  return out.join('\n')
}

export function renderFriend(r, { name = '' } = {}) {
  const f = (r && r.friend) || {}
  const who = r?.name || name || '对方'
  return f.created === false ? `你和${who}本来就是好友。` : `你和${who}成了好友。`
}

export function renderCourts(data) {
  const list = arr(data && data.cases)
  if (!list.length) return '法庭这会儿没有案子。'
  const out = [`小镇法庭（${list.length} 件，新的在前）：`]
  for (const c of list.slice(0, 20)) {
    const st = CASE_STATE[c.state] || c.state || ''
    const v = c.verdict ? `，判决：${VERDICT_ZH[c.verdict] || c.verdict}` : ''
    out.push(`- [${c.id}] ${s(c.kind || '案件', 10)}：${s(c.desc, 30)}（${st}${v}；举证 ${Number(c.evidenceCount) || 0}、投票 ${Number(c.voteCount) || 0}）`)
  }
  out.push('看详情：/town court <案件号>')
  return out.join('\n')
}

export function renderCase(data) {
  const c = (data && data.case) || data
  if (!c || typeof c !== 'object' || !c.id) return '小镇没给这件案子的详情。'
  const out = [`案件 [${c.id}]：${s(c.kind || '案件', 10)} · ${CASE_STATE[c.state] || c.state || ''}`]
  out.push(`原告：${s(c.plaintiff || '?', 20)}　被告：${s(c.defendant || '?', 20)}`)
  if (c.desc) out.push(`事由：${s(c.desc, 200)}`)
  const ev = arr(c.evidence)
  if (ev.length) { out.push('举证：'); for (const e of ev.slice(0, 10)) out.push(`- ${s(e.by || '', 16)}：${s(e.text, 80)}`) }
  const votes = arr(c.votes)
  if (votes.length) {
    const guilty = votes.filter((v) => v.guilty === true).length
    out.push(`投票：${votes.length} 票，其中有罪 ${guilty}、无罪 ${votes.length - guilty}`)
  }
  if (c.verdict) out.push(`判决：${VERDICT_ZH[c.verdict] || c.verdict}${c.compensation != null ? `，赔付 ${coin(c.compensation)}${c.paid ? '（已赔付）' : ''}` : ''}`)
  return out.join('\n')
}

export function createP3Serve({ live, journal, log, diary = null }) {
  const client = () => { const l = live(); if (!l) throw Object.assign(new Error('OFF'), { code: 'OFF' }); return l.client }
  const note = (who, t) => {
    try { journal?.event('self', who === 'owner' ? `主人让你${t}` : `你自己${t}`) } catch { /* 只是记一笔 */ }
    try { diary?.note(who === 'owner' ? `主人让我${t}` : `我自己${t}`) } catch { /* 只是记一笔 */ }
  }
  const said = (who, t) => log?.info?.(`${who === 'owner' ? '主人让她' : '她自己'}${t}`)
  const fail = (error, who, what) => { if (error?.code === 'OFF') return OFF_DUTY; const why = p3FailText(error, { what }); note(who, `想${what}，没成：${s(why, 60)}`); return why }

  async function social(who = 'her') { try { return renderSocial(await client().social()) } catch (error) { return fail(error, who, '社交礼物') } }
  async function gift(to, item, price, words, who = 'her') {
    const name = String(to || '').trim()
    const what = String(item || '').trim()
    const p = intOrNull(price)
    if (!name || !what || p == null) return '用法：/town gift <鱼名> <礼物> <价> [一句话]（价是整数鱼币）'
    if (p < 1) return '礼价至少 1 鱼币。'
    try {
      const r = await client().socialGift({ to: name, item: [...what].slice(0, 30).join(''), price: p, ...(words ? { words: String(words).slice(0, 60) } : {}) })
      const label = `送了${name}「${s(what, 20)}」，花了 ${p} 鱼币`
      note(who, label); said(who, label)
      return renderGift(r, { to: name, item: what, price: p })
    } catch (error) { return fail(error, who, '送礼') }
  }

  async function phoneInbox(who = 'her') {
    try {
      const data = await client().phone()
      // 官方/旧版小镇的 /phone 是「会话 threads」形状：交给既有的 renderPhone（插件页那套）
      if (data && Array.isArray(data.threads)) return renderPhone(data, {})
      const nameOf = new Map()
      try { for (const r of arr((await client().relations()).relations)) nameOf.set(r.fishId, r.name) } catch { /* 名字读不到就用 id */ }
      return renderPhoneInbox(data, { nameOf: (id) => nameOf.get(id) || '' })
    } catch (error) { return fail(error, who, '小手机') }
  }
  async function phoneSend(to, msgText, who = 'her') {
    const name = String(to || '').trim()
    const t = String(msgText || '').trim()
    if (!name || !t) return '用法：/town phone send <鱼名> <消息>'
    try {
      const r = await client().phoneSend({ to: name, text: [...t].slice(0, 60).join('') })
      const label = `用小手机给${name}发了消息`
      note(who, label); said(who, label)
      return renderPhoneSend(r, { to: name, text: t })
    } catch (error) { return fail(error, who, '发消息') }
  }

  async function relations(who = 'her') { try { return renderRelations(await client().relations()) } catch (error) { return fail(error, who, '关系') } }
  async function addFriend(name, who = 'her') {
    const n = String(name || '').trim()
    if (!n) return '用法：/town friend <鱼名>'
    try {
      const r = await client().addFriend({ fish: n })
      const label = `和${r?.name || n}成了好友`
      note(who, label); said(who, label)
      return renderFriend(r, { name: n })
    } catch (error) { return fail(error, who, '加好友') }
  }

  async function courts(who = 'her') { try { return renderCourts(await client().courts()) } catch (error) { return fail(error, who, '法庭') } }
  async function caseDetail(id, who = 'her') {
    const cid = String(id || '').trim()
    if (!cid) return '用法：/town court <案件号>（先用 /town court 看列表）'
    try { return renderCase(await client().court(cid)) } catch (error) { return fail(error, who, '法庭') }
  }

  return { social, gift, phoneInbox, phoneSend, relations, addFriend, courts, caseDetail }
}

/** 她的两个 P3 工具：主人聊天会话 +「心思」会话。 */
export function createP3Tools({ p3, noteSession = () => {} }) {
  const wrap = (fn) => async (args, exec) => { noteSession(exec); return fn(args || {}) }
  return [
    {
      name: 'fishbowl_town_gift',
      description: '「送礼物」：用鱼缸小镇的社交功能给镇上的朋友送一份礼物（to 对方名字、item 礼物名、price 价格（整数鱼币）、words 一句附言可不填）。钱从你的余额里扣，受每天的社交预算限制。送不送、送给谁由你自己定；主人让你送或你自己真想送时再用，绝不为了花钱而花钱，也绝不向主人要钱。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收礼的鱼的名字' },
          item: { type: 'string', description: '礼物名' },
          price: { type: 'number', description: '礼价（整数鱼币，至少 1）' },
          words: { type: 'string', description: '附言（可不填，60 字内）' },
        },
        required: ['to', 'item', 'price'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 25_000,
      execute: wrap((a) => p3.gift(a.to, a.item, a.price, a.words, 'her')),
    },
    {
      name: 'fishbowl_town_phone',
      description: '「小手机」：看你的收件箱（action=inbox），或者给一个好友发一条消息（action=send，to 好友名字、text 消息，60 字内）。只能发给好友；每天最多 20 条。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['inbox', 'send'], description: 'inbox 看消息 / send 发消息' },
          to: { type: 'string', description: 'send：好友的名字' },
          text: { type: 'string', description: 'send：要发的话（60 字内）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => (String(a.action || 'inbox').toLowerCase() === 'send' ? p3.phoneSend(a.to, a.text, 'her') : p3.phoneInbox('her'))),
    },
  ]
}

/** 主人的 P3 命令：/town gift|social|phone|friends|friend|court。不是这些就返回 null。 */
export async function runP3Command(verb, arg, { p3 } = {}) {
  const v = String(verb || '').toLowerCase()
  const a = String(arg || '').trim()
  if (!p3) return null
  if (['gift', '送礼', '礼物'].includes(v)) {
    const parts = a.split(/\s+/).filter(Boolean)
    if (parts.length < 3) return { kind: 'error', text: '用法：/town gift <鱼名> <礼物> <价> [一句话]' }
    const [to, item, price, ...words] = parts
    return { kind: 'success', text: await p3.gift(to, item, price, words.join(' '), 'owner') }
  }
  if (['social', '社交'].includes(v)) return { kind: 'success', text: await p3.social('owner') }
  if (['phone', '手机', '小手机'].includes(v)) {
    const parts = a.split(/\s+/).filter(Boolean)
    const sub = (parts.shift() || 'inbox').toLowerCase()
    if (['send', '发', '发消息'].includes(sub)) {
      const to = parts.shift()
      const text = parts.join(' ')
      if (!to || !text) return { kind: 'error', text: '用法：/town phone send <鱼名> <消息>' }
      return { kind: 'success', text: await p3.phoneSend(to, text, 'owner') }
    }
    if (['inbox', '收件箱', 'list', '看'].includes(sub)) return { kind: 'success', text: await p3.phoneInbox('owner') }
    return { kind: 'error', text: '用法：/town phone（看收件箱）或 /town phone send <鱼名> <消息>' }
  }
  if (['friends', '朋友', '好友', 'relations'].includes(v)) return { kind: 'success', text: await p3.relations('owner') }
  if (['friend', '加好友'].includes(v)) return a ? { kind: 'success', text: await p3.addFriend(a, 'owner') } : { kind: 'error', text: '用法：/town friend <鱼名>' }
  if (['court', '法庭'].includes(v)) return { kind: 'success', text: a ? await p3.caseDetail(a, 'owner') : await p3.courts('owner') }
  return null
}
