// 公共面板 API 客户端：优先拉真实后端 /api/public/*，失败/未就绪时回退到本地 mock，
// 并在 UI 上标注数据来源（live / mock）。最终联调由 qa e2e 负责。
import type {
  AlbumPayload,
  BlessPayload,
  BoardPayload,
  CourtCase,
  CourtPayload,
  CreateFishInput,
  CreateFishResult,
  FishDetail,
  FishSummary,
  GalleryPayload,
  JoinInfo,
  LobbyPayload,
  OwnerAccount,
  OwnerFishListItem,
  OwnerListResult,
  OwnerRegisterInput,
  OwnerRegisterResult,
  PaperPayload,
  PhonePayload,
  RelationFish,
  RelationsPayload,
  ReportInput,
  ReportResult,
  RotateCodeResult,
  TableDetail,
  TownPayload,
} from './types.ts'
import {
  mockAlbum,
  mockBless,
  mockBoard,
  mockCourt,
  mockFishDetail,
  mockFishList,
  mockGallery,
  mockLobby,
  mockPaper,
  mockPhone,
  mockRelations,
  mockTable,
  mockTown,
} from './mock.ts'
import { startOfLocalDay } from './format.ts'

export type DataSource = 'live' | 'mock'

export interface LoadResult<T> {
  data: T
  source: DataSource
  /** live 失败时的原始错误信息，便于排查。 */
  error?: string
}

const TIMEOUT_MS = 4000

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const body = (await res.json()) as T & { ok?: boolean }
    if (body && body.ok === false) throw new Error('backend returned ok=false')
    return body
  } finally {
    clearTimeout(timer)
  }
}

function errMsg(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return '请求超时'
  return e instanceof Error ? e.message : String(e)
}

export async function loadTown(): Promise<LoadResult<TownPayload>> {
  try {
    const data = await getJson<TownPayload>('/api/public/town')
    if (!data || !data.town) throw new Error('响应缺少 town 字段')
    return { data, source: 'live' }
  } catch (e) {
    return { data: mockTown(), source: 'mock', error: errMsg(e) }
  }
}

export async function loadFishList(): Promise<LoadResult<FishSummary[]>> {
  try {
    // 兼容两种公开契约：{items:[...]}（web 契约）或 {fish:[...]}（t7 早版）。
    const data = await getJson<{ ok: boolean; items?: unknown[]; fish?: unknown[] }>('/api/public/fish')
    const raw = Array.isArray(data?.items) ? data.items : Array.isArray(data?.fish) ? data.fish : null
    if (!raw) throw new Error('响应缺少 items/fish 数组')
    return { data: raw.map(normalizeFishSummary), source: 'live' }
  } catch (e) {
    return { data: mockFishList(), source: 'mock', error: errMsg(e) }
  }
}

function normalizeFishSummary(v: unknown): FishSummary {
  const f = (v ?? {}) as Record<string, unknown>
  const status = (typeof f.status === 'string' ? f.status : 'active') as FishSummary['status']
  return {
    id: String(f.id ?? ''),
    name: String(f.name ?? ''),
    kind: f.kind === 'npc' ? 'npc' : 'resident',
    avatar: typeof f.avatar === 'string' && f.avatar ? f.avatar : '🐟',
    intro: typeof f.intro === 'string' ? f.intro : '',
    balance: Number(f.balance ?? 0),
    status,
    online: typeof f.online === 'boolean' ? f.online : status === 'active',
  }
}

