// owner / public 路由共用的 HTTP 小工具：错误映射、整数校验、admin 鉴权。
import type { FastifyReply, FastifyRequest } from 'fastify'
import { DomainError } from '../domain/errors.ts'

export const STATUS: Record<string, number> = {
  RESIDENT_CODE: 401,
  UNAUTHORIZED: 401,
  TURN_CLOSED: 409,
  NOT_CONNECTED: 409,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  RATE_LIMITED: 429,
  INSUFFICIENT: 409,
  DAY_CAP: 409,
  CONFLICT: 409,
  UNAVAILABLE: 503,
  RESTARTING: 503,
}

export function sendError(reply: FastifyReply, e: unknown) {
  const err = e as { code?: string; message?: string; balance?: number; detail?: unknown }
  if (err && typeof err.code === 'string') {
    const code = err.code
    const payload: Record<string, unknown> = { ok: false, error: code, code, reason: err.message ?? code }
    if (err.detail !== undefined) payload.detail = err.detail
    if (err.balance !== undefined) payload.balance = err.balance
    return reply.code(STATUS[code] ?? 400).send(payload)
  }
  return reply.code(500).send({ ok: false, error: 'UNAVAILABLE', code: 'UNAVAILABLE', reason: String(err?.message ?? e) })
}

export function jsonBody(req: FastifyRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>
}

export function requireInt(value: unknown, field: string, opts: { min?: number } = {}): number {
  const n = Number(value)
  if (!Number.isInteger(n) || (opts.min !== undefined && n < opts.min)) {
    throw new DomainError('BAD_REQUEST', `${field} must be an integer${opts.min !== undefined ? ` >= ${opts.min}` : ''}`)
  }
  return n
}

/** 主人鉴权：ADMIN_TOKEN，支持 Authorization: Bearer <token> 或 x-admin-token: <token>。 */
export function isAdmin(req: FastifyRequest, adminToken: string): boolean {
  if (!adminToken) return false
  const x = req.headers['x-admin-token']
  if (typeof x === 'string' && x === adminToken) return true
  const auth = req.headers.authorization
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m && m[1].trim() === adminToken) return true
  }
  return false
}
