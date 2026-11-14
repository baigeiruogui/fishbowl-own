// 限流中间件（纯新增，不接线）：内存滑窗计数器，返回 Fastify preHandler。
// 语义：按 key 在 windowMs 内最多放行 max 次，超限回 429 { error:'RATE_LIMITED', retry_after }（秒）。
// 单进程内存实现，够本波用；多实例部署时需替换为共享存储。
import type { FastifyReply, FastifyRequest } from 'fastify'

export type RateLimitKeyOf = (req: FastifyRequest) => string

export interface RateLimiterOptions {
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 窗口内最大放行次数 */
  max: number
  /** 计数键（默认按 IP） */
  keyOf?: RateLimitKeyOf
  /** 注入时钟（测试用），默认 Date.now */
  now?: () => number
}

interface Bucket {
  count: number
  resetAt: number
}

/**
 * 创建限流 preHandler。用法：
 *   app.get('/x', { preHandler: createRateLimiter({ windowMs: 60_000, max: 60 }) }, handler)
 */
export function createRateLimiter(opts: RateLimiterOptions): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const windowMs = Number(opts?.windowMs)
  const max = Number(opts?.max)
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be a positive number')
  if (!Number.isInteger(max) || max < 0) throw new Error('max must be a non-negative integer')
  const keyOf = opts.keyOf ?? perIpKey
  const clock = opts.now ?? (() => Date.now())
  const buckets = new Map<string, Bucket>()

  return async function rateLimiter(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = keyOf(req)
    const now = clock()
    let bucket = buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }
    if (bucket.count >= max) {
      const retryAfter = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000))
      reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({ error: 'RATE_LIMITED', code: 'RATE_LIMITED', retry_after: retryAfter })
      return
    }
    bucket.count += 1
  }
}

/** 便捷 keyOf：按客户端 IP。 */
export const perIpKey: RateLimitKeyOf = (req: FastifyRequest): string => 'ip:' + (req.ip || 'unknown')

/** 便捷 keyOf：按镇民接入码（Authorization: Bearer <code>），无则回落到 IP。 */
export const perResidentKey: RateLimitKeyOf = (req: FastifyRequest): string => {
  const auth = req.headers?.authorization
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m && m[1].trim()) return 'resident:' + m[1].trim()
  }
  return perIpKey(req)
}
