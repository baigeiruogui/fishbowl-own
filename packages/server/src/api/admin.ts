// 全局管理员 API（ADMIN_TOKEN）：列全部鱼 / 审批 / 封禁 / 解封。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { getFish } from '../db/index.ts'
import type { Fish } from '@fishbowl/shared'
import { isAdmin, sendError } from './common.ts'
import { DomainError } from '../domain/errors.ts'
import { createRateLimiter, perIpKey } from './rate-limit.ts'

export interface AdminDeps {
  db: DB
  adminToken: string
  /** 管理员接口限流（默认 120 次 / 10 分钟，按 IP） */
  adminMax?: number
  windowMs?: number
}

function fishView(f: Fish) {
  return {
    id: f.id,
    ownerId: f.ownerId,
    name: f.name,
    kind: f.kind,
    status: f.status,
    balance: f.balance,
    dayCap: f.dayCap,
    intro: f.intro,
    persona: f.persona,
    createdAt: f.createdAt,
  }
}

export const adminRoutes: FastifyPluginAsync<AdminDeps> = async (app: FastifyInstance, opts) => {
  const { db, adminToken } = opts
  // /api/admin/* 全局限流（按 IP），防止管理员 token 泄露后被刷
  app.addHook('onRequest', createRateLimiter({ windowMs: opts.windowMs ?? 10 * 60_000, max: opts.adminMax ?? 120, keyOf: perIpKey }))
  const guard = (fn: (ctx: { req: FastifyRequest; reply: FastifyReply }) => Promise<unknown> | unknown) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isAdmin(req, adminToken)) {
        return reply.code(401).send({ ok: false, error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', reason: 'missing or invalid admin token' })
      }
      try {
        return await fn({ req, reply })
      } catch (e) {
        return sendError(reply, e)
      }
    }
  }

  const allFish = () => {
    const rows = db
      .prepare('SELECT id, owner_id, name, kind, status, balance, day_cap, intro, persona, created_at FROM fish ORDER BY created_at ASC')
      .all() as unknown as {
      id: string
      owner_id: string | null
      name: string
      kind: string
      status: string
      balance: number
      day_cap: number | null
      intro: string
      persona: string
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      balance: Number(r.balance),
      dayCap: r.day_cap == null ? null : Number(r.day_cap),
      intro: r.intro,
      persona: r.persona,
      createdAt: Number(r.created_at),
    }))
  }

  app.get(
    '/fish',
    guard(() => {
      const items = allFish()
      return { ok: true, count: items.length, fish: items, items }
    }),
  )

  app.post(
    '/fish/:id/approve',
    guard(({ req }) => {
      const { id } = req.params as { id: string }
      const fish = getFish(db, id)
      if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${id}`)
      if (fish.status === 'banned') throw new DomainError('CONFLICT', '该鱼已被封禁，请先 unban 再 approve')
      db.prepare(`UPDATE fish SET status = 'active' WHERE id = ?`).run(id)
      return { ok: true, fish: fishView(getFish(db, id)!) }
    }),
  )

  app.post(
    '/fish/:id/ban',
    guard(({ req }) => {
      const { id } = req.params as { id: string }
      if (!getFish(db, id)) throw new DomainError('NOT_FOUND', `fish not found: ${id}`)
      db.prepare(`UPDATE fish SET status = 'banned' WHERE id = ?`).run(id)
      return { ok: true, fish: fishView(getFish(db, id)!) }
    }),
  )

  app.post(
    '/fish/:id/unban',
    guard(({ req }) => {
      const { id } = req.params as { id: string }
      if (!getFish(db, id)) throw new DomainError('NOT_FOUND', `fish not found: ${id}`)
      db.prepare(`UPDATE fish SET status = 'active' WHERE id = ?`).run(id)
      return { ok: true, fish: fishView(getFish(db, id)!) }
    }),
  )
}

export default adminRoutes