export async function loadFishDetail(id: string): Promise<LoadResult<FishDetail | null>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`/api/public/fish/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    // 真·404 = 鱼不存在：不落 mock，页面显示「这条鱼不存在」空态。
    if (res.status === 404) return { data: null, source: 'live' }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const body = (await res.json()) as Record<string, unknown> & { ok?: boolean }
    if (!body || body.ok === false || !body.fish) throw new Error('响应缺少 fish 字段')

    const fish = normalizeFishProfile(body.fish, id)
    const ledger = Array.isArray(body.ledger) ? (body.ledger as unknown[]).map((l) => normalizeLedgerEntry(l, id)) : []
    const stats =
      body.stats && typeof body.stats === 'object'
        ? normalizeStats(body.stats as Record<string, unknown>, ledger)
        : computeStats(ledger)
    return { data: { fish, ledger, stats }, source: 'live' }
  } catch (e) {
    // 只有网络失败 / 超时 / 5xx / 响应畸形才回退 mock。
    return { data: mockFishDetail(id), source: 'mock', error: errMsg(e) }
  } finally {
    clearTimeout(timer)
  }
}

function normalizeFishProfile(v: unknown, fallbackId: string): FishDetail['fish'] {
  const f = (v ?? {}) as Record<string, unknown>
  const status = f.status === 'paused' || f.status === 'banned' ? f.status : 'active'
  return {
    id: String(f.id ?? fallbackId),
    name: String(f.name ?? ''),
    kind: f.kind === 'npc' ? 'npc' : 'resident',
    avatar: typeof f.avatar === 'string' && f.avatar ? f.avatar : '🐟',
    intro: typeof f.intro === 'string' ? f.intro : '',
    balance: Number(f.balance ?? 0),
    status,
    online: status === 'active',
    ownerName: typeof f.ownerName === 'string' ? f.ownerName : null,
    persona: typeof f.persona === 'string' ? f.persona : '',
    dayCap: f.dayCap == null ? null : Number(f.dayCap),
    createdAt: Number(f.createdAt ?? 0),
  }
}

function normalizeLedgerEntry(v: unknown, fishId: string): FishDetail['ledger'][number] {
  const l = (v ?? {}) as Record<string, unknown>
  return {
    id: Number(l.id ?? 0),
    fishId: String(l.fishId ?? fishId),
    delta: Number(l.delta ?? 0),
    balanceAfter: Number(l.balanceAfter ?? l.balance_after ?? 0),
    reason: String(l.reason ?? ''),
    ref: l.ref == null ? null : String(l.ref),
    ts: Number(l.ts ?? 0),
  }
}

function normalizeStats(s: Record<string, unknown>, ledger: FishDetail['ledger']): FishDetail['stats'] {
  const computed = computeStats(ledger)
  const num = (k: string, dflt: number) => {
    const v = Number(s[k])
    return Number.isFinite(v) ? v : dflt
  }
  return {
    todayEarned: num('todayEarned', computed.todayEarned),
    todaySpent: num('todaySpent', computed.todaySpent),
    totalEarned: num('totalEarned', computed.totalEarned),
    totalSpent: num('totalSpent', computed.totalSpent),
    entries: num('entries', computed.entries),
  }
}

function computeStats(ledger: FishDetail['ledger']): FishDetail['stats'] {
  const dayStart = startOfLocalDay()
  let totalEarned = 0
  let totalSpent = 0
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
  return { todayEarned, todaySpent, totalEarned, totalSpent, entries: ledger.length }
}

export interface TownPageData {
  town: TownPayload['town']
  recent: TownPayload['recent']
  fish: FishSummary[]
}

/** 小镇首页一次性拿齐：镇概况 + 最近动态 + 鱼名片。任一来源回退 mock 都标注为 mock。 */
export async function loadTownPage(): Promise<LoadResult<TownPageData>> {
  const [t, f] = await Promise.all([loadTown(), loadFishList()])
  const source: DataSource = t.source === 'live' && f.source === 'live' ? 'live' : 'mock'
  const error = [t.error, f.error].filter(Boolean).join('；') || undefined
  return { data: { town: t.data.town, recent: t.data.recent, fish: f.data }, source, error }
}

/** 解析默认鱼 id：优先 URL，其次鱼列表第一条。 */
export async function resolveDefaultFishId(): Promise<string | null> {
  const list = await loadFishList()
  return list.data[0]?.id ?? null
}

// ======================= P2：大厅 / 牌桌 / 积分榜 / 日报 =======================

export async function loadLobby(): Promise<LoadResult<LobbyPayload>> {
  try {
    const data = await getJson<{ ok: boolean } & LobbyPayload>('/api/public/lobby')
    if (!data || !Array.isArray(data.tables)) throw new Error('响应缺少 tables 数组')
    return { data: { tables: data.tables, games: data.games ?? [], places: data.places ?? [] }, source: 'live' }
  } catch (e) {
    return { data: mockLobby(), source: 'mock', error: errMsg(e) }
  }
}

export async function loadTable(id: string): Promise<LoadResult<TableDetail | null>> {
  try {
    const data = await getJson<{ ok: boolean; table: TableDetail }>(`/api/public/table/${encodeURIComponent(id)}`)
    if (!data || !data.table) throw new Error('响应缺少 table 字段')
    return { data: data.table, source: 'live' }
  } catch (e) {
    return { data: mockTable(id), source: 'mock', error: errMsg(e) }
  }
}

export async function loadBoard(): Promise<LoadResult<BoardPayload>> {
  try {
    const data = await getJson<{ ok: boolean } & BoardPayload>('/api/public/board')
    if (!data || !Array.isArray(data.entries)) throw new Error('响应缺少 entries 数组')
    return { data: { entries: data.entries, updatedAt: data.updatedAt ?? Date.now(), note: data.note }, source: 'live' }
  } catch (e) {
    return { data: mockBoard(), source: 'mock', error: errMsg(e) }
  }
}

export async function loadPaper(): Promise<LoadResult<PaperPayload>> {
  try {
    const data = await getJson<{ ok: boolean } & PaperPayload>('/api/public/paper')
    if (!data || !Array.isArray(data.items)) throw new Error('响应缺少 items 数组')
    // 服务端 /paper 会混入原始 event 条目（title===kind 且无 summary），对日报是噪音，过滤掉。
    const cleaned = data.items.filter((it) => {
      const title = String(it.title ?? '')
      const kind = String(it.kind ?? '')
      const summary = String(it.summary ?? '').trim()
      return !(title === kind && summary === '')
    })
    // 有生成好的日报行（kind==='paper'）时优先展示它，避免满屏原始事件噪音。
    const generated = cleaned.filter((it) => String(it.kind) === 'paper')
    const items = generated.length > 0 ? generated : cleaned
    return { data: { date: data.date, items, updatedAt: data.updatedAt ?? Date.now() }, source: 'live' }
  } catch (e) {
    return { data: mockPaper(), source: 'mock', error: errMsg(e) }
  }
}

// ======================= 主人入驻 / 管理（/api/owner/*） =======================

/** 带状态码/错误码的 API 异常，便于 UI 区分鉴权失败 / 网络不可用 / 业务错误。 */
export class ApiError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface PostOpts {
  token?: string
  /** 多主人自助令牌（Authorization: Bearer own_…）。 */
  ownerToken?: string
  timeoutMs?: number
}

async function postJson<T>(path: string, body: unknown, opts: PostOpts = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000)
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(opts.token ? { 'x-admin-token': opts.token } : {}),
        ...(opts.ownerToken ? { authorization: `Bearer ${opts.ownerToken}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('请求超时，后端没有响应', 0, 'TIMEOUT')
    }
    throw new ApiError('连不上后端服务器（检查服务端是否启动、/api 代理是否正确）', 0, 'NETWORK')
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let data: Record<string, unknown> = {}
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      data = {}
    }
  }

  if (!res.ok || data.ok === false) {
    const code = String(data.code ?? data.error ?? `HTTP_${res.status}`)
    const unauthorized = opts.ownerToken
      ? '主人令牌无效或已过期，请重新注册 / 登录。'
      : 'ADMIN_TOKEN 无效或缺失（服务端可能未设置 ADMIN_TOKEN）'
    const reason =
      typeof data.reason === 'string' && data.reason
        ? data.reason
        : res.status === 401
          ? unauthorized
          : res.status >= 500
            ? `后端不可用或出错（HTTP ${res.status}），请检查服务端是否启动、/api 代理是否正确`
            : `请求失败（HTTP ${res.status}）`
    throw new ApiError(res.status === 401 ? unauthorized : reason, res.status, code)
  }
  return data as T
}

