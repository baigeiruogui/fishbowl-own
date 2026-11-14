// 主人 API：支持全局管理员（ADMIN_TOKEN）与「多主人账号」（ownerToken，按 owner 隔离）。
// 建鱼（一次性返回明文接入码）/ 换码 / 详情 / 暂停 / 恢复 / day_cap；注册 POST /register。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { createFish, getFish } from '../db/index.ts'
import type { Fish } from '@fishbowl/shared'
import { checkLine } from '@fishbowl/shared'
import { issueResidentCode } from './auth.ts'
import { DomainError } from '../domain/errors.ts'
import { isAdmin, jsonBody, requireInt, sendError } from './common.ts'
import { countOwnerFish, ensureOwnerTables, registerOwner, resolveOwnerToken, revokeOwnerToken, rotateOwnerToken } from './owner-auth.ts'
import { createRateLimiter, perIpKey } from './rate-limit.ts'
import { avatarUrl } from './avatar.ts'

export interface OwnerDeps {
  db: DB
  adminToken: string
  startBalance: number
  /** true = 新鱼直接 active；false = 新鱼 pending 待管理员 approve（默认 false） */
  openRegistration?: boolean
  /** 入驻费（元），0 = 免费 */
  joinPriceYuan: number
}

type Principal = { kind: 'admin' } | { kind: 'owner'; ownerId: string; name: string }

const MAX_NAME = 12
const MAX_INTRO = 200
const MAX_PERSONA = 500
const MAX_FISH_PER_OWNER = 3

function fishView(f: Fish, joinPriceYuan = 0) {
  return {
    id: f.id,
    ownerId: f.ownerId,
    name: f.name,
    kind: f.kind,
    persona: f.persona,
    intro: f.intro,
    lookNote: f.lookNote,
    avatar: avatarUrl(f.id),
    status: f.status,
    balance: f.balance,
    dayCap: f.dayCap,
    createdAt: f.createdAt,
    payment: (f.status as string) === 'pending_payment' ? { priceYuan: joinPriceYuan, paid: false } : null,
  }
}

