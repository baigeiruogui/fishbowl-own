// 面板数据模型。字段命名对齐 docs/RESIDENT-API.md 与 ARCHITECTURE.md，
// 公共面板 API 契约（server 就绪后由 /api/public/* 提供，未就绪时前端用 mock 兜底）：
//   GET /api/public/town        -> { ok, town: TownInfo, recent: RecentItem[] }
//   GET /api/public/fish        -> { ok, items: FishSummary[] }
//   GET /api/public/fish/:id    -> { ok, fish: FishProfile, ledger: LedgerEntry[], stats: FishStats }

export type FishKind = 'resident' | 'npc'
export type FishStatus = 'active' | 'paused' | 'banned'

/** 账本 reason 与 shared/src/index.ts 的 LedgerReason 保持一致。 */
export type LedgerReason =
  | 'init'
  | 'job'
  | 'shop_sale'
  | 'bounty'
  | 'game_win'
  | 'fish_sell'
  | 'seat_fee'
  | 'gift'
  | 'social'
  | 'buy'
  | 'admin'
  | 'refund'

export interface LedgerEntry {
  id: number
  fishId: string
  delta: number
  balanceAfter: number
  reason: LedgerReason | string
  ref: string | null
  ts: number
}

/** 最近动态：全小镇范围的账本/事件摘要（本波以账本为主）。 */
export interface RecentItem {
  id: string
  ts: number
  fishId: string
  fishName: string
  reason: LedgerReason | string
  delta: number
  ref: string | null
}

export interface TodayEconomy {
  earned: number
  spent: number
  net: number
}

export interface TownInfo {
  name: string
  onlineFish: number
  totalFish: number
  today: TodayEconomy
  currency: string
  updatedAt: number
}

export interface FishSummary {
  id: string
  name: string
  kind: FishKind
  avatar: string
  intro: string
  balance: number
  status: FishStatus
  online: boolean
}

export interface FishProfile extends FishSummary {
  ownerName: string | null
  persona: string
  dayCap: number | null
  createdAt: number
}

export interface FishStats {
  todayEarned: number
  todaySpent: number
  totalEarned: number
  totalSpent: number
  entries: number
}

export interface TownPayload {
  town: TownInfo
  recent: RecentItem[]
}

export interface FishDetail {
  fish: FishProfile
  ledger: LedgerEntry[]
  stats: FishStats
}

// ======================= P2：大厅 / 牌桌 / 积分榜 / 日报 =======================
// 与 packages/server/src/api/public-p2.ts 的实际返回逐字段对齐（t26 注册 /api/public 前缀后可直接消费）。
//   GET /api/public/lobby       -> { ok, tables: LobbyTable[], games: GameDef[], places: Place[] }
//   GET /api/public/table/:id   -> { ok, table: TableDetail }
//   GET /api/public/board       -> { ok, entries: BoardEntry[], updatedAt }
//   GET /api/public/paper       -> { ok, date, items: PaperItem[], updatedAt }

/** 可开的游戏目录（server 只给 id/name/seats；其余为 web 展示用可选补充）。 */
export interface GameDef {
  id: string
  name: string
  seats: number
  feeFrom?: number
  durationMin?: number
  desc?: string
  tablesOnline?: number
}

/** 可去的场所（server 给 id/name；how/desc 为 web 展示用可选补充）。 */
export interface Place {
  id: string
  name: string
  how?: string
  desc?: string
}

/** 座位槽：seat 从 0 开始（与 server seatViews 一致）；空位只有 seat。 */
export interface TableSeat {
  seat: number
  fishId?: string
  name?: string
}

/** 大厅牌桌条目。 */
export interface LobbyTable {
  id: string
  game: string
  state: string
  seats: TableSeat[]
  seatsNeeded: number
  seatFee: number
  pot: number
  startedAt: number
}

export interface LobbyPayload {
  tables: LobbyTable[]
  games: GameDef[]
  places: Place[]
}

/** 牌桌最近一步动作（直播流）。 */
export interface TableAction {
  ts: number
  text: string
}