/** 建鱼：成功返回一次性明文接入码 code（只显示这一次）。 */
export async function createFish(adminToken: string, input: CreateFishInput): Promise<CreateFishResult> {
  const body: Record<string, unknown> = { name: input.name.trim() }
  if (input.kind) body.kind = input.kind
  if (input.persona !== undefined) body.persona = input.persona
  if (input.intro !== undefined) body.intro = input.intro
  if (input.balance !== undefined) body.balance = input.balance
  const data = await postJson<{ ok: boolean; fish: CreateFishResult['fish']; code: string }>('/api/owner/fish', body, {
    token: adminToken,
  })
  if (!data?.fish || !data.code) throw new ApiError('后端返回缺少 fish 或 code 字段', 200, 'BAD_RESPONSE')
  return { fish: data.fish, code: data.code }
}

/** 换接入码：旧码立即失效，返回新明文码。 */
export async function rotateFishCode(adminToken: string, fishId: string): Promise<RotateCodeResult> {
  const data = await postJson<{ ok: boolean; fish_id?: string; code: string }>(
    `/api/owner/fish/${encodeURIComponent(fishId)}/code/rotate`,
    {},
    { token: adminToken },
  )
  if (!data?.code) throw new ApiError('后端返回缺少 code 字段', 200, 'BAD_RESPONSE')
  return { fishId: data.fish_id ?? fishId, code: data.code }
}

export async function setFishPaused(adminToken: string, fishId: string, paused: boolean): Promise<void> {
  await postJson(`/api/owner/fish/${encodeURIComponent(fishId)}/${paused ? 'pause' : 'resume'}`, {}, { token: adminToken })
}

// ======================= P3：法庭 / 关系 / 小手机（live 优先，未实现回落 mock） =======================

type AnyRecord = Record<string, unknown>

function nameOfRef(v: unknown, nameMap: Map<string, string>): { fishId?: string; name: string } {
  if (v == null) return { name: '—' }
  if (typeof v === 'string') return { fishId: v, name: nameMap.get(v) ?? v }
  const o = v as AnyRecord
  const id = typeof o.fishId === 'string' ? o.fishId : typeof o.id === 'string' ? o.id : undefined
  const name = typeof o.name === 'string' ? o.name : id ? nameMap.get(id) ?? id : '—'
  return id ? { fishId: id, name } : { name }
}

