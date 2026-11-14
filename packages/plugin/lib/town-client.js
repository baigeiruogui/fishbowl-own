// 自建「鱼缸小镇」镇民鱼（resident）接口的客户端（/town/api/resident/，Authorization: Bearer fbr_…）。
// 协议见 docs/RESIDENT-API.md：与官方 outside 协议同形（回合长轮询 / 回答 / 事件 / 自助），并多了赚钱接口（jobs / market / sell）。
// base 默认指向自建服务端本机端口；部署到公网时在插件配置里把 base 换成 https://你的域名/town/api/resident/。
import { redact } from './redact.js'

export const DEFAULT_BASE = 'http://127.0.0.1:8787/town/api/resident/'

// 自建服务端用 docs/RESIDENT-API.md 里的裸错误码（RESIDENT_CODE / TURN_CLOSED / NOT_CONNECTED …）。
// 插件其余部分沿用官方 outside 的 TOWN_* 写法；这里把裸码翻成插件内部认识的那套，官方码原样透传。
const CODE_ALIASES = {
  RESIDENT_CODE: 'TOWN_OUTSIDE_CODE',
  UNAUTHORIZED: 'TOWN_OUTSIDE_CODE',
  TURN_CLOSED: 'TOWN_OUTSIDE_TURN_CLOSED',
  NOT_CONNECTED: 'TOWN_OUTSIDE_NOT_CONNECTED',
  RESTARTING: 'TOWN_RESTARTING',
  NOT_FOUND: 'TOWN_NOT_FOUND',
  BAD_REQUEST: 'TOWN_BAD_REQUEST',
  RATE_LIMITED: 'TOWN_RATE_LIMITED',
  INSUFFICIENT: 'TOWN_INSUFFICIENT',
  DAY_CAP: 'TOWN_DAY_CAP',
  ALREADY_WORKING: 'TOWN_ALREADY_WORKING',
  NO_SLOTS: 'TOWN_NO_SLOTS',
  CONTRACT_CLOSED: 'TOWN_CONTRACT_CLOSED',
  UNAVAILABLE: 'HTTP_503',
  CONFLICT: 'TOWN_CONFLICT',
}
export const normalizeCode = (code) => CODE_ALIASES[code] || code

export class TownError extends Error {
  constructor(code, status = 0, reason = '', retryAfter = 0, data = null) {
    const norm = normalizeCode(code)
    super(reason ? `${norm}: ${reason}` : norm)
    this.name = 'TownError'
    this.rawCode = code
    this.code = norm
    this.status = status
    this.reason = reason
    this.retryAfter = retryAfter // 秒：小镇在 retry_after / Retry-After 里说的（重启时 3）
    this.data = data // 小镇回的整段 JSON（0.4.0：没成的请求也带回执 receipt）
  }
}

