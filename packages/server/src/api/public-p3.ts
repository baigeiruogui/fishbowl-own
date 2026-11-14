// P3 公开只读：法庭案件列表 / 人际关系（公开好友对）/ 小手机（涉隐私，仅给占位说明）。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { sendError } from './common.ts'

export interface PublicP3Deps {
  db: DB
  now?: () => number
}

interface CaseRowLite {
  id: string
  kind: string | null
  state: string
  data_json: string
  ts: number
}

function caseList(db: DB): Record<string, unknown>[] {
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

export const publicP3Routes: FastifyPluginAsync<PublicP3Deps> = async (app: FastifyInstance, opts) => {
  const { db } = opts
  const clock = opts.now ?? (() => Date.now())

  const pub = (fn: (req: FastifyRequest, reply: FastifyReply) => unknown) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply)
      } catch (e) {
        return sendError(reply, e)
      }
    }
  }

  // 法庭：案件列表（公开）
  app.get(
    '/court',
    pub(() => ({ ok: true, cases: caseList(db), updatedAt: clock() })),
  )

  // 关系：公开好友对（只暴露名字/id/since，不含私信）
  app.get(
    '/relations',
    pub(() => {
      const rows = db
        .prepare(`SELECT a, b, since FROM relationship WHERE kind = 'friend' ORDER BY since ASC, id ASC`)
        .all() as unknown as { a: string; b: string; since: number }[]
      const nameOf = (id: string): string => (db.prepare('SELECT name FROM fish WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id
      const relations = rows.map((r) => ({
        a: { id: r.a, name: nameOf(r.a) },
        b: { id: r.b, name: nameOf(r.b) },
        since: Number(r.since),
      }))
      return { ok: true, relations, updatedAt: clock() }
    }),
  )

  // 小手机：涉隐私，只给占位说明（真实私信仅当事人经 resident API 可见）
  app.get(
    '/phone',
    pub(() => ({ ok: true, messages: [], public: false, note: '小手机的私信仅当事人可见', updatedAt: clock() })),
  )
}

export default publicP3Routes