/** 把服务端 public-p3 的扁平案件（plaintiff/defendant 为 fish id、无 timeline）归一成 web 的 CourtCase。 */
function normalizeCourtCase(v: unknown, nameMap: Map<string, string>): CourtCase {
  const c = (v ?? {}) as AnyRecord
  const filedAt = Number(c.filedAt ?? c.createdAt ?? Date.now())
  const updatedAt = Number(c.updatedAt ?? filedAt)
  const state = String(c.state ?? 'filed')
  const kind = typeof c.kind === 'string' ? c.kind : undefined
  const title = String(c.title ?? c.desc ?? (kind ? `案件 · ${kind}` : '未命名案件'))
  const verdictRaw = c.verdict
  const verdict =
    verdictRaw === 'guilty' ? '有罪' : verdictRaw === 'not_guilty' ? '无罪' : typeof verdictRaw === 'string' ? verdictRaw : null
  const evidenceCount = Number(c.evidenceCount ?? 0)
  const voteCount = Number(c.voteCount ?? 0)

  let timeline = Array.isArray(c.timeline)
    ? (c.timeline as AnyRecord[]).map((ev) => ({
        ts: Number(ev.ts ?? filedAt),
        kind: String(ev.kind ?? 'file'),
        title: String(ev.title ?? '事件'),
        detail: typeof ev.detail === 'string' ? ev.detail : undefined,
      }))
    : []

  if (timeline.length === 0) {
    timeline.push({ ts: filedAt, kind: 'file', title: '立案', detail: typeof c.desc === 'string' && c.desc ? `案由：${c.desc}` : undefined })
    if (evidenceCount > 0 || state !== 'filed') {
      timeline.push({ ts: Math.max(filedAt + 1, updatedAt), kind: 'evidence', title: '举证', detail: `已提交 ${evidenceCount} 条证据` })
    }
    if (state === 'jury' || state === 'verdict') {
      timeline.push({ ts: Math.max(filedAt + 2, updatedAt), kind: 'hearing', title: '陪审投票', detail: `${voteCount} 条鱼参与投票` })
    }
    if (state === 'verdict') {
      timeline.push({ ts: Math.max(filedAt + 3, updatedAt), kind: 'verdict', title: '判决', detail: verdict ?? '已判决' })
    }
  }

  return {
    id: String(c.id ?? ''),
    title,
    kind,
    plaintiff: nameOfRef(c.plaintiff, nameMap),
    defendant: nameOfRef(c.defendant, nameMap),
    state,
    filedAt,
    updatedAt,
    verdict,
    timeline,
  }
}

export async function loadCourt(): Promise<LoadResult<CourtPayload>> {
  try {
    const [data, fish] = await Promise.all([
      getJson<{ ok: boolean; cases?: unknown[]; updatedAt?: number }>('/api/public/court'),
      loadFishList().catch(() => null),
    ])
    if (!data || !Array.isArray(data.cases)) throw new Error('响应缺少 cases 数组')
    const nameMap = new Map<string, string>((fish?.data ?? []).map((f) => [f.id, f.name]))
    const cases = data.cases.map((c) => normalizeCourtCase(c, nameMap))
    return { data: { cases, updatedAt: data.updatedAt ?? Date.now() }, source: 'live' }
  } catch (e) {
    return { data: mockCourt(), source: 'mock', error: errMsg(e) }
  }
}

export async function loadRelations(): Promise<LoadResult<RelationsPayload>> {
  try {
    const data = await getJson<{ ok: boolean; friends?: RelationFish[]; crush?: RelationFish | null; plans?: RelationsPayload['plans']; relations?: unknown[]; updatedAt?: number }>(
      '/api/public/relations',
    )
    if (!data) throw new Error('空响应')
    if (Array.isArray(data.friends)) {
      return {
        data: { friends: data.friends, crush: data.crush ?? null, plans: data.plans ?? [], updatedAt: data.updatedAt ?? Date.now() },
        source: 'live',
      }
    }
    // 服务端 public-p3 形态：relations: [{a:{id,name}, b:{id,name}, since}]（只有好友对，无 crush/plans）
    if (Array.isArray(data.relations)) {
      const map = new Map<string, RelationFish>()
      for (const r of data.relations as AnyRecord[]) {
        for (const side of ['a', 'b'] as const) {
          const p = (r[side] ?? {}) as AnyRecord
          const id = typeof p.id === 'string' ? p.id : typeof p.fishId === 'string' ? p.fishId : undefined
          if (!id || map.has(id)) continue
          map.set(id, { fishId: id, name: typeof p.name === 'string' ? p.name : id, note: '小镇好友' })
        }
      }
      return { data: { friends: [...map.values()], crush: null, plans: [], updatedAt: data.updatedAt ?? Date.now() }, source: 'live' }
    }
    throw new Error('响应缺少 friends/relations 数组')
  } catch (e) {
    return { data: mockRelations(), source: 'mock', error: errMsg(e) }
  }
}

