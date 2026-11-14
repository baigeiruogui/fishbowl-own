// 本地 mock 数据：server 未就绪时前端兜底渲染，同时也是 mock/api-server.mjs 的数据来源。
// 所有时间用「分钟前」的偏移表示，运行时换算成绝对时间戳，保证「今日」统计始终有意义。
import type {
  AlbumPayload,
  BlessPayload,
  BoardEntry,
  BoardPayload,
  CourtCase,
  CourtPayload,
  DateCard,
  FishDetail,
  FishKind,
  FishStatus,
  FishSummary,
  FishProfile,
  GalleryPayload,
  GameDef,
  LedgerEntry,
  LobbyPayload,
  LobbyTable,
  PaperItem,
  PaperPayload,
  PartyView,
  PhoneConversation,
  PhonePayload,
  Place,
  RecentItem,
  RelationFish,
  RelationsPayload,
  TableAction,
  TableDetail,
  TableSeat,
  TownInfo,
  TownPayload,
} from './types.ts'
import { startOfLocalDay } from './format.ts'

interface SeedFish {
  id: string
  name: string
  kind: FishKind
  avatar: string
  intro: string
  persona: string
  ownerName: string | null
  status: FishStatus
  dayCap: number | null
  createdDaysAgo: number
  online: boolean
}

interface SeedLedger {
  fishId: string
  delta: number
  reason: string
  ref: string | null
  minutesAgo: number
}

export const MOCK_TOWN_NAME = '鱼缸小镇'

const SEED_FISH: SeedFish[] = [
  {
    id: 'f_xiaoyuanzi',
    name: '小圆子',
    kind: 'resident',
    avatar: '🐟',
    intro: '一条圆滚滚、爱在码头钓鱼的小鱼，赚到钱就想去电玩城。',
    persona: '温柔、好奇、有点小财迷，喜欢把赚到的鱼币存起来买奶茶。',
    ownerName: '阿澈',
    status: 'active',
    dayCap: 200,
    createdDaysAgo: 9,
    online: true,
  },
  {
    id: 'f_ajing',
    name: '阿鲸',
    kind: 'resident',
    avatar: '🐳',
    intro: '镇上的大块头，什么活都肯干，尤其擅长搬货和接悬赏。',
    persona: '憨厚、讲义气、话不多，乐于帮别的鱼垫付座位费。',
    ownerName: '小满',
    status: 'active',
    dayCap: null,
    createdDaysAgo: 14,
    online: true,
  },
  {
    id: 'f_paopao',
    name: '泡泡',
    kind: 'npc',
    avatar: '🫧',
    intro: '镇长养的 NPC 镇民，开着一家小卖部，最爱逛街购物。',
    persona: '热情、话痨、精打细算的老板娘。',
    ownerName: '镇长',
    status: 'active',
    dayCap: null,
    createdDaysAgo: 30,
    online: true,
  },
  {
    id: 'f_meiqiu',
    name: '煤球',
    kind: 'npc',
    avatar: '🐡',
    intro: '一条圆滚滚的刺鲀 NPC，常出没在牌桌边看热闹。',
    persona: '慢热、爱凑热闹、输了钱会鼓成球。',
    ownerName: '镇长',
    status: 'active',
    dayCap: null,
    createdDaysAgo: 30,
    online: false,
  },
]

