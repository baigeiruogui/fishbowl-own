// 对局编排驱动（新目录，不改任何现有文件，不接 engine turn hub）。
// 负责：开桌 → 入座（收座位费 postLedger -seatFee）→ 坐满发牌开打 → 逐手 submitAction 推进
// → 终局按 settlement 发底池（postLedger +amount 'game_win'，不抽成、加总守恒）。
// 支持：斗地主 / 麻将（packages/games session） + 狼人杀 / 海龟汤（werewolf / turtlesoup 纯引擎）。
import { postLedger, type DB } from '../db/index.ts'
import { applyAction, createSession, turnSeat } from '../../../games/src/index.ts'
import type { Action, GameEvent, GameKind, Settlement } from '../../../games/src/index.ts'
import type { WerewolfState } from '../../../games/src/werewolf.ts'
import { advancePhase as wwAdvance, checkWin as wwCheckWin, createWerewolf, nightAction as wwNightAction, vote as wwVote } from '../../../games/src/werewolf.ts'
import type { WerewolfAction } from '../../../games/src/werewolf.ts'
import { askQuestion, createTurtleSoup, guess as soupGuess } from '../../../games/src/turtlesoup.ts'
import { GameStore, type GameTable, type TableGame, type TableSession, type TurtleSoupSession } from './store.ts'

export interface OpenTableOpts {
  venueId?: string | null
  game: TableGame
  seatFee?: number
  seed?: number
}

export interface SeatResult {
  ok: boolean
  error?: string
  reason?: string
  table?: GameTable
  seat?: number
}

/** 狼人杀玩家动作（通过 turns 下发/回收）。 */
export type WerewolfPlayerAction =
  | { type: 'wolf'; target: string }
  | { type: 'seer'; target: string }
  | { type: 'guard'; target: string }
  | { type: 'witch'; save?: string | null; poison?: string | null }
  | { type: 'vote'; target: string }

/** 海龟汤玩家动作。 */
export type SoupPlayerAction =
  | { type: 'ask'; question: string }
  | { type: 'guess'; answer: string }
  | { type: 'giveup' }

export type GameAction = Action | WerewolfPlayerAction | SoupPlayerAction

export interface SubmitResult {
  ok: boolean
  error?: string
  events?: unknown[]
  done?: boolean
  settlement?: Settlement
  table?: GameTable
}

export class GameDriver {
  readonly store: GameStore
  private readonly db: DB

  constructor(db: DB) {
    this.db = db
    this.store = new GameStore(db)
  }

  /** 开一张牌桌（等入座）。 */
  openTable(opts: OpenTableOpts): GameTable {
    return this.store.createTable(opts.venueId ?? null, opts.game, opts.seatFee ?? 0, opts.seed ?? 1)
  }

  getTable(tableId: string): GameTable | null {
    return this.store.getTable(tableId)
  }

  listTables(): GameTable[] {
    return this.store.listTables()
  }

