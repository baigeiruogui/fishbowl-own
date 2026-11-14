/**
 * 对局状态机（纯逻辑，无 IO / 无框架 / 无外部依赖）。
 *
 * 统一封装斗地主（ddz）与麻将（mj）的一局：建局发牌、执行动作、轮转、结算。
 * 复用 ddz.ts（洗牌/发牌/牌型判定）与 mj.ts（牌墙/胡牌判定）。
 * 本模块完全不碰钱：settlement 只给出「赢家 + 底池分配 + 每人净变化」，
 * 实际余额变动由调用方（服务端）用 postLedger 落地。
 */
import { createDeck, shuffle, deal, parsePlay, canBeat } from './ddz.ts'
import type { Card, Play } from './ddz.ts'
import { createWall, canWin } from './mj.ts'
import type { Meld, Tile } from './mj.ts'

export type GameKind = 'ddz' | 'mj'

export interface Player {
  id: string
  name?: string
}

export interface SessionOpts {
  /** 洗牌种子（可复现）。默认 1。 */
  seed?: number
  /** 每人入座费（整数鱼币）。底池 pot = seatFee * seats。默认 0。 */
  seatFee?: number
  /** 斗地主地主座位（默认 0）。 */
  landlord?: number
}

export interface BaseSession {
  game: GameKind
  players: Player[]
  seats: number
  seed: number
  seatFee: number
  /** 底池（本模块不碰钱，只记录应分配额 = seatFee * seats）。 */
  pot: number
  /** 当前该行动的座位。 */
  turn: number
  done: boolean
}

export interface DdzLastPlay {
  play: Play
  cards: Card[]
  seat: number
}

export interface DdzSession extends BaseSession {
  game: 'ddz'
  /** 三家手牌（地主 20 张，农民各 17 张） */
  hands: Card[][]
  /** 3 张底牌 */
  bottom: Card[]
  landlord: number
  /** 当前需要压过的上一手（null = 新一轮领出） */
  last: DdzLastPlay | null
  /** 上一手是谁打的（pass 清空 last 后由他领出） */
  lastPlaySeat: number | null
  /** 连续 pass 计数（到 seats-1 清空 last） */
  passes: number
}

export interface MjSession extends BaseSession {
  game: 'mj'
  hands: Tile[][]
  wall: Tile[]
  discards: Tile[]
  melds: Meld[][]
  /** 当前处于「该摸牌」还是「该打牌」阶段 */
  phase: 'await_draw' | 'await_discard'
}

export type Session = DdzSession | MjSession

export type DdzAction = { type: 'play'; cards: Card[] } | { type: 'pass' }
export type MjAction = { type: 'draw' } | { type: 'discard'; tile: Tile } | { type: 'hu' }
export type Action = DdzAction | MjAction

/** 对局内事件（给上层做展示/日志；不含钱）。 */
export interface GameEvent {
  type: string
  seat: number
  cards?: Card[]
  tile?: Tile
  play?: Play
  message?: string
}

/** 结算：赢家、底池、每人从底池分到多少、每人净变化（净变化之和恒为 0）。 */
export interface Settlement {
  winners: number[]
  pot: number
  shares: { seat: number; amount: number }[]
  net: { seat: number; delta: number }[]
}

export interface ApplyResult {
  ok: boolean
  error?: string
  /** 出错时是原 session（不变）；成功时是新 session（原 session 不被修改）。 */
  session: Session
  events: GameEvent[]
  done?: boolean
  settlement?: Settlement
}

function normalizePlayers(players: Player[] | number): Player[] {
  if (typeof players === 'number') {
    if (!Number.isInteger(players) || players < 2) throw new Error('players 至少 2 人')
    return Array.from({ length: players }, (_, i) => ({ id: 'p' + i, name: '玩家' + (i + 1) }))
  }
  if (!Array.isArray(players) || players.length < 2) throw new Error('players 至少 2 人')
  return players.map((p, i) => ({ id: p?.id ?? 'p' + i, name: p?.name ?? '玩家' + (i + 1) }))
}