const SEED_LEDGER: SeedLedger[] = [
  // 小圆子
  { fishId: 'f_xiaoyuanzi', delta: 100, reason: 'init', ref: '新鱼启动资金', minutesAgo: 2880 },
  { fishId: 'f_xiaoyuanzi', delta: 30, reason: 'job', ref: '码头搬货（2 小时）', minutesAgo: 600 },
  { fishId: 'f_xiaoyuanzi', delta: 18, reason: 'fish_sell', ref: '卖 2 条小鱼', minutesAgo: 420 },
  { fishId: 'f_xiaoyuanzi', delta: -10, reason: 'seat_fee', ref: '斗地主入座', minutesAgo: 300 },
  { fishId: 'f_xiaoyuanzi', delta: 60, reason: 'game_win', ref: '斗地主赢底池', minutesAgo: 240 },
  { fishId: 'f_xiaoyuanzi', delta: -25, reason: 'buy', ref: '在泡泡小卖部买奶茶', minutesAgo: 120 },
  { fishId: 'f_xiaoyuanzi', delta: 35, reason: 'job', ref: '奶茶店打工（1 小时）', minutesAgo: 75 },
  { fishId: 'f_xiaoyuanzi', delta: -8, reason: 'social', ref: '请阿鲸喝汽水', minutesAgo: 35 },
  { fishId: 'f_xiaoyuanzi', delta: 22, reason: 'fish_sell', ref: '卖 3 条小鱼', minutesAgo: 8 },
  // 阿鲸
  { fishId: 'f_ajing', delta: 100, reason: 'init', ref: '新鱼启动资金', minutesAgo: 3000 },
  { fishId: 'f_ajing', delta: 30, reason: 'job', ref: '码头搬货（3 小时）', minutesAgo: 540 },
  { fishId: 'f_ajing', delta: 80, reason: 'bounty', ref: '悬赏：找回走失的猫', minutesAgo: 360 },
  { fishId: 'f_ajing', delta: -20, reason: 'gift', ref: '送小圆子一颗珍珠', minutesAgo: 180 },
  { fishId: 'f_ajing', delta: 45, reason: 'shop_sale', ref: '阿鲸鱼铺卖出 1 份鱼干', minutesAgo: 90 },
  { fishId: 'f_ajing', delta: -10, reason: 'seat_fee', ref: '麻将入座', minutesAgo: 25 },
  // 泡泡（NPC）
  { fishId: 'f_paopao', delta: 500, reason: 'init', ref: 'NPC 镇民初始资金', minutesAgo: 5000 },
  { fishId: 'f_paopao', delta: 25, reason: 'shop_sale', ref: '小卖部卖出奶茶', minutesAgo: 120 },
  { fishId: 'f_paopao', delta: -35, reason: 'buy', ref: '进货：鱼干 5 份', minutesAgo: 60 },
  { fishId: 'f_paopao', delta: 12, reason: 'fish_sell', ref: '卖 1 条小鱼', minutesAgo: 15 },
  // 煤球（NPC）
  { fishId: 'f_meiqiu', delta: 500, reason: 'init', ref: 'NPC 镇民初始资金', minutesAgo: 4800 },
  { fishId: 'f_meiqiu', delta: -10, reason: 'seat_fee', ref: '看牌桌交座位费', minutesAgo: 200 },
  { fishId: 'f_meiqiu', delta: -15, reason: 'gift', ref: '给泡泡送海草', minutesAgo: 70 },
]

interface BuiltMock {
  town: TownInfo
  recent: RecentItem[]
  fish: FishProfile[]
  ledgerByFish: Map<string, LedgerEntry[]>
}

let cached: BuiltMock | null = null
let cachedAt = 0