export async function loadPhone(): Promise<LoadResult<PhonePayload>> {
  try {
    const data = await getJson<{
      ok: boolean
      conversations?: PhonePayload['conversations']
      dates?: PhonePayload['dates']
      messages?: unknown[]
      public?: boolean
      note?: string
      updatedAt?: number
    }>('/api/public/phone')
    if (!data) throw new Error('空响应')
    if (Array.isArray(data.conversations)) {
      return {
        data: { conversations: data.conversations, dates: data.dates ?? [], updatedAt: data.updatedAt ?? Date.now(), public: data.public, note: data.note },
        source: 'live',
      }
    }
    // 服务端 public-p3 形态：涉隐私时 {messages:[], public:false, note}（无 conversations）
    if (Array.isArray(data.messages) || data.public === false) {
      return {
        data: { conversations: [], dates: [], updatedAt: data.updatedAt ?? Date.now(), public: data.public, note: data.note },
        source: 'live',
      }
    }
    throw new Error('响应缺少 conversations/messages')
  } catch (e) {
    return { data: mockPhone(), source: 'mock', error: errMsg(e) }
  }
}

// ======================= P3.5：相册 / 画铺 / 夸夸墙 =======================
// 服务端实际形状（public-p35.ts）：/album 返回 {ok, fishId, album:[...]}（需 fishId）；
// /gallery 返回 {ok, gallery:[...]}（无 price、path 是服务器绝对路径）；/bless 返回 {ok, bless:[...]}（byName）。
// 这里统一归一成 web 类型，并兼容 stub 的 {items:[...]}。

type P35Record = Record<string, unknown>

function normalizeAlbumItem(v: unknown, nameMap: Map<string, string>): AlbumPayload['items'][number] {
  const c = (v ?? {}) as P35Record
  const data = (c.data && typeof c.data === 'object' ? (c.data as P35Record) : {}) as P35Record
  const id = String(c.id ?? '')
  const kind = String(c.kind ?? 'photo')
  const fishId = typeof c.fishId === 'string' ? c.fishId : undefined
  const rawPath = typeof c.path === 'string' ? c.path : undefined
  // 服务端返回服务器本地文件路径；图片统一走公开文件端点。stub/data URI 直接保留。
  const path =
    kind === 'song'
      ? undefined
      : id.startsWith('album_')
        ? `/api/public/album/${id}/file`
        : rawPath && (rawPath.startsWith('data:') || rawPath.startsWith('/api/public'))
          ? rawPath
          : undefined
  return {
    id,
    kind,
    title: String(c.title ?? ''),
    path,
    ts: Number(c.ts ?? Date.now()),
    fishId,
    fishName: typeof data.fishName === 'string' ? data.fishName : fishId ? nameMap.get(fishId) ?? fishId : undefined,
  }
}

export async function loadAlbum(fishId?: string): Promise<LoadResult<AlbumPayload>> {
  try {
    const fishList = await loadFishList().catch(() => null)
    const nameMap = new Map<string, string>((fishList?.data ?? []).map((f) => [f.id, f.name]))
    const targets = fishId ? [fishId] : (fishList?.data ?? []).slice(0, 24).map((f) => f.id)
    if (targets.length === 0) throw new Error('没有可查询的鱼')

    const batches = await Promise.all(
      targets.map((id) =>
        getJson<{ ok: boolean; album?: unknown[]; items?: unknown[] }>(`/api/public/album?fishId=${encodeURIComponent(id)}`)
          .then((d) => (Array.isArray(d.album) ? d.album : Array.isArray(d.items) ? d.items : []))
          .catch(() => null),
      ),
    )
    if (batches.every((b) => b === null)) throw new Error('相册请求全部失败')
    const seen = new Set<string>()
    const items: AlbumPayload['items'] = []
    for (const batch of batches) {
      for (const raw of batch ?? []) {
        const it = normalizeAlbumItem(raw, nameMap)
        if (!it.id || seen.has(it.id)) continue
        seen.add(it.id)
        items.push(it)
      }
    }
    items.sort((a, b) => b.ts - a.ts)
    return { data: { items, updatedAt: Date.now() }, source: 'live' }
  } catch (e) {
    return { data: mockAlbum(fishId), source: 'mock', error: errMsg(e) }
  }
}

