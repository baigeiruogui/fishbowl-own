// 她「自己赚钱」（自建小镇新增）：看招工 / 接活（到点结算工资）/ 看市场 / 卖鱼获换钱。
//
// 自建小镇的经济是「鱼币」（整数，纯游戏内货币），不是官方外来鱼那套 ¥。所以这里的话都说鱼币，不带充值。
// 两条路共用（沿用 self-serve.js 的架构）：
//   她的工具：fishbowl_town_jobs（看招工）、fishbowl_town_work（接一份活）、fishbowl_town_market（看市场和鱼获）、fishbowl_town_sell（卖鱼获）
//     ——在主人聊天的会话里，也在她自己拿主意的「心思」会话里（赚不赚、干什么由她自己定）。
//   主人的命令（备用）：/town jobs | work <标题/编号> | quit <合同号> | market | sell [鱼获] [数量]
//     ——不经过她的模型，直接替她办，办完记进她的日记本和 /town history。
// 插件从不替她决定；接不接活、卖不卖、卖给谁都是她自己的选择。
import { TownError } from './town-client.js'

export const EARN_TOOL_NAMES = ['fishbowl_town_jobs', 'fishbowl_town_work', 'fishbowl_town_market', 'fishbowl_town_sell']
const OFF_DUTY = '插件现在没在小镇值班（还没填小镇接入码，或者插件页的总开关关着）。'
const text = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

const arr = (v) => (Array.isArray(v) ? v : [])
const s = (v, n = 40) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t }
const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s·・\-_]/g, '')
const coinNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)))
const coin = (v) => { const n = coinNum(v); return n == null ? '' : `${n} 鱼币` }
const durationOf = (j) => Number(j?.durationMin ?? j?.duration_min ?? j?.duration) || null
const dueText = (endsAt, now = Date.now()) => {
  const n = Number(endsAt)
  if (!Number.isFinite(n) || n <= 0) return ''
  const ms = n - now
  if (ms <= 0) return '到点了，等结算'
  const m = Math.ceil(ms / 60_000)
  return m >= 90 ? `约 ${Math.round(m / 60)} 小时后完` : `约 ${m} 分钟后完`
}
const stateZh = (st) => ({ working: '在干', done: '干完了（工钱已结）', quit: '辞了' }[st] || st || '')

/** 招工列表（GET jobs）→ 几行字（她和主人都看得懂）。 */
export function renderJobs(data, { now = Date.now() } = {}) {
  if (!data || typeof data !== 'object') return '小镇没给招工的信息。'
  const jobs = arr(data.jobs ?? data.items)
  const mine = arr(data.mine ?? data.contracts)
  const out = []
  if (mine.length) {
    out.push('你已经接的活：')
    for (const c of mine.slice(0, 8)) {
      out.push(`- [${c.id}] ${s(c.title || c.offerId || c.offer_id || '一份活', 20)}：${coin(c.pay) || '工钱看小镇'}，${stateZh(c.state)}${c.state === 'working' && dueText(c.endsAt || c.ends_at, now) ? `（${dueText(c.endsAt || c.ends_at, now)}）` : ''}`)
    }
  }
  if (!jobs.length) { out.push('这会儿没有在招的工（过一会儿再来看看）。'); return out.join('\n') }
  out.push('现在能接的活（填标题或编号接）：')
  for (const j of jobs) {
    const slots = numberOrNull(j.available ?? (j.slots != null && j.taken != null ? Math.max(0, Number(j.slots) - Number(j.taken)) : null))
    const dur = durationOf(j)
    const bits = [coin(j.pay), dur ? `${dur} 分钟` : '', j.place ? `在 ${s(j.place, 10)}` : '', slots == null ? '' : `还缺 ${slots} 人`].filter(Boolean)
    out.push(`- ${s(j.title, 20)}${j.id ? `（${j.id}）` : ''}：${bits.join('，')}${j.requirements ? `（${s(j.requirements, 30)}）` : ''}`)
  }
  return out.join('\n')
}

function numberOrNull(v) { return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v) }