function build(now = Date.now()): BuiltMock {
  if (cached && now - cachedAt < 30_000) return cached

  const ledgerByFish = new Map<string, LedgerEntry[]>()
  const sorted = [...SEED_LEDGER].sort((a, b) => a.minutesAgo - b.minutesAgo) // 先发生的在前
  const balances = new Map<string, number>()
  let seq = 1
  const allEntries: { entry: LedgerEntry; fishName: string }[] = []

  for (const seed of sorted) {
    const ts = now - seed.minutesAgo * 60_000
    const prev = balances.get(seed.fishId) ?? 0
    const after = prev + seed.delta
    balances.set(seed.fishId, after)
    const entry: LedgerEntry = {
      id: seq++,
      fishId: seed.fishId,
      delta: seed.delta,
      balanceAfter: after,
      reason: seed.reason,
      ref: seed.ref,
      ts,
    }
    const list = ledgerByFish.get(seed.fishId) ?? []
    list.push(entry)
    ledgerByFish.set(seed.fishId, list)
  }

  // 按时间倒序 + 组装 recent
  for (const [fishId, list] of ledgerByFish) {
    list.sort((a, b) => b.ts - a.ts)
    const seedFish = SEED_FISH.find((f) => f.id === fishId)!
    for (const e of list) allEntries.push({ entry: e, fishName: seedFish.name })
  }
  allEntries.sort((a, b) => b.entry.ts - a.entry.ts)
  const recent: RecentItem[] = allEntries.slice(0, 12).map(({ entry, fishName }) => ({
    id: `l_${entry.id}`,
    ts: entry.ts,
    fishId: entry.fishId,
    fishName,
    reason: entry.reason,
    delta: entry.delta,
    ref: entry.ref,
  }))

  const dayStart = startOfLocalDay(now)
  let todayEarned = 0
  let todaySpent = 0
  for (const { entry } of allEntries) {
    if (entry.ts < dayStart) continue
    if (entry.delta >= 0) todayEarned += entry.delta
    else todaySpent += -entry.delta
  }

  const fish: FishProfile[] = SEED_FISH.map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
    avatar: f.avatar,
    intro: f.intro,
    persona: f.persona,
    ownerName: f.ownerName,
    balance: balances.get(f.id) ?? 0,
    status: f.status,
    online: f.online,
    dayCap: f.dayCap,
    createdAt: now - f.createdDaysAgo * 86_400_000,
  }))

  const town: TownInfo = {
    name: MOCK_TOWN_NAME,
    onlineFish: fish.filter((f) => f.online).length,
    totalFish: fish.length,
    today: { earned: todayEarned, spent: todaySpent, net: todayEarned - todaySpent },
    currency: '鱼币',
    updatedAt: now,
  }

  cached = { town, recent, fish, ledgerByFish }
  cachedAt = now
  return cached
}

export function mockTown(): TownPayload {
  const built = build()
  return { town: built.town, recent: built.recent }
}

export function mockFishList(): FishSummary[] {
  return build().fish.map(toSummary)
}

export function mockFishDetail(id: string): FishDetail | null {
  const built = build()
  const fish = built.fish.find((f) => f.id === id)
  if (!fish) return null
  const ledger = built.ledgerByFish.get(id) ?? []
  let totalEarned = 0
  let totalSpent = 0
  const dayStart = startOfLocalDay()
  let todayEarned = 0
  let todaySpent = 0
  for (const e of ledger) {
    if (e.delta >= 0) totalEarned += e.delta
    else totalSpent += -e.delta
    if (e.ts >= dayStart) {
      if (e.delta >= 0) todayEarned += e.delta
      else todaySpent += -e.delta
    }
  }
  return {
    fish,
    ledger,
    stats: { todayEarned, todaySpent, totalEarned, totalSpent, entries: ledger.length },
  }
}

function toSummary(f: FishProfile): FishSummary {
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    avatar: f.avatar,
    intro: f.intro,
    balance: f.balance,
    status: f.status,
    online: f.online,
  }
}

// ======================= P2：大厅 / 牌桌 / 积分榜 / 日报（mock） =======================
// 字段与 packages/server/src/api/public-p2.ts 对齐：lobby.table 用 state/seats(0-based)/seatsNeeded/seatFee；
// board 用 rank/wins/losses/winRate/net；paper 用 kind/title/summary/fishId?。

/** 参与牌桌的路人鱼（非核心鱼，仅用于把桌子填满 / 有对手盘）。 */
const EXTRA_FISH: Record<string, { name: string; avatar?: string }> = {
  p_xiaoxia: { name: '小虾', avatar: '🦐' },
  p_beibei: { name: '贝贝', avatar: '🐚' },
  p_haixing: { name: '海星', avatar: '⭐' },
}

function participantName(id: string): string {
  const f = build().fish.find((x) => x.id === id)
  if (f) return f.name
  return EXTRA_FISH[id]?.name ?? id
}

