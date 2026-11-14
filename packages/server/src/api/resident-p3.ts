// P3 resident 接线：社交送礼 / 小手机 / 关系 / 法庭。与 resident.ts 同前缀注册，独立封装鉴权与 paused 写保护。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { getFish } from '../db/index.ts'
import type { TurnEngine } from '../engine/turns.ts'
import { authenticate } from './auth.ts'
import { DomainError } from '../domain/errors.ts'
import { sendError } from './common.ts'
import { dailySocialUsed, gift, socialBudget } from '../domain/social.ts'
import { listMessages, sendMessage } from '../domain/phone.ts'
import { listRelations, makeFriends } from '../domain/relationship.ts'
import { castVote, fileCase, getCase, renderVerdict, submitEvidence } from '../domain/court.ts'

export interface ResidentP3Deps {
  db: DB
  engine: TurnEngine
}

type Ctx = { fish: NonNullable<ReturnType<typeof getFish>>; req: FastifyRequest; reply: FastifyReply }
type Handler = (ctx: Ctx) => Promise<unknown> | unknown

function makeHandler(db: DB, fn: Handler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const fish = authenticate(db, req.headers.authorization)
    if (!fish) return reply.code(401).send({ ok: false, error: 'RESIDENT_CODE', code: 'RESIDENT_CODE', reason: 'missing or invalid resident code' })
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
    if (isWrite && fish.status !== 'active') {
      const code = fish.status === 'paused' ? 'PAUSED' : 'BANNED'
      return reply.code(code === 'PAUSED' ? 409 : 403).send({ ok: false, error: code, code, reason: fish.status === 'paused' ? 'fish is paused' : 'fish is banned' })
    }
    try {
      return await fn({ fish, req, reply })
    } catch (e) {
      return sendError(reply, e)
    }
  }
}

function resolveFish(db: DB, ref: unknown): NonNullable<ReturnType<typeof getFish>> | null {
  const s = String(ref ?? '').trim()
  if (!s) return null
  const byId = getFish(db, s)
  if (byId) return byId
  const row = db.prepare('SELECT id FROM fish WHERE name = ? LIMIT 1').get(s) as { id: string } | undefined
  return row ? getFish(db, row.id) : null
}

interface CaseRowLite {
  id: string
  kind: string | null
  state: string
  data_json: string
  ts: number
}

function listCaseViews(db: DB): Record<string, unknown>[] {
  const rows = db.prepare('SELECT * FROM court_case ORDER BY ts DESC').all() as unknown as CaseRowLite[]
  return rows.map((r) => {
    let d: Record<string, unknown> = {}
    try {
      d = JSON.parse(r.data_json || '{}') as Record<string, unknown>
    } catch {
      /* ignore */
    }
    return {
      id: r.id,
      kind: r.kind ?? d.kind ?? 'civil',
      state: r.state,
      plaintiff: d.plaintiff ?? null,
      defendant: d.defendant ?? null,
      desc: d.desc ?? '',
      verdict: d.verdict ?? null,
      evidenceCount: Array.isArray(d.evidence) ? (d.evidence as unknown[]).length : 0,
      voteCount: Array.isArray(d.votes) ? (d.votes as unknown[]).length : 0,
      createdAt: d.createdAt ?? r.ts,
      updatedAt: d.updatedAt ?? r.ts,
    }
  })
}

