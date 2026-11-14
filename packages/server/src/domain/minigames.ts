// 小游戏领域（纯逻辑 + rng 注入，不接线）：猜拳 / 掷骰子 / 每日抽奖。
// 金额一律走 postLedger（reason='game_win'；输钱也用该标签的负 delta），下注前校验余额不透支。
import { getFish, postLedger } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { assertPositiveInt, DomainError } from './errors.ts'
import { startOfLocalDay } from './account.ts'

export type Rng = () => number
const DEFAULT_STAKE = 5

function randInt(rng: Rng, n: number): number {
  const v = rng()
  const x = Number.isFinite(v) ? v : 0
  const idx = Math.floor((x < 0 ? 0 : x >= 1 ? 0.999999999 : x) * n)
  return idx
}

function requireFish(db: DB, fishId: string) {
  const fish = getFish(db, fishId)
  if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
  return fish
}

function requireStake(db: DB, fishId: string, stake: number | undefined): number {
  const s = assertPositiveInt(stake ?? DEFAULT_STAKE, 'stake')
  const fish = requireFish(db, fishId)
  if (fish.balance < s) {
    throw new DomainError('INSUFFICIENT', `余额不足以下注 ${s}（当前 ${fish.balance}）`, { balance: fish.balance })
  }
  return s
}

// ---------------- 猜拳 ----------------

export type RpsChoice = 'rock' | 'scissors' | 'paper'
const RPS_CHOICES: RpsChoice[] = ['rock', 'scissors', 'paper']
const BEATS: Record<RpsChoice, RpsChoice> = { rock: 'scissors', scissors: 'paper', paper: 'rock' }

export interface RpsOptions {
  choice: RpsChoice
  stake?: number
  rng?: Rng
  now?: number
}

export interface RpsResult {
  choice: RpsChoice
  opponent: RpsChoice
  result: 'win' | 'lose' | 'draw'
  win: boolean
  stake: number
  /** 结算后余额 */
  balance: number
}

/** 石头剪刀布：赢 +stake，输 -stake，平不结算。下注前校验余额。 */
export function playRps(db: DB, fishId: string, opts: RpsOptions): RpsResult {
  const choice = opts?.choice
  if (!choice || !RPS_CHOICES.includes(choice)) {
    throw new DomainError('BAD_REQUEST', "choice 必须是 'rock' | 'scissors' | 'paper'")
  }
  const stake = requireStake(db, fishId, opts.stake)
  const rng = opts.rng ?? Math.random
  const opponent = RPS_CHOICES[randInt(rng, 3)]!

  if (opponent === choice) {
    return { choice, opponent, result: 'draw', win: false, stake, balance: getFish(db, fishId)!.balance }
  }
  const win = BEATS[choice] === opponent
  const delta = win ? stake : -stake
  const after = postLedger(db, fishId, delta, 'game_win', 'rps')
  return { choice, opponent, result: win ? 'win' : 'lose', win, stake, balance: after.balance }
}

// ---------------- 掷骰子 ----------------

export interface DiceOptions {
  stake?: number
  rng?: Rng
  now?: number
}

export interface DiceResult {
  player: number
  opponent: number
  result: 'win' | 'lose' | 'draw'
  win: boolean
  stake: number
  balance: number
}

/** 掷骰子：双方各掷 1-6 比大小，赢 +stake、输 -stake、平不结算。 */
export function rollDice(db: DB, fishId: string, opts: DiceOptions = {}): DiceResult {
  const stake = requireStake(db, fishId, opts.stake)
  const rng = opts.rng ?? Math.random
  const player = 1 + randInt(rng, 6)
  const opponent = 1 + randInt(rng, 6)
  if (player === opponent) {
    return { player, opponent, result: 'draw', win: false, stake, balance: getFish(db, fishId)!.balance }
  }
  const win = player > opponent
  const after = postLedger(db, fishId, win ? stake : -stake, 'game_win', 'dice')
  return { player, opponent, result: win ? 'win' : 'lose', win, stake, balance: after.balance }
}

// ---------------- 每日抽奖 ----------------

export interface LotteryOptions {
  rng?: Rng
  now?: number
}

export interface LotteryResult {
  /** 是否中奖 */
  hit: boolean
  /** 奖励鱼币（未中为 0） */
  bonus: number
  prize: string | null
  balance: number
}

const LOTTERY_LOW = 1
const LOTTERY_HIGH = 10

function metaGet(db: DB, k: string): string | null {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined
  return r ? r.v : null
}

function metaSet(db: DB, k: string, v: string): void {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v)
}

/** 每日免费抽奖：命中给小额奖励（1-10 鱼币），每天 1 次（meta 记 lastLotteryDay）。 */
export function lottery(db: DB, fishId: string, opts: LotteryOptions = {}): LotteryResult {
  requireFish(db, fishId)
  const now = opts.now ?? Date.now()
  const dayKey = String(startOfLocalDay(now))
  const last = metaGet(db, 'lastLotteryDay:' + fishId)
  if (last === dayKey) {
    throw new DomainError('DAY_CAP', '今天已经抽过奖了，明天再来')
  }
  // 先占用今天的次数（无论中没中都算用掉）
  metaSet(db, 'lastLotteryDay:' + fishId, dayKey)

  const rng = opts.rng ?? Math.random
  const hit = rng() < 0.5
  let bonus = 0
  let prize: string | null = null
  if (hit) {
    bonus = LOTTERY_LOW + randInt(rng, LOTTERY_HIGH - LOTTERY_LOW + 1)
    postLedger(db, fishId, bonus, 'game_win', 'lottery')
    prize = `小镇彩票 ${bonus} 鱼币`
  }
  return { hit, bonus, prize, balance: getFish(db, fishId)!.balance }
}