const GAME_DEFS: GameDef[] = [
  {
    id: 'ddz',
    name: '斗地主',
    seats: 3,
    feeFrom: 10,
    durationMin: 8,
    desc: '三人一桌，叫地主抢底池；赢了把底池和座位费一起带走。',
  },
  {
    id: 'mj',
    name: '麻将',
    seats: 4,
    feeFrom: 12,
    durationMin: 15,
    desc: '四人成局，胡牌结算；新手鱼也可以先观战学规则。',
  },
]

const PLACES: Place[] = [
  { id: 'pier', name: '码头', how: '钓鱼 / 游泳 / 赛跑', desc: '吹着海风钓鱼，鱼获可以拿去卖钱。' },
  { id: 'market', name: '鱼市', how: '卖鱼获 / 看行情', desc: '今天的鱼获价还不错。' },
  { id: 'arcade', name: '电玩城', how: '玩机器', desc: '投币玩一把。' },
]

interface SeedTable {
  id: string
  game: string
  state: string
  seatFee: number
  pot: number
  startedMinutesAgo: number
  playerIds: (string | null)[]
  round: number
  turnSeat: number | null
  actions: { text: string; minutesAgo: number }[]
}

const SEED_TABLES: SeedTable[] = [
  {
    id: 't_ddz_1',
    game: 'ddz',
    state: 'waiting',
    seatFee: 10,
    pot: 20,
    startedMinutesAgo: 9,
    playerIds: ['f_xiaoyuanzi', 'f_ajing', null],
    round: 0,
    turnSeat: null,
    actions: [
      { text: '小圆子 入座，交了 10 鱼币座位费', minutesAgo: 6 },
      { text: '阿鲸 入座，交了 10 鱼币座位费', minutesAgo: 4 },
      { text: '阿鲸：还差一位，谁来？', minutesAgo: 3 },
    ],
  },
  {
    id: 't_ddz_2',
    game: 'ddz',
    state: 'playing',
    seatFee: 10,
    pot: 60,
    startedMinutesAgo: 60,
    playerIds: ['p_xiaoxia', 'p_beibei', 'f_meiqiu'],
    round: 5,
    turnSeat: 1,
    actions: [
      { text: '座位 2 出牌：一对 3', minutesAgo: 2 },
      { text: '座位 0 出牌：一对 5', minutesAgo: 1 },
      { text: '贝贝 抢地主成功，底池 +20', minutesAgo: 0 },
    ],
  },
  {
    id: 't_mj_1',
    game: 'mj',
    state: 'waiting',
    seatFee: 12,
    pot: 36,
    startedMinutesAgo: 20,
    playerIds: ['f_ajing', 'p_haixing', 'p_xiaoxia', null],
    round: 0,
    turnSeat: null,
    actions: [
      { text: '阿鲸 入座', minutesAgo: 9 },
      { text: '海星 入座', minutesAgo: 8 },
      { text: '小虾 入座', minutesAgo: 7 },
    ],
  },
  {
    id: 't_mj_2',
    game: 'mj',
    state: 'playing',
    seatFee: 12,
    pot: 96,
    startedMinutesAgo: 90,
    playerIds: ['p_beibei', 'f_paopao', 'p_haixing', 'f_meiqiu'],
    round: 8,
    turnSeat: 3,
    actions: [
      { text: '座位 3 摸牌', minutesAgo: 1 },
      { text: '泡泡 碰了 东风', minutesAgo: 1 },
      { text: '海星 打出一张 九筒', minutesAgo: 0 },
    ],
  },
]

function buildSeats(t: SeedTable): TableSeat[] {
  return t.playerIds.map((id, i) => (id ? { seat: i, fishId: id, name: participantName(id) } : { seat: i }))
}

function toLobbyTable(t: SeedTable): LobbyTable {
  const seats = buildSeats(t)
  const occupied = seats.filter((s) => s.fishId).length
  return {
    id: t.id,
    game: t.game,
    state: t.state,
    seats,
    seatsNeeded: Math.max(0, seats.length - occupied),
    seatFee: t.seatFee,
    pot: t.pot,
    startedAt: Date.now() - t.startedMinutesAgo * 60_000,
  }
}

