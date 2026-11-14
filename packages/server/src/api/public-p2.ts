// P2 公开只读 API（免鉴权，供 web 面板）：大厅 / 单桌 / 排行榜 / 日报。
// 纯新增，不改 index.ts；由 server-dev 统一以 prefix '/api/public' 注册本插件，
// 故这里定义的是相对路由：/lobby、/table/:id、/board、/paper。
// 牌桌数据优先从注入的 store / driver 读取（内存权威），缺省时回落到 game_session / game_seat 表。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { turnSeat } from '../../../games/src/index.ts'
import { startOfLocalDay } from '../domain/account.ts'
import { DomainError } from '../domain/errors.ts'
import { sendError } from './common.ts'
import { avatarUrl } from './avatar.ts'

/** 牌桌的最小结构（GameTable / 测试桩都满足）。 */
export interface TableLike {
  id: string
  game: string
  status: string
  seats: number
  seatFee: number
  pot: number
  createdAt: number
  players: { seat: number; fishId: string }[]
  session?: unknown
  lastActions?: { ts: number; text: string }[]
  updatedAt?: number
}

export interface TablesSource {
  listTables(): TableLike[]
  getTable(id: string): TableLike | null
}

export interface PublicP2Deps {
  db: DB
  /** 对局驱动（GameDriver）；与 store 二选一或都给均可。 */
  driver?: TablesSource
  /** 牌桌存储（GameStore）。 */
  store?: TablesSource
  /** 时钟（测试注入用）。 */
  now?: () => number
}

const GAMES = [
  { id: 'ddz', name: '斗地主', seats: 3 },
  { id: 'mj', name: '麻将', seats: 4 },
  { id: 'werewolf', name: '狼人杀', seats: 6 },
  { id: 'turtlesoup', name: '海龟汤', seats: 2 },
]

/** 默认地点（venue 表为空时的兜底，方便前端直接展示）。 */
const DEFAULT_PLACES = [
  { id: 'pier', name: '码头' },
  { id: 'shop', name: '杂货铺' },
  { id: 'cafe', name: '咖啡店' },
]

interface SessionRow {
  id: string
  venue_id: string | null
  game: string
  state: string
  pot: number
  created_at: number
  config_json: string
}

function sessionRowToTable(db: DB, r: SessionRow): TableLike {
  let cfg: { seats?: number; seatFee?: number; seed?: number } = {}
  try {
    cfg = JSON.parse(r.config_json || '{}') as typeof cfg
  } catch {
    /* ignore */
  }
  const seats = Number.isInteger(cfg.seats) ? (cfg.seats as number) : r.game === 'mj' ? 4 : 3
  const seatFee = Number.isInteger(cfg.seatFee) ? (cfg.seatFee as number) : 0
  const seatRows = db
    .prepare('SELECT seat, fish_id FROM game_seat WHERE session_id = ? ORDER BY seat ASC')
    .all(r.id) as unknown as { seat: number; fish_id: string }[]
  return {
    id: r.id,
    game: r.game,
    status: r.state,
    seats,
    seatFee,
    pot: Number(r.pot),
    createdAt: Number(r.created_at),
    players: seatRows.map((s) => ({ seat: Number(s.seat), fishId: s.fish_id })),
    session: null,
  }
}

function tablesFromDb(db: DB): TableLike[] {
  const rows = db.prepare('SELECT * FROM game_session ORDER BY created_at ASC').all() as unknown as SessionRow[]
  return rows.map((r) => sessionRowToTable(db, r))
}

function tableFromDb(db: DB, id: string): TableLike | null {
  const r = db.prepare('SELECT * FROM game_session WHERE id = ?').get(id) as unknown as SessionRow | undefined
  return r ? sessionRowToTable(db, r) : null
}

function resolveTables(deps: PublicP2Deps): TableLike[] {
  if (deps.store) return deps.store.listTables()
  if (deps.driver) return deps.driver.listTables()
  return tablesFromDb(deps.db)
}

