// 公开只读 API（免鉴权，供 web 面板）：小镇概况 / 鱼列表 / 单鱼名片+流水。
// 结构对齐 packages/web/src/types.ts（TownPayload / FishSummary / FishDetail），
// 同时保留旧字段（name/fishCount/recent.fish/fish 数组/summary）做向后兼容（超集）。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { getFish } from '../db/index.ts'
import { DomainError } from '../domain/errors.ts'
import { startOfLocalDay } from '../domain/account.ts'
import { sendError } from './common.ts'

export interface PublicDeps {
  db: DB
  townName?: string
}

/** 「在线」判定窗口：最近 2 分钟内有轮询/操作（以最近一条 ledger 或 event 时间为准）。 */
const ONLINE_MS = 2 * 60 * 1000
const CURRENCY = '鱼币'

interface LedgerRow {
  id: number
  delta: number
  balance_after: number
  reason: string
  ref: string | null
  ts: number
}

function lastSeenByFish(db: DB): Map<string, number> {
  const m = new Map<string, number>()
  const led = db.prepare('SELECT fish_id, MAX(ts) AS m FROM ledger GROUP BY fish_id').all() as unknown as { fish_id: string; m: number }[]
  for (const r of led) m.set(r.fish_id, Number(r.m))
  // event.ts 存的是「秒」，统一折算成毫秒比较
  const ev = db.prepare('SELECT fish_id, MAX(ts) AS m FROM event GROUP BY fish_id').all() as unknown as { fish_id: string; m: number }[]
  for (const r of ev) {
    const v = Number(r.m) * 1000
    if (!Number.isFinite(v) || v <= 0) continue
    if (v > (m.get(r.fish_id) ?? 0)) m.set(r.fish_id, v)
  }
  return m
}

function isOnline(status: string, lastSeen: number | undefined, now: number): boolean {
  if (status !== 'active') return false
  if (lastSeen == null) return false
  return now - lastSeen <= ONLINE_MS
}

function ownerNameOf(db: DB, ownerId: string | null): string | null {
  if (!ownerId) return null
  const r = db.prepare('SELECT name FROM owner WHERE id = ?').get(ownerId) as { name: string } | undefined
  return r?.name ?? null
}