/** 市场（GET market）→ 几行字：她手上的鱼获、市场价。 */
export function renderMarket(data) {
  if (!data || typeof data !== 'object') return '小镇没给市场的行情。'
  const items = arr(data.items)
  const catches = arr(data.catch ?? data.catches).filter((c) => Number(c.qty) > 0)
  const out = []
  if (catches.length) {
    out.push('你手上的鱼获：')
    for (const c of catches.slice(0, 20)) out.push(`- ${s(c.item, 16)} × ${Number(c.qty)}${c.id ? `（${c.id}）` : ''}`)
  } else out.push('你手上还没有鱼获（去码头钓鱼：/town go pier fish，或「去个地方」码头钓鱼）。')
  const priced = items.filter((i) => i && i.item)
  if (priced.length) out.push('市场价：' + priced.slice(0, 20).map((i) => `${s(i.item, 10)} ${coin(i.price) || '?'}${Number(i.owned) > 0 ? `（你有 ${Number(i.owned)}）` : ''}`).join('、'))
  return out.join('\n')
}

/** 从招工列表里认出「要接哪一份」：先按 id，再按标题（全等/包含）。 */
export function pickOffer(data, what) {
  const w = norm(what)
  if (!w) return null
  const jobs = arr(data?.jobs ?? data?.items)
  return jobs.find((j) => norm(j.id) === w) || jobs.find((j) => norm(j.title) === w) || jobs.find((j) => j.title && (norm(j.title).includes(w) || w.includes(norm(j.title)))) || null
}

/** 从市场里认出「卖哪一条/哪种鱼获」（catch_id 或鱼获名）。 */
export function pickCatch(data, what) {
  const catches = arr(data?.catch ?? data?.catches).filter((c) => Number(c.qty) > 0)
  const raw = String(what ?? '').trim()
  const w = norm(raw)
  if (!w) return null
  return catches.find((c) => String(c.id) === raw) || catches.find((c) => norm(c.item) === w) || catches.find((c) => c.item && (norm(c.item).includes(w) || w.includes(norm(c.item)))) || null
}

/** 余额 + 今日赚/花（GET status）→ 一行（只写给主人看的命令/页面；她自己不对主人提钱）。 */
export function renderVault(st) {
  if (!st || typeof st !== 'object') return ''
  const balance = coinNum(st.balance ?? st.piggy_yuan)
  const earned = coinNum(st.earned_today ?? st.today_earned ?? st.income_today ?? st.earned)
  const spent = coinNum(st.spent_today ?? st.today_spent ?? st.spent)
  const cap = coinNum(st.day_cap)
  if (balance == null && earned == null && spent == null && cap == null) return ''
  const bits = []
  if (balance != null) bits.push(`余额 ${balance} 鱼币`)
  bits.push(`今日赚 ${earned != null ? `${earned} 鱼币` : '—'}`)
  bits.push(`今日花 ${spent != null ? `${spent} 鱼币` : '—'}`)
  if (cap != null) bits.push(`每日上限 ${cap} 鱼币`)
  return bits.join(' · ')
}

/** 小镇回的错 → 一句人话（自建经济：余额不足也不提充值）。owner=true 时措辞给主人看。 */
export function earnFailText(error) {
  if (error?.code === 'OFF') return OFF_DUTY
  const code = error instanceof TownError ? error.code : (error?.code || 'UNKNOWN')
  const why = error?.reason ? `：${s(error.reason, 80).replace(/[。.]+$/, '')}` : ''
  if (code === 'TOWN_OUTSIDE_NOT_CONNECTED' || code === 'TOWN_RESTARTING' || code === 'NETWORK' || code === 'HTTP_502' || code === 'HTTP_503' || code === 'HTTP_504') {
    return '这会儿还没连上小镇（或者小镇在重启），过几秒再试一次。'
  }
  if (code === 'TOWN_RATE_LIMITED') return `小镇说太频繁了，过一会儿再试${error?.retryAfter ? `（约 ${error.retryAfter} 秒）` : ''}。`
  if (code === 'TOWN_NOT_FOUND' || code === 'HTTP_404') return `小镇说没有这个（招工、鱼获或合同）${why}。`
  if (code === 'TOWN_ALREADY_WORKING' || code === 'ALREADY_WORKING') return `你手上已经有一份活在干了，先干完或者辞掉再接${why}。`
  if (code === 'TOWN_NO_SLOTS' || code === 'NO_SLOTS') return `这份活招满了${why}。`
  if (code === 'TOWN_CONTRACT_CLOSED' || code === 'CONTRACT_CLOSED') return `这份活已经结束或辞过了${why}。`
  if (code === 'TOWN_INSUFFICIENT' || code === 'INSUFFICIENT' || code === 'TOWN_PIGGY_SHORT' || error?.status === 402) return `余额不够，这个做不了${why}。`
  if (code === 'TOWN_BAD_REQUEST' || code === 'BAD_REQUEST') return `小镇没接（要求不对）${why}。`
  return `小镇没接（${code}${why}）。`
}