export function mockLobby(): LobbyPayload {
  const tables = SEED_TABLES.map(toLobbyTable)
  const games = GAME_DEFS.map((g) => ({
    ...g,
    tablesOnline: tables.filter((t) => t.game === g.id && t.state !== 'closed').length,
  }))
  return { tables, games, places: PLACES }
}

export function mockTable(id: string): TableDetail | null {
  const seed = SEED_TABLES.find((t) => t.id === id)
  if (!seed) return null
  const now = Date.now()
  return {
    id: seed.id,
    game: seed.game,
    state: seed.state,
    seatFee: seed.seatFee,
    pot: seed.pot,
    round: seed.round,
    turnSeat: seed.turnSeat,
    seats: buildSeats(seed),
    lastActions: seed.actions
      .map((a) => ({ ts: now - a.minutesAgo * 60_000, text: a.text }))
      .sort((a, b) => b.ts - a.ts),
    updatedAt: now,
  }
}

const BOARD_STATS: Record<string, { wins: number; losses: number; net: number }> = {
  f_xiaoyuanzi: { wins: 12, losses: 8, net: 180 },
  f_ajing: { wins: 9, losses: 11, net: -40 },
  f_paopao: { wins: 15, losses: 5, net: 260 },
  f_meiqiu: { wins: 6, losses: 14, net: -150 },
}

export function mockBoard(): BoardPayload {
  const entries: BoardEntry[] = build()
    .fish.map((f) => {
      const s = BOARD_STATS[f.id] ?? { wins: 0, losses: 0, net: 0 }
      const games = s.wins + s.losses
      return {
        fishId: f.id,
        name: f.name,
        kind: f.kind,
        balance: f.balance,
        wins: s.wins,
        losses: s.losses,
        winRate: games > 0 ? Number((s.wins / games).toFixed(4)) : 0,
        net: s.net,
        rank: 0,
      }
    })
    .sort((a, b) => b.net - a.net || b.balance - a.balance)
    .map((e, i) => ({ ...e, rank: i + 1 }))
  return {
    entries,
    updatedAt: Date.now(),
    note: '积分榜按 game_win / seat_fee / refund 净收益排序（mock 示例）。',
  }
}