export const publicRoutes: FastifyPluginAsync<PublicDeps> = async (app: FastifyInstance, opts) => {
  const { db, townName = '鱼缸小镇' } = opts

  const pub = (fn: (req: FastifyRequest, reply: FastifyReply) => unknown) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply)
      } catch (e) {
        return sendError(reply, e)
      }
    }
  }

  const count = (where = '', ...args: unknown[]): number => {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM fish${where ? ' WHERE ' + where : ''}`).get(...(args as never[])) as { c: number }
    return Number(r.c)
  }

  // 小镇概况：新增 town{...} 契约对象；同时保留旧字段（name/fishCount/recent.fish...）。
  app.get(
    '/town',
    pub((req) => {
      const now = Date.now()
      const dayStart = startOfLocalDay(now)
      const limitRaw = Number((req.query as Record<string, string | undefined>)?.limit)
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10

      const fishCount = count()
      const residentCount = count("kind = 'resident'")
      const npcCount = count("kind = 'npc'")
      const balanceRow = db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM fish').get() as { s: number }

      // 今日赚 / 花（排除 init 启动资金，避免把开户钱算成“赚”）
      const earnedRow = db
        .prepare(`SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE delta > 0 AND reason <> 'init' AND ts >= ?`)
        .get(dayStart) as { s: number }
      const spentRow = db
        .prepare(`SELECT COALESCE(SUM(-delta), 0) AS s FROM ledger WHERE delta < 0 AND ts >= ?`)
        .get(dayStart) as { s: number }
      const earned = Number(earnedRow.s)
      const spent = Number(spentRow.s)

      // 在线鱼：active 且最近 2 分钟有活动信号
      const seen = lastSeenByFish(db)
      const statusRows = db.prepare('SELECT id, status FROM fish').all() as unknown as { id: string; status: string }[]
      const onlineFish = statusRows.filter((f) => isOnline(f.status, seen.get(f.id), now)).length

      const recentRows = db
        .prepare(
          `SELECT l.id AS id, l.delta AS delta, l.reason AS reason, l.ref AS ref, l.ts AS ts,
                  f.id AS fish_id, f.name AS name
           FROM ledger l JOIN fish f ON f.id = l.fish_id
           ORDER BY l.id DESC LIMIT ?`,
        )
        .all(limit) as unknown as { id: number; delta: number; reason: string; ref: string | null; ts: number; fish_id: string; name: string }[]

      const recent = recentRows.map((r) => ({
        id: String(r.id),
        ts: Number(r.ts),
        fishId: r.fish_id,
        fishName: r.name,
        reason: r.reason,
        delta: Number(r.delta),
        ref: r.ref ?? null,
        // 旧字段（兼容旧的 recent.fish 读取方）
        fish: { id: r.fish_id, name: r.name },
      }))

      return {
        ok: true,
        // === 新契约 ===
        town: {
          name: townName,
          onlineFish,
          totalFish: fishCount,
          today: { earned, spent, net: earned - spent },
          currency: CURRENCY,
          updatedAt: now,
        },
        recent,
        // === 旧字段（向后兼容） ===
        name: townName,
        fishCount,
        residentCount,
        npcCount,
        balanceTotal: Number(balanceRow.s),
        today: { earned, spent, net: earned - spent },
        currency: CURRENCY,
        generatedAt: now,
      }
    }),
  )

  // 鱼列表：新契约 items[]；旧字段 fish[] 保留。
  app.get(
    '/fish',
    pub(() => {
      const now = Date.now()
      const seen = lastSeenByFish(db)
      const rows = db
        .prepare('SELECT id, name, kind, avatar, intro, balance, status, created_at FROM fish ORDER BY created_at ASC')
        .all() as unknown as {
        id: string
        name: string
        kind: string
        avatar: string
        intro: string
        balance: number
        status: string
        created_at: number
      }[]
      const items = rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        avatar: r.avatar,
        intro: r.intro,
        balance: Number(r.balance),
        status: r.status,
        online: isOnline(r.status, seen.get(r.id), now),
        // 旧列表字段
        createdAt: Number(r.created_at),
      }))
      return {
        ok: true,
        items,
        // 旧字段（兼容旧的 fish[] 读取方）
        count: items.length,
        fish: items,
      }
    }),
  )

  // 单鱼名片 + 最近流水（带 id）+ 四值 stats；旧 summary 保留。
  app.get(
    '/fish/:id',
    pub((req) => {
      const { id } = req.params as { id: string }
      const fish = getFish(db, id)
      if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${id}`)
      const now = Date.now()
      const dayStart = startOfLocalDay(now)
      const seen = lastSeenByFish(db)

      const ledger = db
        .prepare('SELECT id, delta, balance_after, reason, ref, ts FROM ledger WHERE fish_id = ? ORDER BY id DESC LIMIT 20')
        .all(id) as unknown as LedgerRow[]

      const sum = (sql: string, ...args: unknown[]): number => {
        const r = db.prepare(sql).get(...(args as never[])) as { s: number }
        return Number(r.s)
      }
      const todayEarned = sum(`SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE fish_id = ? AND delta > 0 AND reason <> 'init' AND ts >= ?`, id, dayStart)
      const todaySpent = sum(`SELECT COALESCE(SUM(-delta),0) AS s FROM ledger WHERE fish_id = ? AND delta < 0 AND ts >= ?`, id, dayStart)
      const totalEarned = sum(`SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE fish_id = ? AND delta > 0 AND reason <> 'init'`, id)
      const totalSpent = sum(`SELECT COALESCE(SUM(-delta),0) AS s FROM ledger WHERE fish_id = ? AND delta < 0`, id)
      const entries = sum(`SELECT COUNT(*) AS s FROM ledger WHERE fish_id = ?`, id)

      const summary = db
        .prepare('SELECT reason, SUM(delta) AS total, COUNT(*) AS n FROM ledger WHERE fish_id = ? GROUP BY reason ORDER BY reason')
        .all(id) as unknown as { reason: string; total: number; n: number }[]

      return {
        ok: true,
        fish: {
          id: fish.id,
          name: fish.name,
          kind: fish.kind,
          persona: fish.persona,
          intro: fish.intro,
          lookNote: fish.lookNote,
          avatar: fish.avatar,
          balance: fish.balance,
          status: fish.status,
          dayCap: fish.dayCap,
          createdAt: fish.createdAt,
          ownerName: ownerNameOf(db, fish.ownerId),
          online: isOnline(fish.status, seen.get(fish.id), now),
        },
        ledger: ledger.map((l) => ({
          id: Number(l.id),
          fishId: fish.id,
          delta: Number(l.delta),
          balanceAfter: Number(l.balance_after),
          reason: l.reason,
          ref: l.ref,
          ts: Number(l.ts),
        })),
        stats: { todayEarned, todaySpent, totalEarned, totalSpent, entries },
        // 旧字段（兼容旧的 summary 读取方）
        summary: summary.map((s) => ({ reason: s.reason, total: Number(s.total), n: Number(s.n) })),
      }
    }),
  )
}

export default publicRoutes
