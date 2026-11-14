// 座位费领域：入座扣费（花钱），走 postLedger(-fee, 'seat_fee')，余额不足抛 INSUFFICIENT 且不透支。
import type { DB } from '../db/index.ts'
import { spend, type SpendResult } from './account.ts'
import { assertIntAmount } from './errors.ts'

export interface SeatFeeInput {
  fee: number
  /** 关联引用（如座位 / 牌桌 id） */
  ref?: string | null
  now?: number
}

/**
 * 入座付费：
 *  - fee=0 → 免费入座，不写账本；
 *  - fee>0 → 走 spend()（含 day_cap 校验）→ postLedger(-fee, 'seat_fee')；
 *  - 余额不足 → DomainError code='INSUFFICIENT'（不透支，余额不变）。
 */
export function paySeatFee(
  db: DB,
  fishId: string,
  feeOrInput: number | SeatFeeInput,
  now: number = Date.now(),
): SpendResult {
  const input: SeatFeeInput = typeof feeOrInput === 'number' ? { fee: feeOrInput } : feeOrInput
  const fee = assertIntAmount(input.fee, 'fee')
  return spend(db, fishId, fee, 'seat_fee', input.ref ?? null, input.now ?? now)
}
