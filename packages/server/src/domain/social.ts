// 社交/礼物领域：送礼扣钱（唯一入口 postLedger，reason='gift'），受「每日社交预算」约束。
// 只新增文件，不改现有代码、不接线 API。金额单位：整数鱼币。
//
// 社交预算配置（meta，均可缺省）：
//   social_day_cents   每日社交预算的分（默认 50 = 0.5 元）
//   fishcoin_per_cent  1 分折合多少鱼币（默认 1）→ 默认预算 = 50 分 × 1 = 50 鱼币
//   social_day_cents:<fishId>  可选：某条鱼的每日预算分（覆盖全局）
// 真实花费以账本 reason='gift' 的当日负向 delta 汇总为准（dailySocialUsed）。
import { getFish, newId, postLedger, tx } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { asDomainError, assertPositiveInt, DomainError } from './errors.ts'
import { assertDayCap, startOfLocalDay, DAY_MS } from './account.ts'

/** 送礼入参。item 礼物名，price 礼价（>0 整数鱼币），words 附言（可选）。 */
export interface GiftInput {
  item: string
  price: number
  words?: string
}

export interface GiftResult {
  ref: string
  fromFishId: string
  toFishId: string
  item: string
  price: number
  /** 送礼后送礼人余额 */
  balance: number
  /** 今日（含本次）累计社交花费 */
  usedToday: number
  /** 每日社交预算（鱼币） */
  budget: number
}

function metaGet(db: DB, k: string): string | null {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined
  return r ? r.v : null
}

function metaNum(db: DB, k: string, def: number): number {
  const v = metaGet(db, k)
  if (v == null) return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

/** 每日社交预算（鱼币）：分 × 每分鱼币。可按 fishId 配置覆盖。 */
export function socialBudget(db: DB, fishId: string): number {
  const perFish = metaGet(db, 'social_day_cents:' + fishId)
  const cents = perFish != null ? Number(perFish) : metaNum(db, 'social_day_cents', 50)
  const perCent = metaNum(db, 'fishcoin_per_cent', 1)
  const budget = Math.round((Number.isFinite(cents) ? cents : 50) * (Number.isFinite(perCent) ? perCent : 1))
  return Math.max(0, budget)
}

/** 今日（本地自然日）该鱼已花的社交鱼币（按账本 reason='gift' 汇总）。 */
export function dailySocialUsed(db: DB, fishId: string, now: number = Date.now()): number {
  const start = startOfLocalDay(now)
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(-delta), 0) AS s FROM ledger
       WHERE fish_id = ? AND reason = 'gift' AND delta < 0 AND ts >= ? AND ts < ?`,
    )
    .get(fishId, start, start + DAY_MS) as { s: number }
  return Number(row.s)
}

/**
 * 送礼：tx 内校验「每日社交预算」与每日消费上限（account.assertDayCap），
 * 再 postLedger(from, -price, 'gift', ref)。余额不足抛 INSUFFICIENT（不透支）。
 * 记录：账本 reason='gift' 即礼物流水；另写一条 event(kind='gift') 便于展示。
 */
export function gift(db: DB, fromFishId: string, toFishId: string, input: GiftInput, now: number = Date.now()): GiftResult {
  if (fromFishId === toFishId) throw new DomainError('BAD_REQUEST', 'cannot gift yourself')
  if (!input || typeof input.item !== 'string' || input.item.trim() === '') {
    throw new DomainError('BAD_REQUEST', 'gift item is required')
  }
  const price = assertPositiveInt(input.price, 'price')

  return tx(db, () => {
    const from = getFish(db, fromFishId)
    if (!from) throw new DomainError('NOT_FOUND', `fish not found: ${fromFishId}`)
    const to = getFish(db, toFishId)
    if (!to) throw new DomainError('NOT_FOUND', `fish not found: ${toFishId}`)

    const budget = socialBudget(db, fromFishId)
    const used = dailySocialUsed(db, fromFishId, now)
    if (used + price > budget) {
      throw new DomainError(
        'DAY_CAP',
        `social budget ${budget} exceeded (used ${used}, this ${price})`,
        { detail: { kind: 'social', cap: budget, already: used, amount: price } },
      )
    }
    // 同时遵守每日消费上限（复用 account 的 day_cap 校验）
    assertDayCap(db, fromFishId, price, now)

    const ref = newId('gift')
    let balance: number
    try {
      balance = postLedger(db, fromFishId, -price, 'gift', ref).balance
    } catch (e) {
      throw asDomainError(e) // 保留 INSUFFICIENT / NOT_FOUND
    }

    db.prepare('INSERT INTO event(fish_id, kind, data_json, ts, read_at) VALUES(?,?,?,?,NULL)').run(
      fromFishId,
      'gift',
      JSON.stringify({ ref, to: toFishId, item: input.item.trim(), price, words: input.words ?? '' }),
      Math.floor(now / 1000),
    )

    return {
      ref,
      fromFishId,
      toFishId,
      item: input.item.trim(),
      price,
      balance,
      usedToday: used + price,
      budget,
    }
  })
}