function resolveTable(deps: PublicP2Deps, id: string): TableLike | null {
  const fromSource = deps.store?.getTable(id) ?? deps.driver?.getTable(id) ?? null
  if (fromSource) return fromSource
  return tableFromDb(deps.db, id)
}

/** 座位视图：输出全部座位槽（空位仅含 seat，占用则带 fishId/name）。 */
function seatViews(db: DB, t: TableLike): { seat: number; fishId?: string; name?: string; avatar?: string }[] {
  const occupied = new Map(t.players.map((p) => [p.seat, p.fishId]))
  const out: { seat: number; fishId?: string; name?: string; avatar?: string }[] = []
  for (let i = 0; i < t.seats; i++) {
    const fishId = occupied.get(i)
    if (fishId) {
      const f = db.prepare('SELECT name FROM fish WHERE id = ?').get(fishId) as { name: string } | undefined
      out.push({ seat: i, fishId, name: f?.name, avatar: avatarUrl(fishId) })
    } else {
      out.push({ seat: i })
    }
  }
  return out
}

function roundOf(t: TableLike): number {
  const s = t.session as { game?: string; passes?: number; discards?: unknown[]; day?: number; asked?: number } | null | undefined
  if (!s) return 0
  if (s.game === 'mj') return Array.isArray(s.discards) ? s.discards.length : 0
  if (s.game === 'ddz') return typeof s.passes === 'number' ? s.passes : 0
  if (typeof s.day === 'number') return s.day // 狼人杀：第几天
  if (typeof s.asked === 'number') return s.asked // 海龟汤：已问数
  return 0
}

function turnSeatOf(t: TableLike): number | null {
  const s = t.session
  if (!s) return null
  try {
    const seat = turnSeat(s as never)
    return typeof seat === 'number' ? seat : null
  } catch {
    return null
  }
}

function lastActionsOf(t: TableLike, now: number): { ts: number; text: string }[] {
  if (Array.isArray(t.lastActions) && t.lastActions.length > 0) return t.lastActions.slice(-20)
  const s = t.session as { game?: string; last?: { seat?: number; play?: { type?: string } } } | null | undefined
  if (s && s.game === 'ddz' && s.last && typeof s.last.seat === 'number') {
    return [{ ts: now, text: `座位 ${s.last.seat} 出牌` }]
  }
  return []
}