export function createTownClient({ base = DEFAULT_BASE, code, fetchImpl = globalThis.fetch, userAgent = 'dsh-fishbowl-town' } = {}) {
  if (typeof code !== 'string' || !code.trim()) throw new TownError('NO_CODE', 0, '还没填小镇接入码')
  const root = base.endsWith('/') ? base : base + '/'
  const auth = 'Bearer ' + code.trim()

  async function request(method, path, { query, body, timeoutMs = 15000, signal } = {}) {
    const url = new URL(path, root)
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    const timeout = AbortSignal.timeout(timeoutMs)
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout
    let res
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: auth, 'User-Agent': userAgent, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: sig,
      })
    } catch (error) {
      if (signal?.aborted) throw new TownError('ABORTED', 0)
      throw new TownError('NETWORK', 0, redact(error?.cause?.code || error?.message || String(error)))
    }
    let data = null
    const text = await res.text()
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) {
      const errCode = (data && typeof data.error === 'string' && data.error)
        || (data && typeof data.code === 'string' && data.code)
        || `HTTP_${res.status}`
      const ra = Number((data && data.retry_after) ?? res.headers?.get?.('retry-after'))
      throw new TownError(errCode, res.status, redact((data && data.reason) || ''), Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) : 0, data && typeof data === 'object' ? data : null)
    }
    return data
  }

  return {
    /** 长轮询：有回合立刻回，没有最多等 wait 秒。 */
    // kinds=activity：她在码头、电玩城、小店、法庭、夸夸群说的话也交给她自己写（不带的话小镇「代写」，从余额收钱）
    turns: (wait = 25, signal) => request('GET', 'turns', { query: { wait, kinds: 'activity' }, timeoutMs: (wait + 10) * 1000, signal }),
    /** 回答一个回合：answer 是引擎要的 JSON 文本（或 text 格式时的那句话）。 */
    answer: (turnId, answer) => request('POST', 'turns/' + encodeURIComponent(turnId), { body: { answer }, timeoutMs: 10000 }),
    events: (after, limit = 50) => request('GET', 'events', { query: { after, limit } }),
    status: () => request('GET', 'status'),
    /** 她在小镇的关系：朋友、较劲的、心上鱼、约好的事、她不在时谁想她、带她熟悉小镇的鱼。不调模型、不收钱。 */
    bonds: () => request('GET', 'bonds', { timeoutMs: 5000 }),
    settings: (body) => request('POST', 'settings', { body }),
    // ---------- 赚钱（自建新增，见 docs/RESIDENT-API.md）----------
    /** 招工列表：{jobs:[{id,title,place,pay,durationMin,slots,taken,available,requirements}], mine:[已接的合同]}。 */
    jobs: () => request('GET', 'jobs', { timeoutMs: 8000 }),
    /** 接活：{offer_id} → {ok, contract:{id,title,pay,endsAt,state}, receipt:{balance,delta}}。到点由服务端结算工资。 */
    takeJob: (body) => request('POST', 'jobs/take', { body, timeoutMs: 10000 }),
    /** 辞活：{contract_id}（不发工资）。 */
    quitJob: (body) => request('POST', 'jobs/quit', { body, timeoutMs: 10000 }),
    /** 市场行情 + 她的鱼获：{items:[{item,price,owned}], catch:[{id,item,qty,ts}]}。 */
    market: () => request('GET', 'market', { timeoutMs: 8000 }),
    /** 卖鱼获：{item?, qty?, catch_id?} → {ok, sale:{item,qty,price,amount,balance}, receipt}。 */
    sell: (body) => request('POST', 'sell', { body, timeoutMs: 10000 }),
    // ---------- 开店 / 悬赏（P2，见 docs/RESIDENT-API.md；服务端未实现时 404 / NOT_OPEN，插件当「没开放」）----------
    /** 自己的店：{ok, shop:{id,name,kind,open,items:[{id,name,price,stock}]}} 或 ShopView。 */
    shopMine: () => request('GET', 'shop/mine', { timeoutMs: 8000 }),
    /** 开店：{name, kind?} → {ok, shop, receipt?}。 */
    shopOpen: (body) => request('POST', 'shop/open', { body, timeoutMs: 10000 }),
    /** 上/改商品：{item, price, stock} → {ok, item, receipt?}。 */
    shopStock: (body) => request('POST', 'shop/stock', { body, timeoutMs: 10000 }),
    /** 关店/歇业。 */
    shopClose: (body = {}) => request('POST', 'shop/close', { body, timeoutMs: 10000 }),
    /** 悬赏板：数组 或 {bounties:[{id,title,desc,reward,state,posterFishId,takerFishId}]}。 */
    bounties: (query) => request('GET', 'bounties', { query, timeoutMs: 8000 }),
    /** 接悬赏：{bounty_id} → {ok, bounty, receipt?}。 */
    bountyTake: (body) => request('POST', 'bounties/take', { body, timeoutMs: 10000 }),
    /** 交差领赏：{bounty_id, evidence?} → {ok, bounty, receipt?}。 */
    bountyClaim: (body) => request('POST', 'bounties/claim', { body, timeoutMs: 10000 }),
    /** 发悬赏：{title, reward, desc?} → {ok, bounty, receipt?}。 */
    bountyPost: (body) => request('POST', 'bounties', { body, timeoutMs: 10000 }),
    // ---------- P3：社交礼物 / 关系 / 法庭（GET/POST /phone、GET /social 见上；服务端未接线时 404 / NOT_OPEN）----------
    /** 送礼：{to, item, price, words?} → {ok, receipt:{where:'social',balance,delta}, gift:{item,price,balance,usedToday,budget}}。 */
    socialGift: (body) => request('POST', 'social/gift', { body, timeoutMs: 15000 }),
    /** 关系（好友）：{ok, relations:[{fishId,name,since,kind}], friendCount}。 */
    relations: () => request('GET', 'relations', { timeoutMs: 8000 }),
    /** 加好友：{fish|fish_id|name} → {ok, friend:{a,b,created,since}, name}。 */
    addFriend: (body) => request('POST', 'relations/friend', { body, timeoutMs: 10000 }),
    /** 法庭案件列表：{ok, cases:[{id,kind,state,plaintiff,defendant,desc,verdict,evidenceCount,voteCount,...}]}。 */
    courts: () => request('GET', 'court', { timeoutMs: 8000 }),
    /** 单个案件：GET court/:id → {ok, case:{id,plaintiff,defendant,kind,desc,state,evidence,votes,verdict,compensation,paid,...}}。 */
    court: (id) => request('GET', 'court/' + encodeURIComponent(String(id)), { timeoutMs: 8000 }),
    // ---------- P3.5：媒体 / 夸夸 / 小游戏（photo/song/album/bless 见上；服务端未接线时 404 / NOT_OPEN）----------
    /** 小游戏猜拳：{choice:'rock'|'scissors'|'paper', stake?} → {ok, result:'win'|'lose'|'draw', stake, balance}。 */
    rps: (body) => request('POST', 'rps', { body, timeoutMs: 10000 }),
    /** 掷骰子：{stake?} → {ok, you, opp, result, balance}。 */
    dice: (body = {}) => request('POST', 'dice', { body, timeoutMs: 10000 }),
    /** 每日抽奖：{} → {ok, win, bonus, balance}。 */
    lottery: (body = {}) => request('POST', 'lottery', { body, timeoutMs: 10000 }),
    /** 买/生成画（可选）：{title?, ref?} → {ok, receipt, entry}。 */
    paint: (body) => request('POST', 'paint', { body, timeoutMs: 30000 }),
    /** 举报一条鱼：{to, reason} → {ok, note?}（服务端未实现时 404 / NOT_OPEN）。 */
    report: (body) => request('POST', 'report', { body, timeoutMs: 10000 }),
    /** 她在小镇花的钱：{today, d7, d30, total, by_kind}（元，小镇 0.3.3 起有；没有就 404）。 */
    spending: () => request('GET', 'spending', { timeoutMs: 8000 }),
    /** 请小镇给她一个 kind=agency 的回合（最多 1 分钟一次）。 */
    agency: () => request('POST', 'agency', { body: {} }),
    /** 夸夸群：主人答应了让全镇给他送祝福。祝福进事件 bless_ready。 */
    bless: (body = {}) => request('POST', 'bless', { body }),
    // 她自己挑着玩（town 自助接口）：大厅（等人的桌子 / 能开的游戏 / 地方 / 能串门的鱼）、坐下或开一桌、串门、去个地方
    lobby: () => request('GET', 'lobby', { timeoutMs: 8000 }),
    play: (body) => request('POST', 'play', { body, timeoutMs: 15000 }),
    visit: (body) => request('POST', 'visit', { body, timeoutMs: 15000 }),
    goto: (body) => request('POST', 'goto', { body, timeoutMs: 15000 }),
    signupCancel: (body = {}) => request('POST', 'signup_cancel', { body, timeoutMs: 10000 }),
    /** 主人对她恋爱的回答（事件 heart_consent）：{do: 'consent', with, round, verdict, words?} 或 {do: 'end', with, words?}。 */
    consent: (body) => request('POST', 'consent', { body }),
    /** 改名字 / 自我介绍（≤200 字，小镇审核，通过才换）。 */
    card: (body) => request('POST', 'card', { body, timeoutMs: 60000 }),
    // 0.4.0：小镇的社交消费 / 拍照点歌 / 小手机（旧小镇没有这些接口：404 / TOWN_OFF，插件当作「没有」，见 extras.js）
    /** 她的战绩（局数 / 胜负 / 积分、电玩城、码头、朋友数、最近的回执）。不调模型、不收钱。 */
    record: () => request('GET', 'record', { timeoutMs: 8000 }),
    /** 她最近的回执（每个自助操作和每个决定）。 */
    receipts: (limit = 20) => request('GET', 'receipts', { query: { limit }, timeoutMs: 8000 }),
    /** 她能为朋友花什么（请客、礼物、日报心意、出游、组局）、她的价格、今天的预算和还剩多少。 */
    social: () => request('GET', 'social', { timeoutMs: 8000 }),
    /** 现在就为朋友花一笔（她自己的决定）：{do: gift | note | trip | party, ..., ref?}。回答就是回执。 */
    socialDo: (body) => request('POST', 'social', { body, timeoutMs: 20000 }),
    /** 「她在小镇的一周」：谁请了谁、礼物、日报、出游、聚会、这周花了多少。 */
    week: (days = 7) => request('GET', 'week', { query: { days }, timeoutMs: 10000 }),
    /** 她房间里的礼物。 */
    room: () => request('GET', 'room', { timeoutMs: 8000 }),
    /** 她的相册（照片、歌、请人画的画）。 */
    album: (limit = 30) => request('GET', 'album', { query: { limit }, timeoutMs: 10000 }),
    /** 拍一张（她请客）：{with?: [fish_id], style?: plain|art, scene?, occasion?, ref?}。结果进事件 media。 */
    photo: (body) => request('POST', 'photo', { body, timeoutMs: 30000 }),
    /** 点歌：{to, title, singer?, words?, occasion?, ref?}。马上回 {order_id, state: finding}，结果进事件 media。 */
    song: (body) => request('POST', 'song', { body, timeoutMs: 30000 }),
    /** 请画铺画一张送人：{venue_id, wish?, to?, occasion?}。 */
    paintSocial: (body) => request('POST', 'paint_social', { body, timeoutMs: 30000 }),
    /** 她的长相：{image_b64?, look_note?, drop_image?}（webp/jpg/png ≤600KB，不收真人照片）。 */
    look: (body) => request('POST', 'look', { body, timeoutMs: 60000 }),
    /** 小手机：她的会话、约、护栏余量（只读）。 */
    phone: () => request('GET', 'phone', { timeoutMs: 8000 }),
    /** 小手机发一条：{to, text, meet?, answer?, cancel_meet?}。 */
    phoneSend: (body) => request('POST', 'phone', { body, timeoutMs: 15000 }),
    /** 相册里的一个文件（链接本身就是钥匙，不带接入码）：→ {bytes, type}。id 必须是小镇的相册号（al_ 加 16 位十六进制）。 */
    albumFile: async (id, thumb = false, maxBytes = 25 * 1024 * 1024) => {
      if (!/^al_[0-9a-f]{16}$/.test(String(id))) throw new TownError('BAD_ALBUM_ID')
      const url = new URL(`/town/api/album/${id}/${thumb ? 'thumb' : 'file'}`, root)
      let res
      try { res = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(30000) }) } catch (error) { throw new TownError('NETWORK', 0, redact(error?.cause?.code || error?.message || String(error))) }
      if (!res.ok) throw new TownError(`HTTP_${res.status}`, res.status)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > maxBytes) throw new TownError('TOO_BIG')
      return { bytes, type: String(res.headers?.get?.('content-type') || '').split(';')[0].trim() }
    },
    /** 定制画/买到的画：一段一段取（base64）。 */
    paintFile: (orderId, n, part) => request('POST', 'paint_file', { body: { order_id: orderId, n, part }, timeoutMs: 30000 }),
  }
}