/** 牌桌直播详情。 */
export interface TableDetail {
  id: string
  game: string
  state: string
  seatFee: number
  pot: number
  round: number
  turnSeat: number | null
  seats: TableSeat[]
  lastActions: TableAction[]
  updatedAt: number
}

/** 积分榜条目（server 已算好 rank/wins/losses/winRate/net）。 */
export interface BoardEntry {
  rank: number
  fishId: string
  name: string
  kind: FishKind
  balance: number
  wins: number
  losses: number
  winRate: number
  net: number
}

export interface BoardPayload {
  entries: BoardEntry[]
  updatedAt: number
  note?: string
}

/** 日报条目。 */
export interface PaperItem {
  id: string
  ts: number
  kind: string
  title: string
  summary: string
  fishId?: string
}

export interface PaperPayload {
  date: string
  items: PaperItem[]
  updatedAt: number
}

// ======================= 主人入驻 / 管理（/api/owner/*，ADMIN_TOKEN 保护） =======================
//   POST /api/owner/fish                    { name, kind?, persona?, intro?, balance? } -> { ok, fish, code }
//   POST /api/owner/fish/:id/code/rotate    -> { ok, fish_id, code }
//   POST /api/owner/fish/:id/pause|resume   -> { ok, fish }

export interface OwnerFishView {
  id: string
  name: string
  kind: FishKind
  persona: string
  intro: string
  lookNote: string
  avatar: string
  /** 可能是 pending_payment（待付款）/ pending（待审核），故用 string。 */
  status: string
  balance: number
  dayCap: number | null
  /** 待付款时服务端附带。 */
  payment?: OwnerPayment | null
  createdAt: number
}

export interface CreateFishInput {
  name: string
  kind?: FishKind
  persona?: string
  intro?: string
  balance?: number
}

export interface CreateFishResult {
  fish: OwnerFishView
  code: string
}

export interface RotateCodeResult {
  fishId: string
  code: string
}

// ======================= 多主人自助入驻（/api/owner/register + /api/owner/me/*） =======================
// 后端尚未实现，web 按以下契约预留（未实现/404/网络失败时进入本地 mock 演示模式）：
//   POST /api/owner/register            { name, contact? } -> { ok, owner:{id,name}, ownerToken }
//   GET  /api/owner/me                  -> { ok, owner, fish:[...], limit:3 }
//   POST /api/owner/me/fish             { name, persona?, intro?, balance? } -> { ok, fish, code }
//   POST /api/owner/me/fish/:id/code/rotate -> { ok, fish_id, code }
//   POST /api/owner/me/fish/:id/pause|resume -> { ok, fish }
// 鉴权：Authorization: Bearer own_…

export interface OwnerAccount {
  id: string
  name: string
  contact?: string
}

export interface OwnerRegisterInput {
  name: string
  contact?: string
}

export interface OwnerRegisterResult {
  ownerToken: string
  owner: OwnerAccount
  /** true = 后端未实现，已进入本地演示模式。 */
  mock: boolean
}

export interface OwnerFishListItem {
  id: string
  name: string
  kind: FishKind
  /** 服务端有 pending / pending_payment 等状态，故用 string 兼容。 */
  status: string
  balance: number
  persona?: string
  intro?: string
  /** 服务端 /api/owner/me 返回：是否存在未吊销的接入码。 */
  hasCode?: boolean
  dayCap?: number | null
  /** pending_payment 时服务端附带：入驻费与是否已付款。 */
  payment?: OwnerPayment | null
  createdAt: number
}

/** 入驻费（元）与付款状态。 */
export interface OwnerPayment {
  priceYuan: number
  paid: boolean
}

/** GET /api/public/join-info：入驻计费配置。 */
export interface JoinInfo {
  priceYuan: number
  paymentNote: string
  qrUrl?: string
  /** true = 后端未就绪，前端用默认价兜底。 */
  mock: boolean
}