  /**
   * 入座：先预检查，再收座位费（余额不足 → INSUFFICIENT，不透支、不落座），
   * 落座后若坐满则发牌开局（斗地主/麻将 createSession；狼人杀 createWerewolf；海龟汤 createTurtleSoup）。
   */
  seat(tableId: string, fishId: string): SeatResult {
    const table = this.store.getTable(tableId)
    if (!table) return { ok: false, error: 'NOT_FOUND' }
    const preview = this.store.previewSeat(tableId, fishId)
    if (!preview.ok) return { ok: false, error: preview.error }

    // 座位费先扣（唯一入口 postLedger）；余额不足会抛 INSUFFICIENT，此时没有任何副作用
    if (table.seatFee > 0) {
      try {
        postLedger(this.db, fishId, -table.seatFee, 'seat_fee', tableId)
      } catch (e) {
        const err = e as { code?: string; message?: string }
        return { ok: false, error: err?.code ?? 'INSUFFICIENT', reason: err?.message }
      }
    }
    const placed = this.store.commitSeat(tableId, fishId, preview.seat as number)

    // 坐满 → 发牌开局
    if (table.players.length === table.seats) {
      const players = table.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({ id: p.fishId }))
      this.store.start(tableId, this.createStartSession(table.game, table, players, table.seed, table.seatFee))
    }
    return { ok: true, table: this.store.getTable(tableId) as GameTable, seat: placed.seat }
  }

  private createStartSession(
    game: TableGame,
    table: GameTable,
    players: { id: string }[],
    seed: number,
    seatFee: number,
  ): TableSession {
    if (game === 'werewolf') {
      return createWerewolfSession(players, seed)
    }
    if (game === 'turtlesoup') {
      return { soup: createTurtleSoup({ seed }), hostSeat: 0, guesserSeat: 1 } as TurtleSoupSession
    }
    return createSession(game as GameKind, players, { seed, seatFee })
  }

  /** 当前该谁行动：斗地主/麻将返回单座 fishId；海龟汤返回猜题者；狼人杀多回合返回 null。 */
  nextTurn(tableOrId: GameTable | string): string | null {
    const t = typeof tableOrId === 'string' ? this.store.getTable(tableOrId) : tableOrId
    if (!t || !t.session || t.status !== 'playing') return null
    if (t.game === 'turtlesoup') {
      const sess = t.session as TurtleSoupSession
      if (sess.soup.solved || sess.ended) return null
      return t.players.find((p) => p.seat === sess.guesserSeat)?.fishId ?? null
    }
    if (t.game === 'werewolf') return null
    const seat = turnSeat(t.session as never)
    if (seat == null) return null
    return t.players.find((p) => p.seat === seat)?.fishId ?? null
  }

  /** 提交一个动作：按 game 分派到对应引擎；非法动作原样返回 error（不崩）。 */
  submitAction(tableId: string, fishId: string, action: GameAction): SubmitResult {
    const table = this.store.getTable(tableId)
    if (!table) return { ok: false, error: 'NOT_FOUND' }
    if (table.status !== 'playing' || !table.session) return { ok: false, error: 'NOT_PLAYING' }
    const player = table.players.find((p) => p.fishId === fishId)
    if (!player) return { ok: false, error: 'NOT_SEATED' }

    if (table.game === 'werewolf') return this.submitWerewolf(table, player, action as WerewolfPlayerAction)
    if (table.game === 'turtlesoup') return this.submitTurtleSoup(table, player, action as SoupPlayerAction)

    // 斗地主 / 麻将
    const result = applyAction(table.session as never, player.seat, action as Action)
    if (!result.ok) return { ok: false, error: result.error }
    if (result.done) {
      this.store.finish(tableId, result.session)
      this.settle(tableId, result.settlement)
      return { ok: true, events: result.events, done: true, settlement: result.settlement, table: this.store.getTable(tableId) as GameTable }
    }
    this.store.setSession(tableId, result.session)
    return { ok: true, events: result.events, table: this.store.getTable(tableId) as GameTable }
  }

  // ---------- 狼人杀 ----------

  private submitWerewolf(table: GameTable, player: { seat: number; fishId: string }, action: WerewolfPlayerAction): SubmitResult {
    const tableId = table.id
    const s0 = table.session as WerewolfState
    const p = s0.players.find((x) => x.id === player.fishId)
    if (!p || !p.alive) return { ok: false, error: 'NOT_ALIVE' }
    if (s0.phase === 'ended') return { ok: false, error: 'GAME_OVER' }

    // 白天（发言阶段）无玩家动作：自动推进到投票
    if (s0.phase === 'day') {
      const s1 = wwAdvance(s0)
      this.store.setSession(tableId, s1)
      return { ok: true, events: [], table: this.store.getTable(tableId) as GameTable }
    }

    if (s0.phase === 'night') {
      const need = werewolfNightNeed(s0, p.id)
      if (!need) return { ok: false, error: 'NOT_YOUR_TURN' }
      const mapped = mapWerewolfNightAction(need, action)
      if (!mapped.ok) return { ok: false, error: mapped.error }
      let ns: WerewolfState
      try {
        ns = wwNightAction(s0, mapped.action)
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
      if (ns.phase === 'day') ns = wwAdvance(ns) // day → vote
      if (ns.phase === 'ended') {
        const settlement = werewolfSettlement(table, ns)
        this.store.finish(tableId, ns)
        this.settle(tableId, settlement)
        return { ok: true, events: [{ type: 'game_over' }], done: true, settlement, table: this.store.getTable(tableId) as GameTable }
      }
      this.store.setSession(tableId, ns)
      return { ok: true, events: [{ type: 'night_action', role: need }], table: this.store.getTable(tableId) as GameTable }
    }

    // phase === 'vote'
    if (action.type !== 'vote') return { ok: false, error: 'NOT_YOUR_TURN' }
    if (s0.votes.some((v) => v.voter === p.id)) return { ok: false, error: 'ALREADY_VOTED' }
    if (!s0.players.some((x) => x.id === action.target && x.alive)) return { ok: false, error: 'BAD_TARGET' }
    let ns: WerewolfState
    try {
      ns = wwVote(s0, p.id, action.target)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    if (ns.phase === 'ended') {
      const settlement = werewolfSettlement(table, ns)
      this.store.finish(tableId, ns)
      this.settle(tableId, settlement)
      return { ok: true, events: [{ type: 'vote', target: action.target }, { type: 'game_over' }], done: true, settlement, table: this.store.getTable(tableId) as GameTable }
    }
    this.store.setSession(tableId, ns)
    return { ok: true, events: [{ type: 'vote', target: action.target }], table: this.store.getTable(tableId) as GameTable }
  }

  // ---------- 海龟汤 ----------

  private submitTurtleSoup(table: GameTable, player: { seat: number; fishId: string }, action: SoupPlayerAction): SubmitResult {
    const tableId = table.id
    const sess = table.session as TurtleSoupSession
    if (sess.soup.solved || sess.ended) return { ok: false, error: 'GAME_OVER' }
    const guesser = table.players.find((x) => x.seat === sess.guesserSeat)
    if (!guesser || guesser.fishId !== player.fishId) return { ok: false, error: 'NOT_YOUR_TURN' }

    if (action.type === 'ask') {
      const q = typeof action.question === 'string' ? action.question.trim() : ''
      if (!q) return { ok: false, error: 'question required' }
      const answer = askQuestion(sess.soup, q)
      this.store.setSession(tableId, { ...sess, soup: { ...sess.soup, asked: sess.soup.asked + 1 } })
      return { ok: true, events: [{ type: 'soup_answer', question: q, answer }], table: this.store.getTable(tableId) as GameTable }
    }
    if (action.type === 'guess') {
      const a = typeof action.answer === 'string' ? action.answer : ''
      const correct = soupGuess(sess.soup, a)
      if (correct) {
        const settlement = soupSettlement(table, sess.guesserSeat)
        this.store.finish(tableId, { ...sess, soup: { ...sess.soup, solved: true, asked: sess.soup.asked + 1 } })
        this.settle(tableId, settlement)
        return { ok: true, events: [{ type: 'soup_solved' }], done: true, settlement, table: this.store.getTable(tableId) as GameTable }
      }
      this.store.setSession(tableId, { ...sess, soup: { ...sess.soup, asked: sess.soup.asked + 1 } })
      return { ok: true, events: [{ type: 'soup_wrong' }], table: this.store.getTable(tableId) as GameTable }
    }
    if (action.type === 'giveup') {
      this.store.finish(tableId, { ...sess, ended: true })
      this.settle(tableId, undefined) // 无赢家 → 退座位费
      return { ok: true, events: [{ type: 'soup_giveup' }], done: true, table: this.store.getTable(tableId) as GameTable }
    }
    return { ok: false, error: 'bad soup action' }
  }

  /** 终局分钱：全部走 postLedger。 */
  private settle(tableId: string, settlement: Settlement | undefined): void {
    const t = this.store.getTable(tableId)
    if (!t) return
    if (settlement && settlement.shares.length > 0) {
      // 有赢家：底池按 shares 发给赢家（不抽成）
      for (const sh of settlement.shares) {
        if (sh.amount <= 0) continue
        const fished = this.store.fishAt(tableId, sh.seat)
        if (fished) postLedger(this.db, fished, sh.amount, 'game_win', tableId)
      }
      return
    }
    // 流局 / 无赢家：把座位费原路退回，保证加总守恒
    if (t.seatFee > 0) {
      for (const p of t.players) postLedger(this.db, p.fishId, t.seatFee, 'refund', tableId)
    }
  }
}

// ---------- 纯函数辅助 ----------

function createWerewolfSession(players: { id: string }[], seed: number): WerewolfState {
  return createWerewolf(players, { seed })
}

export function werewolfNightNeed(s: WerewolfState, fishId: string): 'wolf' | 'seer' | 'witch' | 'guard' | null {
  const p = s.players.find((x) => x.id === fishId)
  if (!p || !p.alive) return null
  const n = s.night
  if (p.role === 'werewolf') {
    const leader = s.players.find((x) => x.alive && x.role === 'werewolf')
    if (leader && leader.id === p.id && n.wolfTarget === null) return 'wolf'
    return null
  }
  if (p.role === 'seer' && n.seerChecked === null) return 'seer'
  if (p.role === 'witch' && !n.witchActed) return 'witch'
  if (p.role === 'guard' && n.guardProtect === null) return 'guard'
  return null
}

function mapWerewolfNightAction(
  need: 'wolf' | 'seer' | 'witch' | 'guard',
  action: WerewolfPlayerAction,
): { ok: true; action: WerewolfAction } | { ok: false; error: string } {
  if (need === 'wolf') {
    if (action.type !== 'wolf' || !action.target) return { ok: false, error: 'wolf 需要 target' }
    return { ok: true, action: { role: 'werewolf', target: action.target } }
  }
  if (need === 'seer') {
    if (action.type !== 'seer' || !action.target) return { ok: false, error: 'seer 需要 target' }
    return { ok: true, action: { role: 'seer', target: action.target } }
  }
  if (need === 'guard') {
    if (action.type !== 'guard' || !action.target) return { ok: false, error: 'guard 需要 target' }
    return { ok: true, action: { role: 'guard', target: action.target } }
  }
  // witch
  if (action.type !== 'witch') return { ok: false, error: 'witch 动作' }
  return {
    ok: true,
    action: { role: 'witch', save: action.save ?? null, poison: action.poison ?? null },
  }
}

function splitShares(seats: number[], pot: number, seatFee: number): Settlement {
  const winners = seats.slice()
  const shares: { seat: number; amount: number }[] = []
  if (winners.length > 0 && pot > 0) {
    const base = Math.floor(pot / winners.length)
    let rem = pot - base * winners.length
    for (const w of [...winners].sort((a, b) => a - b)) {
      const amount = base + (rem > 0 ? 1 : 0)
      if (rem > 0) rem--
      shares.push({ seat: w, amount })
    }
  }
  const net = winners.map((seat) => ({
    seat,
    delta: (shares.find((x) => x.seat === seat)?.amount ?? 0) - seatFee,
  }))
  return { winners, pot, shares, net }
}

function werewolfSettlement(table: GameTable, s: WerewolfState): Settlement | undefined {
  const winner = s.winner ?? wwCheckWin(s)
  if (!winner) return undefined
  const seats = s.players
    .filter((p) => p.alive && (winner === 'werewolf' ? p.role === 'werewolf' : p.role !== 'werewolf'))
    .map((p) => p.seat)
  return splitShares(seats, table.pot, table.seatFee)
}

function soupSettlement(table: GameTable, guesserSeat: number): Settlement {
  return splitShares([guesserSeat], table.pot, table.seatFee)
}

export function createDriver(db: DB): GameDriver {
  return new GameDriver(db)
}