export async function loadGallery(): Promise<LoadResult<GalleryPayload>> {
  try {
    const data = await getJson<{ ok: boolean; gallery?: unknown[]; items?: unknown[] }>('/api/public/gallery')
    const raw = Array.isArray(data?.gallery) ? data.gallery : Array.isArray(data?.items) ? data.items : null
    if (!raw) throw new Error('响应缺少 gallery/items 数组')
    const items = raw.map((v) => {
      const c = (v ?? {}) as P35Record
      const rawPath = typeof c.path === 'string' ? c.path : undefined
      const path = rawPath && (rawPath.startsWith('data:') || rawPath.startsWith('/api/public')) ? rawPath : undefined
      return {
        id: String(c.id ?? ''),
        title: String(c.title ?? ''),
        price: typeof c.price === 'number' ? c.price : undefined,
        path,
        scene: typeof c.scene === 'string' ? c.scene : undefined,
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : undefined,
      }
    })
    return { data: { items, updatedAt: Date.now() }, source: 'live' }
  } catch (e) {
    return { data: mockGallery(), source: 'mock', error: errMsg(e) }
  }
}

export async function loadBless(limit = 50): Promise<LoadResult<BlessPayload>> {
  try {
    const [data, fishList] = await Promise.all([
      getJson<{ ok: boolean; bless?: unknown[]; items?: unknown[] }>(`/api/public/bless?limit=${limit}`),
      loadFishList().catch(() => null),
    ])
    const raw = Array.isArray(data?.bless) ? data.bless : Array.isArray(data?.items) ? data.items : null
    if (!raw) throw new Error('响应缺少 bless/items 数组')
    const nameMap = new Map<string, string>((fishList?.data ?? []).map((f) => [f.id, f.name]))
    const items = raw.map((v) => {
      const c = (v ?? {}) as P35Record
      const by = typeof c.by === 'string' ? c.by : undefined
      return {
        id: String(c.id ?? c.blessId ?? ''),
        ts: Number(c.ts ?? Date.now()),
        from: String(c.from ?? c.byName ?? (by ? nameMap.get(by) ?? by : '—')),
        text: String(c.text ?? ''),
      }
    })
    return { data: { items, updatedAt: Date.now() }, source: 'live' }
  } catch (e) {
    return { data: mockBless(limit), source: 'mock', error: errMsg(e) }
  }
}

// ======================= 多主人自助入驻（ownerToken） =======================
// 服务端尚未实现 register/me 端点；未实现时进入本地演示模式（own_mock_ token + localStorage），
// 保证 mock 下「注册 → 建鱼 → 拿一次性码 → 换码/暂停」全流程可走通。

const OWNER_FISH_PREFIX = 'fishbowl.ownerFish.'
const OWNER_PROFILE_PREFIX = 'fishbowl.ownerProfile.'