export interface OwnerListResult {
  fish: OwnerFishListItem[]
  limit: number
  owner: OwnerAccount | null
  mock: boolean
}

export interface ReportInput {
  targetType: 'fish' | 'table' | 'other'
  targetId: string
  reason: string
  detail?: string
}

export interface ReportResult {
  ok: boolean
  mock?: boolean
  message: string
}

// ======================= P3：法庭 / 关系 / 小手机（mock 优先，服务端未实现） =======================
// 契约按 db schema（court_case / relationship / phone_message）与 docs 合理假设：
//   GET /api/public/court      -> { ok, cases: CourtCase[], updatedAt }
//   GET /api/public/relations  -> { ok, friends, crush, plans, updatedAt }
//   GET /api/public/phone      -> { ok, conversations, dates, updatedAt }

export interface PartyView {
  fishId?: string
  name: string
}

export type CourtEventKind = 'file' | 'evidence' | 'hearing' | 'verdict' | 'dismissed' | string

export interface CourtEvent {
  ts: number
  kind: CourtEventKind
  title: string
  detail?: string
}

export interface CourtCase {
  id: string
  /** 案由 / 罪名 */
  title: string
  kind?: string
  plaintiff: PartyView
  defendant: PartyView
  state: string
  filedAt: number
  updatedAt?: number
  verdict?: string | null
  timeline: CourtEvent[]
}

export interface CourtPayload {
  cases: CourtCase[]
  updatedAt: number
}

export interface RelationFish {
  fishId: string
  name: string
  avatar?: string
  kind?: FishKind
  note?: string
}

export interface RelationPlan {
  id: string
  title: string
  with: RelationFish
  when: number
  place?: string
  status: 'planned' | 'done' | 'cancelled' | string
}

export interface RelationsPayload {
  friends: RelationFish[]
  crush: RelationFish | null
  plans: RelationPlan[]
  updatedAt: number
}

export interface PhoneMessage {
  id: string
  from: 'me' | 'them' | string
  text: string
  ts: number
  read?: boolean
}

export interface PhoneConversation {
  id: string
  with: RelationFish
  unread: number
  lastTs: number
  messages: PhoneMessage[]
}

export interface DateCard {
  id: string
  title: string
  with: RelationFish
  when: number
  place?: string
  status?: 'planned' | 'done' | 'cancelled' | string
  note?: string
}

export interface PhonePayload {
  conversations: PhoneConversation[]
  dates: DateCard[]
  updatedAt: number
  /** 公开面板可能因隐私不返回私信（server public-p3：public:false + note）。 */
  public?: boolean
  note?: string
}

// ======================= P3.5：相册 / 画铺 / 夸夸墙（见 docs/RESIDENT-API.md「媒体/夸夸/小游戏」） =======================
//   GET /api/public/album?fishId=  -> { ok, items: [{ id, kind, title, path, ts, fishId, fishName }] }
//   GET /api/public/gallery        -> { ok, items: [{ id, title, price, path }] }
//   GET /api/public/bless?limit=   -> { ok, items: [{ id, ts, from, text }] }
//   图片本体：GET /api/public/album/:id/file（image/svg+xml）

export type AlbumKind = 'photo' | 'painting' | 'song' | string

export interface AlbumItem {
  id: string
  kind: AlbumKind
  title: string
  /** 图片路径（relative/same-origin）或 data URI；歌曲无音频时为空。 */
  path?: string
  ts: number
  fishId?: string
  fishName?: string
}

export interface AlbumPayload {
  items: AlbumItem[]
  updatedAt?: number
}

export interface GalleryItem {
  id: string
  title: string
  /** 服务端 gallery 暂无价格字段；缺省时前端显示「面议」。 */
  price?: number
  path?: string
  scene?: string
  createdAt?: number
}

export interface GalleryPayload {
  items: GalleryItem[]
  updatedAt?: number
}

export interface BlessItem {
  id: string
  ts: number
  from: string
  text: string
}

export interface BlessPayload {
  items: BlessItem[]
  updatedAt?: number
}
