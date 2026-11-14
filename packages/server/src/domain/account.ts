// 账本查询 / 不变量 / 消费（含每日消费上限）：所有「花钱」的统一入口。
import type { LedgerReason } from '@fishbowl/shared'
import { getFish, postLedger } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { asDomainError, assertIntAmount, DomainError } from './errors.ts'
import { withSavepoint } from './tx.ts'

export const DAY_MS = 86_400_000

/** 本地自然日 0 点（用进程本地时区，与「今天」的直觉一致）。 */
export function startOfLocalDay(now: number = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 账本求和——余额的真相来源。ledger 是 append-only，SUM(delta) 必须恒等于 fish.balance。 */
export function ledgerSum(db: DB, fishId: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE fish_id = ?')
    .get(fishId) as { s: number }
  return Number(row.s)
}

/** 本地「今天」已消费的鱼币（只统计负向 delta 的绝对值之和）。 */
export function spentToday(db: DB, fishId: string, now: number = Date.now()): number {
  const start = startOfLocalDay(now)
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(-delta), 0) AS s FROM ledger
       WHERE fish_id = ? AND delta < 0 AND ts >= ? AND ts < ?`,
    )
    .get(fishId, start, start + DAY_MS) as { s: number }
  return Number(row.s)
}

/**
 * 每日消费上限校验。day_cap 为 NULL = 不限。
 * 本次消费后「今天累计消费」不得超过 day_cap，否则抛 DAY_CAP。
 */
export function assertDayCap(db: DB, fishId: string, amount: number, now: number = Date.now()): void {
  const spend = assertIntAmount(amount)
  const fish = getFish(db, fishId)
  if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
  if (fish.dayCap == null) return
  const already = spentToday(db, fishId, now)
  if (already + spend > fish.dayCap) {
    throw new DomainError(
      'DAY_CAP',
      `daily spending cap ${fish.dayCap} exceeded (already spent ${already}, this ${spend})`,
      { detail: { cap: fish.dayCap, already, amount: spend } },
    )
  }
}

export interface SpendResult {
  /** 消费后余额 */
  balance: number
  /** 本次花掉的鱼币（非负） */
  spent: number
  /** 账本实际 delta（0 或 -spent） */
  delta: number
}

/**
 * 通用「花钱」：先校验每日上限，再 postLedger(-amount, reason)。
 * 余额不足时 postLedger 抛 INSUFFICIENT（不透支），这里原样透传。
 * 所有消费类操作（座位费 / 买商品 / 送礼…）都应走这里，保证账本唯一入口 + day_cap。
 */
export function spend(
  db: DB,
  fishId: string,
  amount: number,
  reason: LedgerReason,
  ref: string | null = null,
  now: number = Date.now(),
): SpendResult {
  const spendAmount = assertIntAmount(amount)
  return withSavepoint(db, () => {
    assertDayCap(db, fishId, spendAmount, now)
    if (spendAmount === 0) {
      const fish = getFish(db, fishId)
      if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
      return { balance: fish.balance, spent: 0, delta: 0 }
    }
    try {
      const r = postLedger(db, fishId, -spendAmount, reason, ref)
      return { balance: r.balance, spent: spendAmount, delta: r.delta }
    } catch (e) {
      throw asDomainError(e) // 保留 INSUFFICIENT / NOT_FOUND 等
    }
  }, 'spend')
}

export interface BalanceCheck {
  fishId: string
  balance: number
  ledgerSum: number
  ok: boolean
}

/** 校验一条鱼的不变量：fish.balance === SUM(ledger.delta)。 */
export function verifyBalance(db: DB, fishId: string): BalanceCheck {
  const fish = getFish(db, fishId)
  if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
  const sum = ledgerSum(db, fishId)
  return { fishId, balance: fish.balance, ledgerSum: sum, ok: sum === fish.balance }
}

/** 不变量被破坏时抛 CONFLICT（正常情况下永远 ok）。 */
export function assertBalanceIntegrity(db: DB, fishId: string): BalanceCheck {
  const c = verifyBalance(db, fishId)
  if (!c.ok) {
    throw new DomainError('CONFLICT', `balance ${c.balance} != ledger sum ${c.ledgerSum} for ${fishId}`, {
      detail: { ...c },
    })
  }
  return c
}