function randToken(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function isMockToken(token: string): boolean {
  return token.startsWith('own_mock_')
}

function readMockFish(token: string): OwnerFishListItem[] {
  try {
    const raw = localStorage.getItem(OWNER_FISH_PREFIX + token)
    const list = raw ? (JSON.parse(raw) as OwnerFishListItem[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeMockFish(token: string, list: OwnerFishListItem[]): void {
  try {
    localStorage.setItem(OWNER_FISH_PREFIX + token, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

export function readOwnerProfile(token: string): OwnerAccount | null {
  try {
    const raw = localStorage.getItem(OWNER_PROFILE_PREFIX + token)
    return raw ? (JSON.parse(raw) as OwnerAccount) : null
  } catch {
    return null
  }
}

// ======================= 入驻计费（/api/public/join-info） =======================

/** 本地演示兜底：¥10 入驻费。 */
export function mockJoinInfo(): JoinInfo {
  return { priceYuan: 10, paymentNote: '入驻费 ¥10，付款后由镇长核销开通（本地演示）', mock: true }
}

/** 读取入驻计费配置；后端未就绪时返回 ¥10 演示配置。 */
export async function loadJoinInfo(): Promise<JoinInfo> {
  try {
    const data = await getJson<{ ok: boolean; priceYuan?: number; paymentNote?: string; qrUrl?: string }>(
      '/api/public/join-info',
    )
    const price = Number(data?.priceYuan ?? 0)
    return {
      priceYuan: Number.isFinite(price) ? Math.max(0, price) : 10,
      paymentNote: String(data?.paymentNote ?? ''),
      qrUrl: typeof data?.qrUrl === 'string' && data.qrUrl ? data.qrUrl : undefined,
      mock: false,
    }
  } catch {
    return mockJoinInfo()
  }
}

// ======================= 管理员（/api/admin，ADMIN_TOKEN） =======================

/** admin 视角的鱼（含 ownerId / payment）。 */
export interface AdminFishRow extends OwnerFishListItem {
  ownerId?: string | null
  avatar?: string
}

async function getJsonAdmin<T>(path: string, adminToken: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  let res: Response
  try {
    res = await fetch(path, {
      headers: { accept: 'application/json', 'x-admin-token': adminToken },
      signal: controller.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('请求超时', 0, 'TIMEOUT')
    throw new ApiError('网络不可用', 0, 'NETWORK')
  } finally {
    clearTimeout(timer)
  }
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; code?: string; reason?: string }
  if (!res.ok || data.ok === false) {
    const reason = res.status === 401 ? 'ADMIN_TOKEN 无效或缺失' : String(data.reason ?? `请求失败（HTTP ${res.status}）`)
    throw new ApiError(reason, res.status, String(data.code ?? `HTTP_${res.status}`))
  }
  return data as T
}

/** 聚合本地演示主人名下的所有鱼（用于 admin 在无后端时也能核销）。 */
function readAllMockFish(): AdminFishRow[] {
  const out: AdminFishRow[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(OWNER_FISH_PREFIX)) continue
      const token = key.slice(OWNER_FISH_PREFIX.length)
      for (const f of readMockFish(token)) {
        const owner = readOwnerProfile(token)
        out.push({ ...f, ownerId: owner?.id ?? token.slice(0, 10) })
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

/** 本地演示：把指定鱼改成 active（模拟核销）。 */
export function setMockFishStatus(fishId: string, status: string): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(OWNER_FISH_PREFIX)) continue
      const token = key.slice(OWNER_FISH_PREFIX.length)
      const list = readMockFish(token)
      const hit = list.find((f) => f.id === fishId)
      if (!hit) continue
      hit.status = status
      if (status === 'active') hit.payment = { priceYuan: hit.payment?.priceYuan ?? 10, paid: true }
      writeMockFish(token, list)
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/** 管理员列出全部鱼（GET /api/admin/fish）；后端未就绪时回落本地演示鱼。 */
export async function adminListFish(
  adminToken: string,
  opts: { allowMockFallback?: boolean } = {},
): Promise<{ fish: AdminFishRow[]; mock: boolean }> {
  try {
    const data = await getJsonAdmin<{ ok: boolean; fish?: AdminFishRow[]; items?: AdminFishRow[] }>(
      '/api/admin/fish',
      adminToken,
    )
    const list = Array.isArray(data.fish) ? data.fish : Array.isArray(data.items) ? data.items : []
    return { fish: list, mock: false }
  } catch (e) {
    if (opts.allowMockFallback === false) throw e
    if (e instanceof ApiError && (e.status === 0 || e.status === 404 || e.status >= 500)) {
      return { fish: readAllMockFish(), mock: true }
    }
    throw e
  }
}

/** 管理员核销「已付款」→ active（POST /api/admin/fish/:id/pay_confirm，404 时回落本地演示）。 */
export async function adminConfirmPayment(adminToken: string, fishId: string): Promise<{ mock: boolean }> {
  try {
    await postJson(`/api/admin/fish/${encodeURIComponent(fishId)}/pay_confirm`, {}, { token: adminToken })
    return { mock: false }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 0 || e.status === 404 || e.status >= 500)) {
      if (setMockFishStatus(fishId, 'active')) return { mock: true }
    }
    throw e
  }
}

async function getJsonAuth<T>(path: string, ownerToken: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  let res: Response
  try {
    res = await fetch(path, {
      headers: { accept: 'application/json', authorization: `Bearer ${ownerToken}` },
      signal: controller.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('请求超时', 0, 'TIMEOUT')
    throw new ApiError('连不上后端服务器', 0, 'NETWORK')
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let data: Record<string, unknown> = {}
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      data = {}
    }
  }
  if (!res.ok || data.ok === false) {
    const code = String(data.code ?? data.error ?? `HTTP_${res.status}`)
    const reason =
      res.status === 401
        ? '主人令牌无效或已过期，请重新注册 / 登录。'
        : typeof data.reason === 'string' && data.reason
          ? data.reason
          : `请求失败（HTTP ${res.status}）`
    throw new ApiError(reason, res.status, code)
  }
  return data as T
}

/** 注册主人：后端未实现 / 网络失败时自动进入本地演示模式（返回 mock:true）。 */
export async function registerOwner(input: OwnerRegisterInput): Promise<OwnerRegisterResult> {
  const name = input.name.trim()
  try {
    const data = await postJson<{
      ok: boolean
      ownerToken: string
      owner?: OwnerAccount
      ownerId?: string
      name?: string
    }>('/api/owner/register', { name, contact: input.contact?.trim() || undefined }, { timeoutMs: 4000 })
    if (!data?.ownerToken) throw new ApiError('注册响应缺少 ownerToken', 200, 'BAD_RESPONSE')
    const owner: OwnerAccount = data.owner ?? {
      id: String(data.ownerId ?? ''),
      name: String(data.name ?? name ?? '主人'),
      contact: input.contact,
    }
    return { ownerToken: data.ownerToken, owner, mock: false }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status === 404 || e.status >= 500 || e.code === 'BAD_RESPONSE')) {
      const ownerToken = randToken('own_mock_')
      const owner: OwnerAccount = { id: randToken('owner_'), name: name || '热心主人', contact: input.contact }
      try {
        localStorage.setItem(OWNER_PROFILE_PREFIX + ownerToken, JSON.stringify(owner))
        writeMockFish(ownerToken, [])
      } catch {
        /* ignore */
      }
      return { ownerToken, owner, mock: true }
    }
    throw e
  }
}

export async function listOwnerFish(ownerToken: string): Promise<OwnerListResult> {
  if (isMockToken(ownerToken)) {
    return { fish: readMockFish(ownerToken), limit: 3, owner: readOwnerProfile(ownerToken), mock: true }
  }
  try {
    const data = await getJsonAuth<{ ok: boolean; owner?: OwnerAccount; fish?: OwnerFishListItem[]; limit?: number }>(
      '/api/owner/me',
      ownerToken,
    )
    return { fish: Array.isArray(data.fish) ? data.fish : [], limit: data.limit ?? 3, owner: data.owner ?? null, mock: false }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 0 || e.status === 404 || e.status >= 500)) {
      return { fish: readMockFish(ownerToken), limit: 3, owner: readOwnerProfile(ownerToken), mock: true }
    }
    throw e
  }
}

export async function createOwnerFish(ownerToken: string, input: CreateFishInput): Promise<CreateFishResult> {
  if (isMockToken(ownerToken)) {
    const list = readMockFish(ownerToken)
    if (list.length >= 3) throw new ApiError('每个主人最多养 3 条鱼', 409, 'LIMIT')
    // 本地演示：模拟 ¥10 入驻费 → 新鱼为「待付款」，由管理员核销后转 active。
    const priceYuan = mockJoinInfo().priceYuan
    const fish: OwnerFishListItem = {
      id: randToken('f_own_'),
      name: input.name.trim(),
      kind: input.kind ?? 'resident',
      status: priceYuan > 0 ? 'pending_payment' : 'active',
      balance: input.balance ?? 100,
      persona: input.persona,
      intro: input.intro,
      payment: priceYuan > 0 ? { priceYuan, paid: false } : null,
      createdAt: Date.now(),
    }
    list.push(fish)
    writeMockFish(ownerToken, list)
    return {
      fish: {
        id: fish.id,
        name: fish.name,
        kind: fish.kind,
        persona: fish.persona ?? '',
        intro: fish.intro ?? '',
        lookNote: '',
        avatar: '🐠',
        status: fish.status,
        balance: fish.balance,
        dayCap: null,
        payment: fish.payment ?? null,
        createdAt: fish.createdAt,
      },
      code: randToken('fbr_mock_'),
    }
  }
  const body: Record<string, unknown> = { name: input.name.trim() }
  if (input.kind) body.kind = input.kind
  if (input.persona !== undefined) body.persona = input.persona
  if (input.intro !== undefined) body.intro = input.intro
  if (input.balance !== undefined) body.balance = input.balance
  const data = await postJson<{ ok: boolean; fish: CreateFishResult['fish']; code: string }>('/api/owner/fish', body, {
    ownerToken,
  })
  if (!data?.fish || !data.code) throw new ApiError('后端返回缺少 fish 或 code 字段', 200, 'BAD_RESPONSE')
  return { fish: data.fish, code: data.code }
}

export async function rotateOwnerCode(ownerToken: string, fishId: string): Promise<RotateCodeResult> {
  if (isMockToken(ownerToken)) return { fishId, code: randToken('fbr_mock_') }
  const data = await postJson<{ ok: boolean; fish_id?: string; code: string }>(
    `/api/owner/fish/${encodeURIComponent(fishId)}/code/rotate`,
    {},
    { ownerToken },
  )
  if (!data?.code) throw new ApiError('后端返回缺少 code 字段', 200, 'BAD_RESPONSE')
  return { fishId: data.fish_id ?? fishId, code: data.code }
}

export async function setOwnerFishPaused(ownerToken: string, fishId: string, paused: boolean): Promise<void> {
  if (isMockToken(ownerToken)) {
    const list = readMockFish(ownerToken)
    const f = list.find((x) => x.id === fishId)
    if (f) f.status = paused ? 'paused' : 'active'
    writeMockFish(ownerToken, list)
    return
  }
  await postJson(`/api/owner/fish/${encodeURIComponent(fishId)}/${paused ? 'pause' : 'resume'}`, {}, { ownerToken })
}

/** 举报：后端未实现时返回友好提示（不阻塞 UI）。 */
export async function submitReport(input: ReportInput): Promise<ReportResult> {
  try {
    await postJson('/api/public/report', input, { timeoutMs: 4000 })
    return { ok: true, message: '举报已提交，镇长会尽快处理。' }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status === 404 || e.status === 405 || e.status >= 500)) {
      return { ok: false, mock: true, message: '举报入口已记录（后端暂未开放，稍后会人工处理）。' }
    }
    throw e
  }
}