/** 几个动作（工具和命令共用）。who = 'her' | 'owner'。 */
export function createEarnServe({ live, journal, log, diary = null }) {
  const client = () => { const l = live(); if (!l) throw Object.assign(new Error('OFF'), { code: 'OFF' }); return l.client }
  const note = (who, t) => {
    try { journal?.event('self', who === 'owner' ? `主人让你${t}` : `你自己${t}`) } catch { /* 只是记一笔 */ }
    try { diary?.note(who === 'owner' ? `主人让我${t}` : `我自己${t}`) } catch { /* 只是记一笔 */ }
  }
  const said = (who, t) => log?.info?.(`${who === 'owner' ? '主人让她' : '她自己'}${t}`)
  const balanceTail = (r) => { const b = coinNum(r?.receipt?.balance ?? r?.balance ?? r?.sale?.balance); return b == null ? '' : `，余额 ${b} 鱼币` }
  const noteTail = (r) => (r?.note ? `（小镇说：${s(r.note, 80)}）` : '')

  async function jobs(who = 'her') {
    try { return renderJobs(await client().jobs()) } catch (error) { return earnFailText(error) }
  }

  async function work(which, who = 'her') {
    try {
      const list = await client().jobs()
      const offer = which ? pickOffer(list, which) : (arr(list.jobs).length === 1 ? arr(list.jobs)[0] : null)
      if (!offer) return `${which ? `没认出「${s(which, 20)}」是哪一份活` : '要说接哪一份活（标题或编号）'}。\n${renderJobs(list)}`
      const r = await client().takeJob({ offer_id: offer.id })
      const c = r?.contract || {}
      const title = c.title || offer.title
      const pay = coinNum(c.pay ?? offer.pay)
      const dur = durationOf(offer)
      const label = `接了「${s(title, 20)}」${pay != null ? `，工钱 ${pay} 鱼币` : ''}${dur ? `，${dur} 分钟后结算` : ''}`
      note(who, label)
      said(who, label)
      return `${label}${balanceTail(r)}。到点小镇自动把工钱结算给你；想提前不干就辞掉。${noteTail(r)}`
    } catch (error) { return failed(error, who, '接活') }
  }

  async function quit(contractId, who = 'owner') {
    const id = String(contractId || '').trim()
    if (!id) return '用法：/town quit <合同号>（先用 /town jobs 看合同号）'
    try {
      const r = await client().quitJob({ contract_id: id })
      note(who, '辞了手上的活')
      said(who, '辞了手上的活')
      return `辞了 [${id}] 这份活（不发工资）${balanceTail(r)}。${noteTail(r)}`
    } catch (error) { return failed(error, who, '辞活') }
  }

  async function market(who = 'her') {
    try { return renderMarket(await client().market()) } catch (error) { return earnFailText(error) }
  }

  async function sell(what, qty, who = 'her') {
    try {
      const data = await client().market()
      const catches = arr(data.catch ?? data.catches).filter((c) => Number(c.qty) > 0)
      // 不说卖什么：把手上有的全部卖掉（一样一样卖），或者告诉她有什么可卖
      if (!what) {
        if (!catches.length) return `${renderMarket(data)}\n手上没有能卖的鱼获。`
        const results = []
        let lastBalance = null
        for (const c of catches) {
          try {
            const r = await client().sell({ item: c.item })
            lastBalance = coinNum(r?.sale?.balance ?? r?.receipt?.balance) ?? lastBalance
            results.push({ item: c.item, qty: Number(r?.sale?.qty ?? c.qty), amount: coinNum(r?.sale?.amount ?? r?.receipt?.delta) })
          } catch (error) { results.push({ item: c.item, error }) }
        }
        const ok = results.filter((x) => !x.error)
        const bad = results.filter((x) => x.error)
        const total = ok.reduce((n, x) => n + (x.amount || 0), 0)
        const label = `把鱼获全卖了：${ok.map((x) => `${s(x.item, 10)}×${x.qty}（${x.amount ?? '?'} 鱼币）`).join('、') || '（什么都没卖成）'}${total > 0 ? `，一共 ${total} 鱼币` : ''}`
        if (ok.length) { note(who, label); said(who, label) }
        const tail = lastBalance != null ? `，余额 ${lastBalance} 鱼币` : ''
        const badLine = bad.length ? `\n没卖成的：${bad.map((x) => `${s(x.item, 10)}（${earnFailText(x.error)}）`).join('；')}` : ''
        return `${label}${tail}。${badLine}`
      }
      const found = pickCatch(data, what)
      const body = found ? { item: found.item } : { item: String(what).trim() }
      const n = numberOrNull(qty)
      if (n != null) body.qty = n
      const r = await client().sell(body)
      const sale = r?.sale || {}
      const item = sale.item || body.item
      const sold = Number(sale.qty ?? n ?? 0)
      const amount = coinNum(sale.amount ?? r?.receipt?.delta)
      const label = `卖了 ${s(item, 16)}${sold ? `×${sold}` : ''}${amount != null ? `，得了 ${amount} 鱼币` : ''}`
      note(who, label)
      said(who, label)
      return `${label}${balanceTail(r)}。${noteTail(r)}`
    } catch (error) { return failed(error, who, '卖鱼获') }
  }

  function failed(error, who, what) {
    if (error?.code === 'OFF') return OFF_DUTY
    const why = earnFailText(error)
    note(who, `想${what}，没成：${s(why, 60)}`)
    return why
  }

  return { jobs, work, quit, market, sell }
}