function makeSettlement(seats: number, seatFee: number, winners: number[], pot: number): Settlement {
  const shares: { seat: number; amount: number }[] = []
  if (winners.length > 0) {
    const base = Math.floor(pot / winners.length)
    let rem = pot - base * winners.length
    for (const w of winners) {
      const amount = base + (rem > 0 ? 1 : 0)
      if (rem > 0) rem--
      shares.push({ seat: w, amount })
    }
  }
  const net = Array.from({ length: seats }, (_, s) => ({
    seat: s,
    delta: (shares.find((x) => x.seat === s)?.amount ?? 0) - seatFee,
  }))
  return { winners, pot, shares, net }
}

/** 当前该谁行动；对局结束后返回 null。 */
export function turnSeat(session: Session): number | null {
  return session.done ? null : session.turn
}

/** 建局：发牌 / 初始化状态。 */
export function createSession(game: GameKind, players: Player[] | number, opts: SessionOpts = {}): Session {
  const list = normalizePlayers(players)
  const seed = opts.seed ?? 1
  const seatFee = opts.seatFee ?? 0
  if (!Number.isInteger(seatFee) || seatFee < 0) throw new Error('seatFee 必须是非负整数')
  const pot = seatFee * list.length

  if (game === 'ddz') {
    if (list.length !== 3) throw new Error('斗地主需要 3 名玩家')
    const { hands, bottom } = deal(shuffle(createDeck(), seed))
    const landlord = opts.landlord ?? 0
    if (!Number.isInteger(landlord) || landlord < 0 || landlord >= 3) throw new Error('landlord 座位非法')
    const withBottom = hands.map((h, i) => (i === landlord ? [...h, ...bottom] : h.slice()))
    return {
      game: 'ddz',
      players: list,
      seats: 3,
      seed,
      seatFee,
      pot,
      turn: landlord,
      done: false,
      hands: withBottom,
      bottom: bottom.slice(),
      landlord,
      last: null,
      lastPlaySeat: null,
      passes: 0,
    }
  }

  if (game === 'mj') {
    if (list.length !== 4) throw new Error('麻将需要 4 名玩家')
    const wall = createWall(seed)
    const hands: Tile[][] = [[], [], [], []]
    // 每人 13 张（从牌墙尾部依次发）
    for (let round = 0; round < 13; round++) {
      for (let s = 0; s < 4; s++) hands[s].push(wall.pop() as Tile)
    }
    // 庄家（0 号）再摸一张，进入「该打牌」阶段
    hands[0].push(wall.pop() as Tile)
    return {
      game: 'mj',
      players: list,
      seats: 4,
      seed,
      seatFee,
      pot,
      turn: 0,
      done: false,
      hands,
      wall,
      discards: [],
      melds: [[], [], [], []],
      phase: 'await_discard',
    }
  }

  throw new Error(`未知游戏：${String(game)}`)
}

function fail(session: Session, error: string): ApplyResult {
  return { ok: false, error, session, events: [] }
}

/** 从手牌里移除给定牌（多重集）；不是子集返回 null。 */
function removeCards(hand: Card[], cards: Card[]): Card[] | null {
  const remain = hand.slice()
  for (const c of cards) {
    const idx = remain.findIndex((h) => h.rank === c.rank && h.suit === c.suit && Boolean(h.joker) === Boolean(c.joker))
    if (idx < 0) return null
    remain.splice(idx, 1)
  }
  return remain
}