function ymd(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

interface FishStatRow {
  id: string
  name: string
  kind: string
  balance: number
  wins: number
  plays: number
  net: number
}

export const publicP2Routes: FastifyPluginAsync<PublicP2Deps> = async (app: FastifyInstance, opts) => {
  const { db } = opts
  const clock = opts.now ?? (() => Date.now())

  const pub = (fn: (req: FastifyRequest, reply: FastifyReply) => unknown) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply)
      } catch (e) {
        return sendError(reply, e)
      }
    }
  }

  // 大厅：所有牌桌 + 可玩游戏 + 地点
  app.get(
    '/lobby',
    pub(() => {
      const tables = resolveTables(opts).map((t) => ({
        id: t.id,
        game: t.game,
        state: t.status,
        seats: seatViews(db, t),
        seatsNeeded: Math.max(0, t.seats - t.players.length),
        seatFee: t.seatFee,
        pot: t.pot,
        startedAt: t.createdAt,
      }))
      const venueRows = db.prepare('SELECT id, name FROM venue ORDER BY name ASC').all() as unknown as {
        id: string
        name: string
      }[]
      const places = venueRows.length > 0 ? venueRows.map((v) => ({ id: v.id, name: v.name })) : DEFAULT_PLACES
      return { ok: true, tables, games: GAMES, places }
    }),
  )

  // 单桌详情（无则 404）
  app.get(
    '/table/:id',
    pub((req) => {
      const { id } = req.params as { id: string }
      const t = resolveTable(opts, id)
      if (!t) throw new DomainError('NOT_FOUND', `table not found: ${id}`)
      const now = clock()
      return {
        ok: true,
        table: {
          id: t.id,
          game: t.game,
          state: t.status,
          seatFee: t.seatFee,
          pot: t.pot,
          round: roundOf(t),
          turnSeat: turnSeatOf(t),
          seats: seatViews(db, t),
          lastActions: lastActionsOf(t, now),
          updatedAt: t.updatedAt ?? now,
        },
      }
    }),
  )

  // 排行榜：按净收益排序（游戏相关账本：game_win / seat_fee / refund）
  app.get(
    '/board',
    pub(() => {
      const rows = db
        .prepare(
          `SELECT f.id AS id, f.name AS name, f.kind AS kind, f.balance AS balance,
                  COALESCE(SUM(CASE WHEN l.reason = 'game_win' AND l.delta > 0 THEN 1 ELSE 0 END), 0) AS wins,
                  COALESCE(SUM(CASE WHEN l.reason = 'seat_fee' THEN 1 ELSE 0 END), 0) AS plays,
                  COALESCE(SUM(CASE WHEN l.reason IN ('game_win','seat_fee','refund') THEN l.delta ELSE 0 END), 0) AS net
           FROM fish f LEFT JOIN ledger l ON l.fish_id = f.id
           GROUP BY f.id ORDER BY net DESC, balance DESC, f.created_at ASC`,
        )
        .all() as unknown as FishStatRow[]
      const entries = rows.map((r, i) => {
        const wins = Number(r.wins)
        const plays = Number(r.plays)
        const losses = Math.max(0, plays - wins)
        const winRate = plays > 0 ? Number((wins / plays).toFixed(4)) : 0
        return {
          rank: i + 1,
          fishId: r.id,
          name: r.name,
          kind: r.kind,
          avatar: avatarUrl(r.id),
          balance: Number(r.balance),
          wins,
          losses,
          winRate,
          net: Number(r.net),
        }
      })
      return { ok: true, entries, updatedAt: clock() }
    }),
  )

  // 日报：聚合今天的事件与已生成日报（没有就空数组）
  app.get(
    '/paper',
    pub(() => {
      const now = clock()
      const dayStart = startOfLocalDay(now)
      const dayStartSec = Math.floor(dayStart / 1000)

      const paperRows = db
        .prepare('SELECT id, ts, headline, body FROM paper WHERE ts >= ? ORDER BY ts DESC')
        .all(dayStart) as unknown as { id: number; ts: number; headline: string | null; body: string | null }[]
      const items: { id: string; ts: number; kind: string; title: string; summary: string; fishId?: string }[] = paperRows.map((r) => ({
        id: 'paper_' + r.id,
        ts: Number(r.ts),
        kind: 'paper',
        title: r.headline ?? '日报',
        summary: r.body ?? '',
      }))

      const eventRows = db
        .prepare('SELECT id, fish_id, kind, data_json, ts FROM event WHERE ts >= ? ORDER BY id DESC LIMIT 50')
        .all(dayStartSec) as unknown as { id: number; fish_id: string; kind: string; data_json: string; ts: number }[]
      for (const e of eventRows) {
        let data: Record<string, unknown> = {}
        try {
          data = JSON.parse(e.data_json || '{}') as Record<string, unknown>
        } catch {
          /* ignore */
        }
        const text = typeof data.text === 'string' ? data.text : typeof data.summary === 'string' ? data.summary : ''
        items.push({
          id: 'evt_' + e.id,
          ts: Number(e.ts) * 1000,
          kind: e.kind,
          title: typeof data.title === 'string' ? data.title : e.kind,
          summary: text,
          fishId: e.fish_id,
        })
      }
      items.sort((a, b) => b.ts - a.ts)
      return { ok: true, date: ymd(now), items, updatedAt: now }
    }),
  )
}

export default publicP2Routes
