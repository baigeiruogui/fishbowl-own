// 脚本化 NPC 的决策大脑：纯函数、无 IO、确定性随机。
// decide(view, rng) 按「性格 × 时段 × 金钱」给每个候选行为打分（权重），
// 再用 rng() 做一次加权抽样。给定相同 view 与相同 seed 的 rng，结果必然一致。

import type { NpcAction, NpcJob, NpcShopItem, NpcTable, NpcView, Personality, TimeOfDay } from './types.ts'

/**
 * mulberry32：小而快的 32 位种子随机数发生器。
 * 返回的函数每次调用产出 [0, 1) 的浮点数，序列由 seed 完全决定。
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 各时段「休息」的基础权重：夜里明显更想睡。 */
const REST_TIME: Record<TimeOfDay, number> = {
  morning: 1,
  afternoon: 1,
  evening: 1.6,
  night: 6,
}

/** 各时段「打工」的活跃度：白天更愿意干活，夜里基本不想。 */
const WORK_TIME: Record<TimeOfDay, number> = {
  morning: 1.2,
  afternoon: 1.25,
  evening: 1.0,
  night: 0.35,
}

/** 各时段「接悬赏」的意愿：傍晚略高，夜里低。 */
const BOUNTY_TIME: Record<TimeOfDay, number> = {
  morning: 0.9,
  afternoon: 1.0,
  evening: 1.15,
  night: 0.35,
}

/** 各时段「玩牌」的热度：下午/傍晚最想玩，夜里冷清。 */
const PLAY_TIME: Record<TimeOfDay, number> = {
  morning: 0.8,
  afternoon: 1.35,
  evening: 1.25,
  night: 0.3,
}

/** 各时段「买东西」的热度：傍晚逛街最合适。 */
const SHOP_TIME: Record<TimeOfDay, number> = {
  morning: 0.8,
  afternoon: 1.1,
  evening: 1.15,
  night: 0.6,
}

/** 性格对「休息」的乘数。 */
const REST_PERSONALITY: Record<Personality, number> = {
  lively: 0.6,
  lazy: 2.2,
  greedy: 0.9,
  kind: 1.0,
}

/** 性格对「打工」的乘数。 */
const WORK_PERSONALITY: Record<Personality, number> = {
  lively: 0.8,
  lazy: 0.7,
  greedy: 1.6,
  kind: 0.7,
}

/** 性格对「接悬赏」的乘数。 */
const BOUNTY_PERSONALITY: Record<Personality, number> = {
  lively: 1.0,
  lazy: 0.6,
  greedy: 1.8,
  kind: 1.0,
}

/** 性格对「玩牌」的乘数。 */
const PLAY_PERSONALITY: Record<Personality, number> = {
  lively: 2.6,
  lazy: 0.8,
  greedy: 0.8,
  kind: 1.5,
}

/** 性格对「买东西」的乘数。 */
const SHOP_PERSONALITY: Record<Personality, number> = {
  lively: 1.1,
  lazy: 0.7,
  greedy: 0.8,
  kind: 2.4,
}

/** 缺钱压力：coins 越少，打工/接悬赏的意愿越强。 */
function moneyPressure(coins: number): number {
  if (coins < 20) return 3.5
  if (coins < 50) return 2.2
  if (coins < 100) return 1.4
  return 1
}

/** 挑一个还缺人的、且入场费付得起的牌桌（缺人越多越优先）。 */
function pickTable(tables: NpcTable[], coins: number): NpcTable | null {
  let best: NpcTable | null = null
  for (const t of tables) {
    if (t.needed <= 0) continue // 满员/不需要人 → 不玩
    if (t.seatFee > coins) continue // 付不起入场费
    if (best === null || t.needed > best.needed) best = t
  }
  return best
}

/** 挑一个买得起的商品（最便宜的优先，且要有库存）。 */
function pickShopItem(shops: NpcView['shops'], coins: number): { shopId: string; item: NpcShopItem } | null {
  let best: { shopId: string; item: NpcShopItem } | null = null
  for (const s of shops) {
    for (const item of s.items) {
      if (item.stock <= 0) continue // 没货
      if (item.price > coins) continue // 买不起
      if (best === null || item.price < best.item.price) best = { shopId: s.id, item }
    }
  }
  return best
}