export const ownerRoutes: FastifyPluginAsync<OwnerDeps> = async (app: FastifyInstance, opts) => {
  const { db, adminToken, startBalance } = opts
  const joinPriceYuan = opts.joinPriceYuan ?? 0
  const openRegistration = opts.openRegistration === true
  ensureOwnerTables(db)

  const principalOf = (req: FastifyRequest): Principal | null => {
    if (isAdmin(req, adminToken)) return { kind: 'admin' }
    const owner = resolveOwnerToken(db, req)
    if (owner) return { kind: 'owner', ownerId: owner.ownerId, name: owner.name }
    return null
  }

  const guard = (fn: (ctx: { req: FastifyRequest; reply: FastifyReply; principal: Principal }) => Promise<unknown> | unknown) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const principal = principalOf(req)
      if (!principal) {
        return reply.code(401).send({ ok: false, error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', reason: 'missing or invalid owner/admin token' })
      }
      try {
        return await fn({ req, reply, principal })
      } catch (e) {
        return sendError(reply, e)
      }
    }
  }

  const assertAccess = (id: string, principal: Principal): Fish => {
    const fish = getFish(db, id)
    if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${id}`)
    if (principal.kind === 'owner' && fish.ownerId !== principal.ownerId) {
      throw new DomainError('NOT_FOUND', `fish not found: ${id}`) // 不泄露别人的鱼
    }
    return fish
  }

  // ---------- 自助列表：本人（owner）的全部鱼 ----------
  const fishSelfView = (f: Fish, hasCode: boolean) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
    status: f.status,
    balance: f.balance,
    dayCap: f.dayCap,
    avatar: avatarUrl(f.id),
    hasCode,
    createdAt: f.createdAt,
    payment: (f.status as string) === 'pending_payment' ? { priceYuan: joinPriceYuan, paid: false } : null,
  })

  const ownerSelfPayload = (principal: Principal) => {
    const ownerId = principal.kind === 'owner' ? principal.ownerId : null
    const ownerRow = ownerId
      ? (db.prepare('SELECT id, name FROM owner WHERE id = ?').get(ownerId) as { id: string; name: string } | undefined)
      : undefined
    const owner = ownerId ? { id: ownerId, name: ownerRow?.name ?? '主人' } : { id: null as string | null, name: 'admin' }
    const rows = (
      ownerId
        ? db.prepare('SELECT id FROM fish WHERE owner_id = ? ORDER BY created_at ASC, id ASC').all(ownerId)
        : db.prepare('SELECT id FROM fish ORDER BY created_at ASC, id ASC').all()
    ) as unknown as { id: string }[]
    const hasCodeStmt = db.prepare('SELECT 1 FROM resident_code WHERE fish_id = ? AND revoked_at IS NULL')
    const fish = rows.map((r) => fishSelfView(getFish(db, r.id)!, !!hasCodeStmt.get(r.id)))
    return { ok: true, owner, fish }
  }

  app.get('/me', guard(({ principal }) => ownerSelfPayload(principal)))
  // 别名：GET /api/owner/fish 同返回（与 POST /fish、GET /fish/:id 并存）
  app.get('/fish', guard(({ principal }) => ownerSelfPayload(principal)))

  // ---------- 注册（免鉴权，按 IP 限流 5/小时）----------
  const registerLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 5, keyOf: perIpKey })
  app.post(
    '/register',
    { preHandler: registerLimiter },
    (req, reply) => {
      try {
        const body = jsonBody(req)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if ([...name].length > MAX_NAME) throw new DomainError('BAD_REQUEST', `name 最长 ${MAX_NAME} 字`)
        if (name && !checkLine(name).ok) throw new DomainError('BAD_REQUEST', 'name 不合规')
        const res = registerOwner(db, { name })
        return { ok: true, ownerId: res.ownerId, ownerToken: res.ownerToken, name: res.name }
      } catch (e) {
        return sendError(reply, e)
      }
    },
  )

  // ---------- 建鱼 ----------
  app.post(
    '/fish',
    guard(({ req, principal }) => {
      const body = jsonBody(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) throw new DomainError('BAD_REQUEST', 'name is required')
      if ([...name].length > MAX_NAME) throw new DomainError('BAD_REQUEST', `name 最长 ${MAX_NAME} 字`)
      if (!checkLine(name).ok) throw new DomainError('BAD_REQUEST', 'name 不合规')

      let kind: Fish['kind'] = 'resident'
      if (body.kind !== undefined) {
        if (body.kind !== 'resident' && body.kind !== 'npc') throw new DomainError('BAD_REQUEST', "kind must be 'resident' or 'npc'")
        if (principal.kind === 'owner' && body.kind === 'npc') throw new DomainError('BAD_REQUEST', '主人只能创建 resident 鱼')
        kind = body.kind
      }
      const intro = typeof body.intro === 'string' ? body.intro : ''
      if ([...intro].length > MAX_INTRO) throw new DomainError('BAD_REQUEST', `intro 最长 ${MAX_INTRO} 字`)
      if (intro && !checkLine(intro).ok) throw new DomainError('BAD_REQUEST', 'intro 不合规')
      const persona = typeof body.persona === 'string' ? body.persona : ''
      if ([...persona].length > MAX_PERSONA) throw new DomainError('BAD_REQUEST', `persona 最长 ${MAX_PERSONA} 字`)

      if (principal.kind === 'owner' && countOwnerFish(db, principal.ownerId) >= MAX_FISH_PER_OWNER) {
        throw new DomainError('CONFLICT', `每个主人最多 ${MAX_FISH_PER_OWNER} 条鱼`)
      }

      const balance =
        principal.kind === 'owner'
          ? startBalance
          : body.balance === undefined
            ? startBalance
            : requireInt(body.balance, 'balance', { min: 0 })
      const ownerId = principal.kind === 'owner' ? principal.ownerId : typeof body.owner_id === 'string' ? body.owner_id : null
      const targetStatus = (
        principal.kind === 'owner'
          ? joinPriceYuan > 0
            ? 'pending_payment'
            : openRegistration
              ? 'active'
              : 'pending'
          : 'active'
      ) as unknown as Fish['status']

      const created = createFish(db, { name, kind, persona, intro, balance, ownerId })
      if (created.status !== targetStatus) db.prepare('UPDATE fish SET status = ? WHERE id = ?').run(targetStatus, created.id)
      const fish = getFish(db, created.id)!
      const { code } = issueResidentCode(db, fish.id)
      return { ok: true, fish: fishView(fish, joinPriceYuan), code, status: fish.status }
    }),
  )

  // ---------- 换码 ----------
  app.post(
    '/fish/:id/code/rotate',
    guard(({ req, principal }) => {
      const { id } = req.params as { id: string }
      assertAccess(id, principal)
      const { code } = issueResidentCode(db, id)
      return { ok: true, fish_id: id, code }
    }),
  )

  // ---------- 详情 ----------
  app.get(
    '/fish/:id',
    guard(({ req, principal }) => {
      const { id } = req.params as { id: string }
      const fish = assertAccess(id, principal)
      const hasCode = !!db.prepare(`SELECT 1 FROM resident_code WHERE fish_id = ? AND revoked_at IS NULL`).get(id)
      const summary = db
        .prepare('SELECT reason, SUM(delta) AS total, COUNT(*) AS n FROM ledger WHERE fish_id = ? GROUP BY reason ORDER BY reason')
        .all(id) as unknown as { reason: string; total: number; n: number }[]
      return {
        ok: true,
        fish: fishView(fish, joinPriceYuan),
        hasCode,
        ledgerSummary: summary.map((s) => ({ reason: s.reason, total: Number(s.total), n: Number(s.n) })),
      }
    }),
  )

  // ---------- 暂停 / 恢复 / day_cap ----------
  app.post(
    '/fish/:id/pause',
    guard(({ req, principal }) => {
      const { id } = req.params as { id: string }
      assertAccess(id, principal)
      db.prepare(`UPDATE fish SET status = 'paused' WHERE id = ?`).run(id)
      return { ok: true, fish: fishView(getFish(db, id)!, joinPriceYuan) }
    }),
  )

  app.post(
    '/fish/:id/resume',
    guard(({ req, principal }) => {
      const { id } = req.params as { id: string }
      assertAccess(id, principal)
      db.prepare(`UPDATE fish SET status = 'active' WHERE id = ?`).run(id)
      return { ok: true, fish: fishView(getFish(db, id)!, joinPriceYuan) }
    }),
  )

  app.post(
    '/fish/:id/day_cap',
    guard(({ req, principal }) => {
      const { id } = req.params as { id: string }
      assertAccess(id, principal)
      const body = jsonBody(req)
      if (body.day_cap === null) {
        db.prepare('UPDATE fish SET day_cap = NULL WHERE id = ?').run(id)
      } else {
        const cap = requireInt(body.day_cap, 'day_cap', { min: 0 })
        db.prepare('UPDATE fish SET day_cap = ? WHERE id = ?').run(cap, id)
      }
      return { ok: true, fish: fishView(getFish(db, id)!, joinPriceYuan) }
    }),
  )

  // ---------- ownerToken 轮换 / 撤销（仅主人本人）----------
  const ownerOnly = (fn: (ctx: { req: FastifyRequest; reply: FastifyReply; ownerId: string }) => Promise<unknown> | unknown) =>
    guard(({ req, reply, principal }) => {
      if (principal.kind !== 'owner') throw new DomainError('BAD_REQUEST', '仅主人可操作 ownerToken')
      return fn({ req, reply, ownerId: principal.ownerId })
    })

  app.post(
    '/token/rotate',
    ownerOnly(({ ownerId }) => {
      const ownerToken = rotateOwnerToken(db, ownerId)
      return { ok: true, ownerId, ownerToken }
    }),
  )

  app.post(
    '/token/revoke',
    ownerOnly(({ ownerId }) => {
      revokeOwnerToken(db, ownerId)
      return { ok: true, ownerId }
    }),
  )
}

export default ownerRoutes
