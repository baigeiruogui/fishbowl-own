// domain 层统一错误：带稳定 code，供上层（API / sim）映射成回执或 HTTP 状态。
import { ERR } from '@fishbowl/shared'

export type DomainCode =
  | 'INSUFFICIENT'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'DAY_CAP'
  | 'ALREADY_WORKING'
  | 'NO_SLOTS'
  | 'CONTRACT_CLOSED'
  | 'EMPTY'

export interface DomainErrorOptions {
  /** 余额不足时带上当前余额，方便回执 / 插件展示 */
  balance?: number
  /** 额外结构化信息（如 day_cap 的 cap/already/amount） */
  detail?: Record<string, unknown>
}

export class DomainError extends Error {
  code: DomainCode | string
  balance?: number
  detail?: Record<string, unknown>

  constructor(code: DomainCode | string, message: string, opts: DomainErrorOptions = {}) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    if (opts.balance !== undefined) this.balance = opts.balance
    if (opts.detail !== undefined) this.detail = opts.detail
  }
}

/**
 * 把底层（postLedger 等）抛出的裸 Error(code) 规整成 DomainError。
 * 保留 code / balance，避免上层还要分两种错误类型。
 */
export function asDomainError(e: unknown): DomainError {
  if (e instanceof DomainError) return e
  const err = e as { code?: string; message?: string; balance?: number } | undefined
  const code = err?.code ?? ERR.BAD_REQUEST
  return new DomainError(code, err?.message ?? String(e), { balance: err?.balance })
}

/** 断言为非负整数（鱼币最小单位=1，不接受小数 / 负数）。返回规整后的 number。 */
export function assertIntAmount(amount: unknown, field = 'amount'): number {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
    throw new DomainError('BAD_REQUEST', `${field} must be a non-negative integer, got ${String(amount)}`)
  }
  return amount
}

/** 断言为正整数（数量类）。 */
export function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DomainError('BAD_REQUEST', `${field} must be a positive integer, got ${String(value)}`)
  }
  return value
}