function applyDdz(s: DdzSession, seat: number, action: DdzAction): ApplyResult {
  if (s.done) return fail(s, '对局已结束')
  if (seat !== s.turn) return fail(s, '还没轮到你')

  if (action?.type === 'play') {
    const cards = action.cards
    if (!Array.isArray(cards) || cards.length === 0) return fail(s, '出牌不能为空')
    const remaining = removeCards(s.hands[seat], cards)
    if (!remaining) return fail(s, '手牌里没有这些牌')
    const play = parsePlay(cards)
    if (!play) return fail(s, '不是合法牌型')
    const last = s.last?.play ?? null
    if (!canBeat(play, last)) return fail(s, '压不过上家的牌')

    const hands = s.hands.map((h, i) => (i === seat ? remaining : h))
    const done = remaining.length === 0
    const ns: DdzSession = {
      ...s,
      hands,
      last: { play, cards: cards.slice(), seat },
      lastPlaySeat: seat,
      passes: 0,
      turn: done ? seat : (seat + 1) % s.seats,
      done,
    }
    const events: GameEvent[] = [{ type: 'play', seat, cards: cards.slice(), play }]
    if (done) {
      events.push({ type: 'win', seat })
      return { ok: true, session: ns, events, done: true, settlement: makeSettlement(s.seats, s.seatFee, [seat], s.pot) }
    }
    return { ok: true, session: ns, events }
  }

  if (action?.type === 'pass') {
    if (!s.last) return fail(s, '你是领出方，不能 pass')
    const passes = s.passes + 1
    if (passes >= s.seats - 1) {
      // 其余人都过：清空上一手，由上一手的人重新领出
      const ns: DdzSession = { ...s, last: null, passes: 0, turn: s.lastPlaySeat ?? seat }
      return { ok: true, session: ns, events: [{ type: 'pass', seat }, { type: 'new_round', seat: ns.turn }] }
    }
    const ns: DdzSession = { ...s, passes, turn: (seat + 1) % s.seats }
    return { ok: true, session: ns, events: [{ type: 'pass', seat }] }
  }

  return fail(s, '未知动作')
}

function applyMj(s: MjSession, seat: number, action: MjAction): ApplyResult {
  if (s.done) return fail(s, '对局已结束')
  if (seat !== s.turn) return fail(s, '还没轮到你')

  if (action?.type === 'draw') {
    if (s.phase !== 'await_draw') return fail(s, '现在该打牌，不是摸牌')
    if (s.wall.length === 0) {
      const ns: MjSession = { ...s, done: true }
      return { ok: true, session: ns, events: [{ type: 'draw_wall_empty', seat }], done: true, settlement: makeSettlement(s.seats, s.seatFee, [], 0) }
    }
    const wall = s.wall.slice()
    const tile = wall.pop() as Tile
    const hands = s.hands.map((h, i) => (i === seat ? [...h, tile] : h))
    const ns: MjSession = { ...s, wall, hands, phase: 'await_discard' }
    return { ok: true, session: ns, events: [{ type: 'draw', seat, tile }] }
  }

  if (action?.type === 'discard') {
    if (s.phase !== 'await_discard') return fail(s, '现在该摸牌，不是打牌')
    const tile = action.tile
    if (!tile) return fail(s, '要说打哪张牌')
    const idx = s.hands[seat].findIndex((t) => t.kind === tile.kind && t.rank === tile.rank)
    if (idx < 0) return fail(s, '手里没有这张牌')
    const hand = s.hands[seat].slice()
    hand.splice(idx, 1)
    const hands = s.hands.map((h, i) => (i === seat ? hand : h))
    const ns: MjSession = {
      ...s,
      hands,
      discards: [...s.discards, { kind: tile.kind, rank: tile.rank }],
      turn: (seat + 1) % s.seats,
      phase: 'await_draw',
    }
    return { ok: true, session: ns, events: [{ type: 'discard', seat, tile: { kind: tile.kind, rank: tile.rank } }] }
  }

  if (action?.type === 'hu') {
    if (s.phase !== 'await_discard') return fail(s, '现在不能胡牌')
    if (!canWin(s.hands[seat], s.melds[seat])) return fail(s, '还没胡牌')
    const ns: MjSession = { ...s, done: true }
    return { ok: true, session: ns, events: [{ type: 'win', seat }], done: true, settlement: makeSettlement(s.seats, s.seatFee, [seat], s.pot) }
  }

  return fail(s, '未知动作')
}

/**
 * 执行一个动作。非法动作返回 { ok:false, error }（不抛异常、不改原 session）。
 * 成功返回新 session（原对象不被修改）、本次 events，若终局还带 done / settlement。
 */
export function applyAction(session: Session, seat: number, action: Action): ApplyResult {
  try {
    if (!Number.isInteger(seat) || seat < 0 || seat >= session.seats) return fail(session, '座位非法')
    if (session.game === 'ddz') return applyDdz(session, seat, action as DdzAction)
    if (session.game === 'mj') return applyMj(session, seat, action as MjAction)
    return fail(session, '未知游戏')
  } catch (e) {
    return fail(session, `动作处理出错：${(e as Error)?.message ?? String(e)}`)
  }
}
