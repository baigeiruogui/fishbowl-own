// 牌桌 / 座位 / 对局 的存储封装（新目录，不改任何现有文件）。
// 元数据落 game_session / game_seat 表；运行中的纯逻辑对局对象（Session / 狼人杀 / 海龟汤）放在内存里，
// 以 tableId 关联。金额一律不在这里动（driver 负责 postLedger）。
import { newId, type DB } from '../db/index.ts'
import type { GameKind, Session } from '../../../games/src/index.ts'
import type { WerewolfState } from '../../../games/src/werewolf.ts'
import type { TurtleSoupState } from '../../../games/src/turtlesoup.ts'

export type TableStatus = 'waiting' | 'playing' | 'done'

/** 派对类游戏（P3 铺垫：狼人杀 / 海龟汤）。 */
export type PartyGame = 'werewolf' | 'turtlesoup'
export type TableGame = GameKind | PartyGame

/** 海龟汤的对局上下文：汤面状态 + 主持/猜题座位。 */
export interface TurtleSoupSession {
  soup: TurtleSoupState
  hostSeat: number
  guesserSeat: number
  /** 是否已结束（放弃/揭晓） */
  ended?: boolean
}

export type TableSession = Session | WerewolfState | TurtleSoupSession

export interface SeatPlayer {
  seat: number
  fishId: string
}

export interface GameTable {
  id: string
  venueId: string | null
  game: TableGame
  seatFee: number
  /** 需要坐满的人数（ddz=3，mj=4，werewolf=6，turtlesoup=2） */
  seats: number
  status: TableStatus
  players: SeatPlayer[]
  pot: number
  seed: number
  createdAt: number
  /** 运行中的对局状态（开局后才有） */
  session: TableSession | null
}

/** 各游戏座位数。 */
export function seatsForGame(game: TableGame): number {
  if (game === 'ddz') return 3
  if (game === 'mj') return 4
  if (game === 'werewolf') return 6
  if (game === 'turtlesoup') return 2
  throw new Error(`未知游戏：${String(game)}`)
}

function isKnownGame(game: string): game is TableGame {
  return game === 'ddz' || game === 'mj' || game === 'werewolf' || game === 'turtlesoup'
}

export interface SeatPreview {
  ok: boolean
  error?: string
  seat?: number
}

export class GameStore {
  readonly db: DB
  private readonly tables = new Map<string, GameTable>()

  constructor(db: DB) {
    this.db = db
  }

  /** 开一张空桌（不扣钱、不发牌；坐满由 driver 触发开局）。 */
  createTable(venueId: string | null, game: TableGame, seatFee = 0, seed = 1): GameTable {
    if (!isKnownGame(game)) throw new Error(`未知游戏：${String(game)}`)
    if (!Number.isInteger(seatFee) || seatFee < 0) throw new Error('seatFee 必须是非负整数')
    const seats = seatsForGame(game)
    const id = newId('tbl')
    const createdAt = Date.now()
    const t: GameTable = { id, venueId: venueId ?? null, game, seatFee, seats, status: 'waiting', players: [], pot: 0, seed, createdAt, session: null }
    this.db
      .prepare('INSERT INTO game_session(id, venue_id, game, state, pot, created_at, config_json) VALUES(?,?,?,?,?,?,?)')
      .run(id, t.venueId, game, 'waiting', 0, createdAt, JSON.stringify({ seatFee, seats, seed }))
    this.tables.set(id, t)
    return t
  }

  getTable(id: string): GameTable | null {
    return this.tables.get(id) ?? null
  }

  listTables(): GameTable[] {
    return [...this.tables.values()]
  }

  /** 预检查能不能入座（不改任何状态，供 driver 在扣座位费前调用）。 */
  previewSeat(tableId: string, fishId: string): SeatPreview {
    const t = this.tables.get(tableId)
    if (!t) return { ok: false, error: 'NOT_FOUND' }
    if (t.status === 'playing') return { ok: false, error: 'ALREADY_STARTED' }
    if (t.status === 'done') return { ok: false, error: 'TABLE_CLOSED' }
    if (t.players.some((p) => p.fishId === fishId)) return { ok: false, error: 'ALREADY_SEATED' }
    if (t.players.length >= t.seats) return { ok: false, error: 'FULL' }
    return { ok: true, seat: t.players.length }
  }

  /** 落座（预检查通过后由 driver 调用；同时写 game_seat 行）。 */
  commitSeat(tableId: string, fishId: string, seat: number): SeatPlayer {
    const t = this.tables.get(tableId)
    if (!t) throw new Error('table not found')
    const p: SeatPlayer = { seat, fishId }
    t.players.push(p)
    this.db
      .prepare('INSERT INTO game_seat(id, session_id, fish_id, seat, state) VALUES(?,?,?,?,?)')
      .run(newId('gs'), tableId, fishId, seat, 'seated')
    return p
  }

  /** 开局：挂上对局状态并把桌状态置 playing。底池按「座位费 × 已入座人数」计。 */
  start(tableId: string, session: TableSession): GameTable {
    const t = this.tables.get(tableId)
    if (!t) throw new Error('table not found')
    const pot = (session as { pot?: number }).pot ?? t.seatFee * t.players.length
    t.session = session
    t.status = 'playing'
    t.pot = pot
    this.db.prepare(`UPDATE game_session SET state = 'playing', pot = ? WHERE id = ?`).run(t.pot, tableId)
    return t
  }

  /** 对局推进：更新内存中的 session。 */
  setSession(tableId: string, session: TableSession): void {
    const t = this.tables.get(tableId)
    if (t) t.session = session
  }

  /** 终局：状态置 done。 */
  finish(tableId: string, session: TableSession): GameTable {
    const t = this.tables.get(tableId)
    if (!t) throw new Error('table not found')
    t.session = session
    t.status = 'done'
    this.db.prepare(`UPDATE game_session SET state = 'done', pot = ? WHERE id = ?`).run(t.pot, tableId)
    return t
  }

  /** 座位对应的 fishId。 */
  fishAt(tableId: string, seat: number): string | null {
    const t = this.tables.get(tableId)
    return t?.players.find((p) => p.seat === seat)?.fishId ?? null
  }
}