/** 挑工资最高的活。 */
function pickJob(jobs: NpcJob[]): NpcJob | null {
  let best: NpcJob | null = null
  for (const j of jobs) if (best === null || j.pay > best.pay) best = j
  return best
}

/** 挑赏金最高的悬赏。 */
function pickBounty(bounties: NpcView['bounties']): { id: string; reward: number } | null {
  let best: { id: string; reward: number } | null = null
  for (const b of bounties) if (best === null || b.reward > best.reward) best = b
  return best
}

interface Candidate {
  weight: number
  build: () => NpcAction
}

/** 按权重抽一个候选；权重 <= 0 的已被过滤。 */
function pickWeighted(candidates: Candidate[], rng: () => number): NpcAction {
  let total = 0
  for (const c of candidates) total += c.weight
  if (total <= 0) return { kind: 'none' }
  let r = rng() * total
  for (const c of candidates) {
    r -= c.weight
    if (r < 0) return c.build()
  }
  return candidates[candidates.length - 1]!.build()
}

/** 休息多少分钟：随时段基础值 × 性格 × 一点抖动。 */
function restMinutes(time: TimeOfDay, personality: Personality, rng: () => number): number {
  const base = REST_TIME[time] * 30 // morning 30 / afternoon 30 / evening 48 / night 180
  const personalityAdj = personality === 'lazy' ? 1.5 : personality === 'lively' ? 0.7 : 1
  const jitter = 0.85 + rng() * 0.3 // 0.85 – 1.15
  return Math.max(5, Math.round(base * personalityAdj * jitter))
}

/**
 * 核心决策：给定 NPC 视角快照与确定性 rng，返回一个行为。
 * 空快照 / 空数组不会抛异常，至少会休息。
 */
export function decide(view: NpcView, rng: () => number): NpcAction {
  // 防御：允许上层传入缺字段的快照而不崩。
  if (!view || !Array.isArray(view.tables)) {
    return { kind: 'rest', minutes: 30 }
  }

  const coins = typeof view.coins === 'number' && Number.isFinite(view.coins) ? view.coins : 0
  const personality: Personality = view.personality ?? 'kind'
  const time: TimeOfDay = view.timeOfDay ?? 'afternoon'
  const pressure = moneyPressure(coins)

  const tables = view.tables ?? []
  const jobs = view.jobs ?? []
  const shops = view.shops ?? []
  const bounties = view.bounties ?? []

  const candidates: Candidate[] = []

  // 休息永远可选。
  candidates.push({
    weight: REST_TIME[time] * REST_PERSONALITY[personality] * (pressure > 1 ? 0.75 : 1),
    build: () => ({ kind: 'rest', minutes: restMinutes(time, personality, rng) }),
  })

  // 打工：有钱可赚，缺钱更想干。
  const job = pickJob(jobs)
  if (job) {
    candidates.push({
      weight: 3 * WORK_PERSONALITY[personality] * WORK_TIME[time] * pressure,
      build: () => ({ kind: 'work', jobId: job.id }),
    })
  }

  // 接悬赏：赚钱，缺钱更想接。
  const bounty = pickBounty(bounties)
  if (bounty) {
    candidates.push({
      weight: 2 * BOUNTY_PERSONALITY[personality] * BOUNTY_TIME[time] * pressure,
      build: () => ({ kind: 'bounty', bountyId: bounty.id }),
    })
  }

  // 玩牌：只有牌桌缺人、且付得起入场费时才会考虑。
  const table = pickTable(tables, coins)
  if (table) {
    candidates.push({
      weight: 3 * PLAY_PERSONALITY[personality] * PLAY_TIME[time],
      build: () => ({ kind: 'play', tableId: table.id }),
    })
  }

  // 买东西：只有存在买得起且有货的商品时才会考虑。
  const shopPick = pickShopItem(shops, coins)
  if (shopPick) {
    candidates.push({
      weight: 2 * SHOP_PERSONALITY[personality] * SHOP_TIME[time],
      build: () => ({ kind: 'shop', shopId: shopPick.shopId, itemId: shopPick.item.id }),
    })
  }

  return pickWeighted(candidates, rng)
}