function todayStr(now = Date.now()): string {
  const d = new Date(now)
  const p = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const SEED_PAPER: { id: string; kind: string; title: string; summary: string; fishId?: string; minutesAgo: number }[] = [
  {
    id: 'p1',
    kind: 'money',
    title: '码头鱼获大丰收，小圆子卖出 3 条小鱼赚 22 鱼币',
    summary: '今早码头鱼群靠岸，小圆子一上午钓到 3 条小鱼，转手在鱼市卖了 22 鱼币。',
    fishId: 'f_xiaoyuanzi',
    minutesAgo: 95,
  },
  {
    id: 'p2',
    kind: 'games',
    title: '斗地主「珊瑚桌」开打，底池涨到 60 鱼币',
    summary: '贝贝抢下地主，三家你来我往，底池堆到 60 鱼币，围观的三条鱼看得直拍尾巴。',
    fishId: 'p_beibei',
    minutesAgo: 60,
  },
  {
    id: 'p3',
    kind: 'bounty',
    title: '阿鲸完成「找回走失的猫」悬赏，领赏 80 鱼币',
    summary: '悬赏板上的单子被阿鲸接下并交差，发布者当场托管付赏。',
    fishId: 'f_ajing',
    minutesAgo: 40,
  },
  {
    id: 'p4',
    kind: 'money',
    title: '今日经济小结：全镇赚 357、花 133，净增 224 鱼币',
    summary: '今天最赚钱的是打工和卖鱼获，最费钱的是购物和座位费，整体经济在健康增长。',
    minutesAgo: 20,
  },
  {
    id: 'p5',
    kind: 'notice',
    title: '镇长公告：泡泡小卖部上新鱼干，先到先得',
    summary: '小卖部新到一批海苔鱼干，每条鱼限购两份；想囤货的鱼记得早点去。',
    fishId: 'f_paopao',
    minutesAgo: 10,
  },
  {
    id: 'p6',
    kind: 'social',
    title: '小圆子请阿鲸喝汽水，花掉 8 鱼币',
    summary: '两人在码头边看夕阳，小圆子豪气请客，阿鲸说下次轮到他请。',
    fishId: 'f_xiaoyuanzi',
    minutesAgo: 5,
  },
]

export function mockPaper(): PaperPayload {
  const now = Date.now()
  const items: PaperItem[] = SEED_PAPER.map((p) => ({
    id: p.id,
    ts: now - p.minutesAgo * 60_000,
    kind: p.kind,
    title: p.title,
    summary: p.summary,
    ...(p.fishId ? { fishId: p.fishId } : {}),
  })).sort((a, b) => b.ts - a.ts)
  return { date: todayStr(now), items, updatedAt: now }
}

// ======================= P3：法庭 / 关系 / 小手机（mock） =======================

const MIN = 60_000

function fishRef(id: string): RelationFish {
  const f = build().fish.find((x) => x.id === id)
  if (f) return { fishId: f.id, name: f.name, avatar: f.avatar, kind: f.kind }
  return { fishId: id, name: EXTRA_FISH[id]?.name ?? id, avatar: EXTRA_FISH[id]?.avatar ?? '🐟', kind: 'npc' }
}

function party(id: string): PartyView {
  const r = fishRef(id)
  return { fishId: r.fishId, name: r.name }
}

export function mockCourt(): CourtPayload {
  const now = Date.now()
  const at = (m: number) => now - m * MIN
  const cases: CourtCase[] = [
    {
      id: 'case_1',
      title: '偷吃小卖部的鱼干',
      kind: '财产纠纷',
      plaintiff: party('f_paopao'),
      defendant: party('f_meiqiu'),
      state: 'hearing',
      filedAt: at(130),
      updatedAt: at(20),
      verdict: null,
      timeline: [
        { ts: at(130), kind: 'file', title: '立案', detail: '泡泡报案：小卖部少了两包海苔鱼干，监控指向煤球。' },
        { ts: at(95), kind: 'evidence', title: '举证', detail: '原告提交监控截图；被告辩称只是「闻了闻」。' },
        { ts: at(20), kind: 'hearing', title: '开庭', detail: '镇长主持庭审，双方各说各的，等待判决。' },
      ],
    },
    {
      id: 'case_2',
      title: '赖账不还座位费',
      kind: '债务纠纷',
      plaintiff: party('f_ajing'),
      defendant: party('p_xiaoxia'),
      state: 'judged',
      filedAt: at(400),
      updatedAt: at(60),
      verdict: '被告返还 10 鱼币并向原告道歉。',
      timeline: [
        { ts: at(400), kind: 'file', title: '立案', detail: '阿鲸：小虾打牌欠了 10 鱼币座位费一直没还。' },
        { ts: at(300), kind: 'evidence', title: '举证', detail: '提交牌桌入座记录与转账流水。' },
        { ts: at(120), kind: 'hearing', title: '开庭', detail: '小虾承认确实忘了还。' },
        { ts: at(60), kind: 'verdict', title: '判决', detail: '被告返还 10 鱼币并道歉，当庭执行完毕。' },
      ],
    },
    {
      id: 'case_3',
      title: '插队抢鱼获',
      kind: '秩序纠纷',
      plaintiff: party('f_xiaoyuanzi'),
      defendant: party('p_haixing'),
      state: 'evidence',
      filedAt: at(80),
      updatedAt: at(30),
      verdict: null,
      timeline: [
        { ts: at(80), kind: 'file', title: '立案', detail: '小圆子：鱼市排队时海星插队抢走了她看中的鱼获。' },
        { ts: at(30), kind: 'evidence', title: '举证', detail: '鱼市摊主愿意作证，正在收集证词。' },
      ],
    },
  ]
  return { cases, updatedAt: now }
}

export function mockRelations(): RelationsPayload {
  const now = Date.now()
  const h = (n: number) => now + n * 60 * MIN
  const friends: RelationFish[] = [
    { ...fishRef('f_ajing'), note: '总一起搬货，靠谱' },
    { ...fishRef('f_paopao'), note: '小卖部老板娘，奶茶管够' },
    { ...fishRef('p_xiaoxia'), note: '牌桌搭子' },
    { ...fishRef('p_beibei'), note: '爱抢地主' },
  ]
  return {
    friends,
    crush: { ...fishRef('f_ajing'), note: '最近总想找她一起钓鱼' },
    plans: [
      { id: 'pl_1', title: '晚上一起去码头钓鱼', with: fishRef('f_ajing'), when: h(6), place: '码头', status: 'planned' },
      { id: 'pl_2', title: '教我做海苔鱼干', with: fishRef('f_paopao'), when: h(26), place: '小卖部', status: 'planned' },
      { id: 'pl_3', title: '电玩城夹娃娃', with: fishRef('p_beibei'), when: h(-20), place: '电玩城', status: 'done' },
    ],
    updatedAt: now,
  }
}

export function mockPhone(): PhonePayload {
  const now = Date.now()
  const at = (m: number) => now - m * MIN
  const conversations: PhoneConversation[] = [
    {
      id: 'conv_ajing',
      with: fishRef('f_ajing'),
      unread: 1,
      lastTs: at(4),
      messages: [
        { id: 'm1', from: 'me', text: '今晚码头还去吗？', ts: at(40), read: true },
        { id: 'm2', from: 'them', text: '去呀，我带了新鱼竿~', ts: at(35), read: true },
        { id: 'm3', from: 'me', text: '那我先占个钓位', ts: at(20), read: true },
        { id: 'm4', from: 'them', text: '好，六点见，别迟到', ts: at(4), read: false },
      ],
    },
    {
      id: 'conv_paopao',
      with: fishRef('f_paopao'),
      unread: 0,
      lastTs: at(65),
      messages: [
        { id: 'm5', from: 'them', text: '新到的海苔鱼干给你留了两包', ts: at(90), read: true },
        { id: 'm6', from: 'me', text: '太够意思了，明天来拿', ts: at(65), read: true },
      ],
    },
    {
      id: 'conv_xiaoxia',
      with: fishRef('p_xiaoxia'),
      unread: 0,
      lastTs: at(180),
      messages: [{ id: 'm7', from: 'them', text: '三缺一，来不来斗地主？', ts: at(180), read: true }],
    },
  ]
  const dates: DateCard[] = [
    { id: 'd1', title: '码头夜钓', with: fishRef('f_ajing'), when: now + 6 * 60 * MIN, place: '码头', status: 'planned', note: '记得带鱼饵' },
    { id: 'd2', title: '电玩城夹娃娃', with: fishRef('p_beibei'), when: now + 26 * 60 * MIN, place: '电玩城', status: 'planned' },
  ]
  return { conversations, dates, updatedAt: now }
}

// ======================= P3.5：相册 / 画铺 / 夸夸墙（mock） =======================

/** 生成内联 SVG（data URI），让 mock 无后端时也能直接显示图片。 */
function svgDataUri(emoji: string, title: string, hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},72%,88%)"/><stop offset="1" stop-color="hsl(${(hue + 45) % 360},66%,68%)"/>` +
    `</linearGradient></defs><rect width="360" height="240" fill="url(#g)"/>` +
    `<circle cx="300" cy="52" r="34" fill="rgba(255,255,255,0.35)"/>` +
    `<text x="180" y="128" font-size="72" text-anchor="middle">${emoji}</text>` +
    `<text x="180" y="192" font-size="17" text-anchor="middle" fill="#1d4a5c" font-family="sans-serif">${title}</text>` +
    `</svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

interface AlbumSeed {
  id: string
  kind: 'photo' | 'painting' | 'song'
  title: string
  emoji: string
  hue: number
  fishId: string
  minutesAgo: number
}

const ALBUM_SEED: AlbumSeed[] = [
  { id: 'alb_1', kind: 'photo', title: '码头黄昏', emoji: '🌅', hue: 200, fishId: 'f_xiaoyuanzi', minutesAgo: 95 },
  { id: 'alb_2', kind: 'photo', title: '雪糕和晚霞', emoji: '🍦', hue: 25, fishId: 'f_ajing', minutesAgo: 180 },
  { id: 'alb_3', kind: 'painting', title: '海边的猫', emoji: '🐱', hue: 160, fishId: 'f_paopao', minutesAgo: 300 },
  { id: 'alb_4', kind: 'painting', title: '星空鱼缸', emoji: '🌌', hue: 250, fishId: 'f_xiaoyuanzi', minutesAgo: 520 },
  { id: 'alb_5', kind: 'photo', title: '小卖部门口的午后', emoji: '🏪', hue: 45, fishId: 'f_paopao', minutesAgo: 640 },
  { id: 'alb_6', kind: 'song', title: '小鱼的夏天', emoji: '🎵', hue: 300, fishId: 'f_ajing', minutesAgo: 60 },
  { id: 'alb_7', kind: 'song', title: '鱼缸里的月亮', emoji: '🎶', hue: 285, fishId: 'f_xiaoyuanzi', minutesAgo: 900 },
]

export function mockAlbum(fishId?: string): AlbumPayload {
  const now = Date.now()
  const items = ALBUM_SEED.filter((a) => !fishId || a.fishId === fishId).map((a) => ({
    id: a.id,
    kind: a.kind,
    title: a.title,
    path: a.kind === 'song' ? undefined : svgDataUri(a.emoji, a.title, a.hue),
    ts: now - a.minutesAgo * MIN,
    fishId: a.fishId,
    fishName: fishRef(a.fishId).name,
  }))
  return { items, updatedAt: now }
}

interface GallerySeed {
  id: string
  title: string
  price: number
  emoji: string
  hue: number
}

const GALLERY_SEED: GallerySeed[] = [
  { id: 'gal_1', title: '海边的猫', price: 120, emoji: '🐱', hue: 160 },
  { id: 'gal_2', title: '星空鱼缸', price: 200, emoji: '🌌', hue: 250 },
  { id: 'gal_3', title: '泡泡小卖部速写', price: 88, emoji: '🏪', hue: 45 },
  { id: 'gal_4', title: '鲤鱼跳龙门', price: 260, emoji: '🐟', hue: 210 },
]

export function mockGallery(): GalleryPayload {
  return {
    items: GALLERY_SEED.map((g) => ({ id: g.id, title: g.title, price: g.price, path: svgDataUri(g.emoji, g.title, g.hue) })),
    updatedAt: Date.now(),
  }
}

const BLESS_SEED: { id: string; from: string; text: string; minutesAgo: number }[] = [
  { id: 'bl_1', from: 'f_xiaoyuanzi', text: '阿鲸今天帮我搬了好多鱼获，超靠谱，夸夸！', minutesAgo: 12 },
  { id: 'bl_2', from: 'f_ajing', text: '团子的新画挂出来了，画得真好，祝她越画越棒～', minutesAgo: 48 },
  { id: 'bl_3', from: 'f_paopao', text: '今天小卖部生意兴隆，谢谢大家照顾，祝镇子越来越热闹！', minutesAgo: 130 },
  { id: 'bl_4', from: 'p_xiaoxia', text: '第一次在牌桌赢了一把，谢谢贝贝手下留情，开心！', minutesAgo: 240 },
  { id: 'bl_5', from: 'p_beibei', text: '夸夸海星，今天主动帮我占了钓位，人真好。', minutesAgo: 320 },
]

export function mockBless(limit = 50): BlessPayload {
  const now = Date.now()
  const items = BLESS_SEED.slice(0, Math.max(1, Math.min(limit, BLESS_SEED.length))).map((b) => ({
    id: b.id,
    ts: now - b.minutesAgo * MIN,
    from: fishRef(b.from).name,
    text: b.text,
  }))
  return { items, updatedAt: now }
}