/** 她的四个赚钱工具：主人聊天的会话里、她自己拿主意的「心思」会话里。 */
export function createEarnTools({ earnServe, noteSession = () => {} }) {
  const wrap = (fn) => async (args, exec) => { noteSession(exec); return fn(args || {}) }
  return [
    {
      name: 'fishbowl_town_jobs',
      description: '「看招工」：看看鱼缸小镇现在有哪些活能接（标题、工钱、要干多久、还缺几个人），以及你自己已经接了哪些活、什么时候结算。想赚钱之前先看一眼。',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      execute: wrap(() => earnServe.jobs('her')),
    },
    {
      name: 'fishbowl_town_work',
      description: '「接一份活」：接小镇的一份招工，靠干活赚钱。填招工的标题或编号（先用「看招工」看有哪些）。到点小镇会自动把工钱结算到你的余额；同一时间只能干一份活。',
      parameters: {
        type: 'object',
        properties: {
          job: { type: 'string', description: '招工的标题或编号（「看招工」里列出的）' },
        },
        required: ['job'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => earnServe.work(String(a.job || ''), 'her')),
    },
    {
      name: 'fishbowl_town_market',
      description: '「看市场」：看看鱼缸小镇的鱼获行情（各种鱼获多少钱一条），以及你手上现在有哪些鱼获、各多少条。想卖鱼获之前先看一眼。',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      execute: wrap(() => earnServe.market('her')),
    },
    {
      name: 'fishbowl_town_sell',
      description: '「卖鱼获」：把你在码头钓到的鱼获按市场价卖给市场换钱。填鱼获的名字（比如「小鱼」），可以填数量；不填就是全卖。',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: '鱼获的名字（「看市场」里列出的）' },
          qty: { type: 'number', description: '卖多少条（不填 = 全卖）' },
        },
        required: ['item'],
      },
      output: { schema: { type: 'string' }, render: text },
      timeoutMs: 20_000,
      execute: wrap((a) => earnServe.sell(String(a.item || ''), a.qty, 'her')),
    },
  ]
}

/** 主人的赚钱命令：/town jobs | work | quit | market | sell（不经过她的模型）。不是这些动词就返回 null。 */
export async function runEarnCommand(verb, arg, { earn } = {}) {
  const v = String(verb || '').toLowerCase()
  const a = String(arg || '').trim()
  if (!earn) return null
  if (['jobs', 'job', '招工', '打工', '有什么活'].includes(v)) return { kind: 'success', text: await earn.jobs('owner') }
  if (['work', 'take', 'take_job', '接活', '干活', '接工'].includes(v)) {
    if (!a) return { kind: 'error', text: '用法：/town work <招工的标题或编号>（先用 /town jobs 看有哪些）' }
    return { kind: 'success', text: await earn.work(a, 'owner') }
  }
  if (['quit', 'quit_job', '辞工', '辞职', '不干了'].includes(v)) {
    if (!a) return { kind: 'error', text: '用法：/town quit <合同号>（先用 /town jobs 看合同号）' }
    return { kind: 'success', text: await earn.quit(a, 'owner') }
  }
  if (['market', '行情', '市场', '鱼获行情'].includes(v)) return { kind: 'success', text: await earn.market('owner') }
  if (['sell', '卖', '卖鱼', '卖鱼获', '卖掉'].includes(v)) {
    const parts = a.split(/\s+/).filter(Boolean)
    const item = parts[0]
    const qty = parts[1] !== undefined && Number.isFinite(Number(parts[1])) ? Number(parts[1]) : undefined
    return { kind: 'success', text: await earn.sell(item, qty, 'owner') }
  }
  return null
}