export const residentP3Routes: FastifyPluginAsync<ResidentP3Deps> = async (app: FastifyInstance, opts) => {
  const { db, engine } = opts
  const h = (fn: Handler) => makeHandler(db, fn) as unknown as Parameters<FastifyInstance['get']>[1]

  // ---------- 社交：送礼 / 预算 ----------

  app.post(
    '/social/gift',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const to = resolveFish(db, body.to ?? body.fish)
      if (!to) throw new DomainError('NOT_FOUND', '收礼的鱼不存在')
      const res = gift(db, fish.id, to.id, {
        item: String(body.item ?? ''),
        price: Number(body.price),
        words: typeof body.words === 'string' ? body.words : undefined,
      })
      engine.addEvent(fish.id, 'gift', { to: to.id, item: res.item, price: res.price, ref: res.ref })
      engine.addEvent(to.id, 'gift', { from: fish.id, item: res.item, price: res.price, ref: res.ref, words: body.words ?? null })
      return { ok: true, receipt: { ok: true, code: 'OK', where: 'social', balance: res.balance, delta: -res.price }, gift: res }
    }),
  )

  app.get(
    '/social',
    h(async ({ fish }) => {
      const budget = socialBudget(db, fish.id)
      const used = dailySocialUsed(db, fish.id)
      return { ok: true, currency: '鱼币', budget, used, remaining: Math.max(0, budget - used) }
    }),
  )

  // ---------- 小手机 ----------

  app.post(
    '/phone',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const to = resolveFish(db, body.to)
      if (!to) throw new DomainError('NOT_FOUND', '对方不存在')
      const msg = sendMessage(db, fish.id, to.id, { text: String(body.text ?? '') })
      engine.addEvent(to.id, 'phone', { from: fish.id, text: msg.text, messageId: msg.id })
      engine.addEvent(fish.id, 'phone', { to: to.id, text: msg.text, messageId: msg.id })
      return { ok: true, message: msg }
    }),
  )

  app.get(
    '/phone',
    h(async ({ fish, req }) => {
      const q = req.query as Record<string, string | undefined>
      const limit = q.limit ? Math.max(1, Math.min(200, Number(q.limit))) : 20
      return { ok: true, messages: listMessages(db, fish.id, limit) }
    }),
  )

  // ---------- 关系 ----------

  app.get(
    '/relations',
    h(async ({ fish }) => {
      const relations = listRelations(db, fish.id).map((r) => {
        const f = getFish(db, r.fishId)
        return { fishId: r.fishId, name: f?.name ?? r.fishId, since: r.since, kind: r.kind }
      })
      return { ok: true, relations, friendCount: relations.length }
    }),
  )

  app.post(
    '/relations/friend',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const other = resolveFish(db, body.fish ?? body.fish_id ?? body.name)
      if (!other) throw new DomainError('NOT_FOUND', '对方的鱼不存在')
      const res = makeFriends(db, fish.id, other.id)
      if (res.created) {
        engine.addEvent(fish.id, 'friend_made', { with: other.id, name: other.name })
        engine.addEvent(other.id, 'friend_made', { with: fish.id, name: fish.name })
      }
      return { ok: true, friend: { a: res.a, b: res.b, created: res.created, since: res.since }, name: other.name }
    }),
  )

  // ---------- 法庭 ----------

  app.post(
    '/court/file',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const defendant = resolveFish(db, body.defendant)
      if (!defendant) throw new DomainError('NOT_FOUND', '被告的鱼不存在')
      const c = fileCase(db, {
        plaintiff: fish.id,
        defendant: defendant.id,
        kind: String(body.kind ?? 'civil'),
        desc: String(body.desc ?? ''),
        evidence: Array.isArray(body.evidence) ? (body.evidence as (string | { by?: string; text: string })[]) : undefined,
      })
      engine.addEvent(fish.id, 'court', { what: 'filed', caseId: c.id, defendant: defendant.id })
      engine.addEvent(defendant.id, 'court', { what: 'summoned', caseId: c.id, plaintiff: fish.id })
      return { ok: true, case: c }
    }),
  )

  app.post(
    '/court/evidence',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const caseId = String(body.case_id ?? '')
      if (!caseId) throw new DomainError('BAD_REQUEST', 'case_id is required')
      const c = submitEvidence(db, caseId, fish.id, String(body.text ?? ''))
      engine.addEvent(c.plaintiff, 'court', { what: 'evidence', caseId, by: fish.id })
      engine.addEvent(c.defendant, 'court', { what: 'evidence', caseId, by: fish.id })
      return { ok: true, case: c }
    }),
  )

  app.post(
    '/court/vote',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const caseId = String(body.case_id ?? '')
      if (!caseId) throw new DomainError('BAD_REQUEST', 'case_id is required')
      const c = castVote(db, caseId, fish.id, body.guilty === true)
      engine.addEvent(c.plaintiff, 'court', { what: 'vote', caseId, juror: fish.id })
      engine.addEvent(c.defendant, 'court', { what: 'vote', caseId, juror: fish.id })
      return { ok: true, case: c }
    }),
  )

  app.post(
    '/court/verdict',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const caseId = String(body.case_id ?? '')
      if (!caseId) throw new DomainError('BAD_REQUEST', 'case_id is required')
      const result = renderVerdict(db, caseId, { damages: body.damages === undefined ? 0 : Number(body.damages) })
      engine.addEvent(result.case.plaintiff, 'court', { what: 'verdict', caseId, verdict: result.case.verdict, paid: result.paid, amount: result.amount })
      engine.addEvent(result.case.defendant, 'court', { what: 'verdict', caseId, verdict: result.case.verdict, paid: result.paid, amount: result.amount })
      return { ok: true, result }
    }),
  )

  app.get(
    '/court',
    h(async () => ({ ok: true, cases: listCaseViews(db) })),
  )

  app.get(
    '/court/:id',
    h(async ({ req }) => {
      const { id } = req.params as { id: string }
      const c = getCase(db, id)
      if (!c) throw new DomainError('NOT_FOUND', `case not found: ${id}`)
      return { ok: true, case: c }
    }),
  )
}

export default residentP3Routes
