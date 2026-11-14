// 镇民鱼（resident）HTTP 接口。协议见 docs/RESIDENT-API.md，前缀 /town/api/resident。
// 设计：鉴权 + 统一回执/错误映射 都收在一个 handler 包装里，业务直接调 domain / engine。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Fish, TurnKind } from '@fishbowl/shared'
import type { DB } from '../db/index.ts'
import { getFish } from '../db/index.ts'
import type { TurnEngine } from '../engine/turns.ts'
import { authenticate } from './auth.ts'
import { DomainError } from '../domain/errors.ts'
import { listJobOffers, listFishContracts, quitJob, takeJob } from '../domain/jobs.ts'
import { addCatch, getMarket, listCatch, sellCatch } from '../domain/fishing.ts'
import { DAY_MS, spend, spentToday, startOfLocalDay } from '../domain/account.ts'
import { maybeCreateGameTurn, submitGameAction, type GameTurnDriver } from '../games/game-turn.ts'

export interface FishingLimits {
  /** 两次钓鱼最小间隔（ms），默认 60s */
  cooldownMs?: number
  /** 每日本地自然日鱼获上限，默认 10 */
  dailyLimit?: number
  /** 每次钓鱼的鱼饵成本（鱼币），默认 0（免费） */
  baitCost?: number
}

export interface ResidentDeps {
  db: DB
  engine: TurnEngine
  fishing?: FishingLimits
  /** 对局驱动（P2 接线后注入；缺省时 game 回合/play 相关路由由 resident-p2 提供） */
  driver?: GameTurnDriver
}

const STATUS: Record<string, number> = {
  RESIDENT_CODE: 401,
  UNAUTHORIZED: 401,
  PAUSED: 409,
  BANNED: 403,
  FIELD_FORBIDDEN: 403,
  FISH_COOLDOWN: 409,
  FISH_LIMIT: 409,
  TURN_CLOSED: 409,
  NOT_CONNECTED: 409,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  RATE_LIMITED: 429,
  INSUFFICIENT: 409,
  DAY_CAP: 409,
  CONFLICT: 409,
  ALREADY_WORKING: 409,
  NO_SLOTS: 409,
  CONTRACT_CLOSED: 409,
  UNAVAILABLE: 503,
  RESTARTING: 503,
}

type Ctx = { fish: Fish; req: FastifyRequest; reply: FastifyReply }
type Handler = (ctx: Ctx) => Promise<unknown> | unknown

function fail(reply: FastifyReply, code: string, reason: string, status?: number) {
  return reply.code(status ?? STATUS[code] ?? 400).send({ ok: false, error: code, code, reason })
}

function sendError(reply: FastifyReply, e: unknown) {
  const err = e as { code?: string; message?: string; balance?: number; detail?: unknown }
  if (err && typeof err.code === 'string') {
    const code = err.code
    const status = STATUS[code] ?? 400
    const payload: Record<string, unknown> = { ok: false, error: code, code, reason: err.message ?? code }
    if (err.detail !== undefined) payload.detail = err.detail
    if (err.balance !== undefined) payload.balance = err.balance
    return reply.code(status).send(payload)
  }
  return reply.code(500).send({ ok: false, error: 'UNAVAILABLE', code: 'UNAVAILABLE', reason: String(err?.message ?? e) })
}

function receipt(extra: Record<string, unknown> = {}) {
  return { ok: true, code: 'OK', reason: '', where: '', balance: null as number | null, delta: 0, ...extra }
}

function num(v: unknown, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

function parseKinds(v: unknown): TurnKind[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  const valid = new Set<TurnKind>(['game', 'visit', 'agency', 'activity', 'job'])
  const out = v.split(',').map((s) => s.trim()).filter((s) => valid.has(s as TurnKind)) as TurnKind[]
  return out.length ? out : undefined
}

function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value)
}

function getMeta(db: DB, key: string): string | null {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined
  return r ? r.v : null
}

function delMeta(db: DB, key: string): void {
  db.prepare('DELETE FROM meta WHERE k = ?').run(key)
}

function buildStatus(db: DB, fish: Fish) {
  const fresh = getFish(db, fish.id)!
  const dayStart = startOfLocalDay()
  const earnedRow = db
    .prepare(`SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE fish_id = ? AND delta > 0 AND reason <> 'init' AND ts >= ?`)
    .get(fresh.id, dayStart) as { s: number }
  const earnedToday = Number(earnedRow.s)
  const spent = spentToday(db, fresh.id)
  return {
    ok: true,
    fish_id: fresh.id,
    name: fresh.name,
    town_name: fresh.name,
    state: fresh.status,
    outside_state: fresh.status,
    balance: fresh.balance, // 鱼币（整数）
    piggy_yuan: fresh.balance, // 兼容插件展示（自建经济=鱼币，非真实货币）
    day_cap: fresh.dayCap,
    earned_today: earnedToday,
    today_earned: earnedToday,
    income_today: earnedToday,
    spent_today: spent,
    today_spent: spent,
    paused: fresh.status === 'paused',
    connected: true,
    now: Date.now(),
  }
}

function buildLobby(db: DB, fish: Fish, engine: TurnEngine) {
  const others = db
    .prepare(`SELECT id, name FROM fish WHERE id <> ? AND status = 'active' ORDER BY created_at ASC`)
    .all(fish.id) as unknown as { id: string; name: string }[]
  return {
    ok: true,
    mine: { at_table: null, visiting: null, signups: [], place: engine.getLocation(fish.id) },
    tables: [],
    games: [
      { game: 'ddz', game_zh: '斗地主', seats_min: 3, seats_max: 3, fee_yuan_from: 0 },
      { game: 'mj', game_zh: '麻将', seats_min: 4, seats_max: 4, fee_yuan_from: 0 },
      { game: 'werewolf', game_zh: '狼人杀', seats_min: 6, seats_max: 12, fee_yuan_from: 0 },
    ],
    activities: [],
    places: [
      { place: 'pier', name_zh: '码头', how: '钓鱼（do=fish）、游泳、赛跑、打水仗' },
      { place: 'arcade', name_zh: '电玩城', how: '玩机器（do=machine）' },
    ],
    fish: others.map((o) => ({ fish_id: o.id, name: o.name, resident: true })),
  }
}

const REASON_ZH: Record<string, string> = {
  init: '启动资金',
  job: '打工工资',
  fish_sell: '卖鱼获',
  seat_fee: '座位费',
  buy: '买货',
  shop_sale: '店铺收入',
  bounty: '悬赏奖励',
  game_win: '游戏赢钱',
  gift: '送礼',
  social: '社交消费',
  refund: '退款',
  admin: '镇长调整',
}

function reasonZh(r: string): string {
  return REASON_ZH[r] ?? r
}

interface LedgerRowLite {
  delta: number
  balance_after: number
  reason: string
  ref: string | null
  ts: number
}

function buildReceipts(db: DB, fish: Fish, limit = 20) {
  const rows = db
    .prepare('SELECT delta, balance_after, reason, ref, ts FROM ledger WHERE fish_id = ? ORDER BY id DESC LIMIT ?')
    .all(fish.id, Math.max(1, Math.min(limit, 100))) as unknown as LedgerRowLite[]
  const receipts = rows.map((r) => ({
    ok: true,
    code: 'OK',
    action: r.reason,
    reason: reasonZh(r.reason),
    delta: Number(r.delta),
    balance_yuan: Number(r.balance_after),
    piggy_yuan: Number(r.balance_after),
    ts: Number(r.ts),
  }))
  return { ok: true, receipts }
}

function buildSpending(db: DB, fish: Fish) {
  const now = Date.now()
  const dayStart = startOfLocalDay(now)
  const sumSince = (since: number) =>
    Number(
      (db.prepare('SELECT COALESCE(SUM(-delta), 0) AS s FROM ledger WHERE fish_id = ? AND delta < 0 AND ts >= ?').get(fish.id, since) as { s: number }).s,
    )
  const total = Number(
    (db.prepare('SELECT COALESCE(SUM(-delta), 0) AS s FROM ledger WHERE fish_id = ? AND delta < 0').get(fish.id) as { s: number }).s,
  )
  const by = db
    .prepare('SELECT reason, SUM(-delta) AS yuan, COUNT(*) AS n FROM ledger WHERE fish_id = ? AND delta < 0 GROUP BY reason ORDER BY yuan DESC')
    .all(fish.id) as unknown as { reason: string; yuan: number; n: number }[]
  return {
    ok: true,
    currency: '鱼币',
    today: sumSince(dayStart),
    d7: sumSince(now - 7 * DAY_MS),
    d30: sumSince(now - 30 * DAY_MS),
    total,
    by_kind: by.map((x) => ({ kind: x.reason, name: reasonZh(x.reason), yuan: Number(x.yuan), n: Number(x.n) })),
  }
}

function buildRecord(db: DB, fish: Fish) {
  const catches = listCatch(db, fish.id)
  const catchTotal = catches.reduce((s, h) => s + h.qty, 0)
  const doneJobs = Number((db.prepare(`SELECT COUNT(*) AS c FROM job_contract WHERE fish_id = ? AND state = 'done'`).get(fish.id) as { c: number }).c)
  const soldCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM ledger WHERE fish_id = ? AND reason = 'fish_sell'`).get(fish.id) as { c: number }).c)
  const recent = buildReceipts(db, fish, 5).receipts
  const line = `打工结算 ${doneJobs} 次 · 卖鱼获 ${soldCount} 笔 · 现有鱼获 ${catchTotal} 条`
  return {
    ok: true,
    name: fish.name,
    line,
    recent: [] as unknown[],
    places: {
      arcade: { plays: 0, best: {}, plush: 0 },
      pier: { casts: soldCount + catchTotal, catches: catchTotal, swims: 0 },
    },
    social: { friends: 0, visits_made: 0, visits_received: 0 },
    recent_receipts: recent,
  }
}

function buildBonds(_db: DB, _fish: Fish) {
  return {
    ok: true,
    friends: [] as unknown[],
    ties: [] as unknown[],
    guidance: '关系系统还没开放；多去大厅、码头、店里认识别的鱼吧。',
  }
}

function makeHandler(db: DB, fn: Handler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const fish = authenticate(db, req.headers.authorization)
    if (!fish) return fail(reply, 'RESIDENT_CODE', 'missing or invalid resident code', 401)
    // 写操作前校验：paused/banned 的鱼不能做任何写操作（回 paused/banned 回执）
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
    if (isWrite && fish.status !== 'active') {
      const code = fish.status === 'paused' ? 'PAUSED' : 'BANNED'
      return fail(reply, code, fish.status === 'paused' ? 'fish is paused' : 'fish is banned')
    }
    try {
      return await fn({ fish, req, reply })
    } catch (e) {
      return sendError(reply, e)
    }
  }
}

export const residentRoutes: FastifyPluginAsync<ResidentDeps> = async (app: FastifyInstance, opts) => {
  const { db, engine } = opts
  // F1：钓鱼防刷策略（冷却 / 每日上限 / 可选鱼饵成本），可由 buildServer 覆盖（测试用）
  const fishCfg = {
    cooldownMs: opts.fishing?.cooldownMs ?? 60_000,
    dailyLimit: opts.fishing?.dailyLimit ?? 10,
    baitCost: opts.fishing?.baitCost ?? 0,
  }
  const h = (fn: Handler) => makeHandler(db, fn) as unknown as Parameters<FastifyInstance['get']>[1]

  // ================= 回合 =================

  // 长轮询：优先投递「该鱼正坐在牌桌上且轮到它出手」的 game 回合；否则走原有回合引擎。
  app.get(
    '/turns',
    h(async ({ fish, req }) => {
      const q = req.query as Record<string, string | undefined>
      if (opts.driver) {
        const gameTurn = maybeCreateGameTurn(db, engine, opts.driver, fish.id)
        if (gameTurn) {
          return { turns: [{ turn_id: gameTurn.turn_id, kind: gameTurn.kind, deadline: gameTurn.deadline, packet: gameTurn.packet }] }
        }
      }
      const turns = await engine.poll(fish.id, { waitSec: num(q.wait, 25), kinds: parseKinds(q.kinds) })
      return { turns: turns.map((t) => ({ turn_id: t.turn_id, kind: t.kind, deadline: t.deadline, packet: t.packet })) }
    }),
  )

  // 交答案：{answer}（JSON 文本或对象）。重复交/超时 → 409 TURN_CLOSED。
  app.post(
    '/turns/:id',
    h(async ({ fish, req }) => {
      const { id } = req.params as { id: string }
      const body = (req.body ?? {}) as Record<string, unknown>
      if (body.answer === undefined) throw new DomainError('BAD_REQUEST', 'answer is required')

      // kind=game 的回合：解析 action → driver.submitAction 推进对局 → 广播事件（终局结算由 driver 完成）
      const turn = engine.getTurn(id)
      if (turn?.kind === 'game' && opts.driver) {
        let answerObj: unknown = null
        try {
          answerObj = typeof body.answer === 'string' ? JSON.parse(body.answer) : body.answer
        } catch {
          answerObj = null
        }
        const res = submitGameAction(db, engine, opts.driver, fish.id, answerObj)
        if (!res.ok) throw new DomainError('BAD_REQUEST', res.error ?? '非法动作')
        const out = engine.answer(fish.id, id, body.answer)
        return {
          ok: true,
          receipt: out.receipt,
          turn_id: out.turn.turn_id,
          kind: out.turn.kind,
          done: res.done,
          settlement: res.settlement,
          table: res.table,
        }
      }

      const out = engine.answer(fish.id, id, body.answer)
      return { ok: true, receipt: out.receipt, turn_id: out.turn.turn_id, kind: out.turn.kind }
    }),
  )

  // ================= 事件 / 状态 =================

  app.get(
    '/events',
    h(async ({ fish, req }) => {
      const q = req.query as Record<string, string | undefined>
      const page = engine.listEvents(fish.id, num(q.after, 0), num(q.limit, 50))
      return { ok: true, items: page.items, next: page.next }
    }),
  )

  app.get('/status', h(async ({ fish }) => buildStatus(db, fish)))

  app.post(
    '/settings',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      // F3：resident 只能改白名单里的非敏感设置；paused / day_cap 等只允许 owner(admin) 改
      const ALLOWED = new Set(['wake_min_minutes', 'quiet_hours', 'social_day_cents'])
      const forbidden = Object.keys(body).filter((k) => !ALLOWED.has(k))
      if (forbidden.length) {
        throw new DomainError('FIELD_FORBIDDEN', `这些字段仅主人可改：${forbidden.join(', ')}`)
      }

      if (body.wake_min_minutes !== undefined) {
        const n = Number(body.wake_min_minutes)
        if (!Number.isInteger(n) || n < 0) throw new DomainError('BAD_REQUEST', 'wake_min_minutes 必须是非负整数')
        setMeta(db, 'wake_min:' + fish.id, String(n))
      }
      if (body.quiet_hours !== undefined) setMeta(db, 'quiet:' + fish.id, JSON.stringify(body.quiet_hours))
      // F2：社交预算（插件传 social_day_cents，单位分）。独立持久化，不映射到 owner 管的 day_cap。
      if (body.social_day_cents !== undefined) {
        if (body.social_day_cents === null) {
          delMeta(db, 'social_day:' + fish.id)
        } else {
          const cents = Number(body.social_day_cents)
          if (!Number.isInteger(cents) || cents < 0) throw new DomainError('BAD_REQUEST', 'social_day_cents 必须是非负整数或 null')
          setMeta(db, 'social_day:' + fish.id, String(cents))
        }
      }

      const fresh = getFish(db, fish.id)!
      const wakeRaw = getMeta(db, 'wake_min:' + fish.id)
      const quietRaw = getMeta(db, 'quiet:' + fish.id)
      const socialRaw = getMeta(db, 'social_day:' + fish.id)
      const socialCents = socialRaw === null ? null : Number(socialRaw)
      const settings = {
        wake_min_minutes: wakeRaw === null ? null : Number(wakeRaw),
        quiet_hours: quietRaw === null ? null : JSON.parse(quietRaw),
        social_day_cents: socialCents,
        social_day_cents_effective: socialCents, // 自建版无平台默认，生效值=设定值
      }
      // F2：响应带回 settings 对象，插件 rememberSettings 才能读到（否则社交预算被静默丢弃）
      return { ok: true, settings, paused: fresh.status === 'paused', day_cap: fresh.dayCap, balance: fresh.balance }
    }),
  )

  // ================= 自助 =================

  // 请小镇给一个 agency 回合（忽略冷却，强制生成）。
  app.post(
    '/agency',
    h(async ({ fish }) => {
      const turn = engine.createAgency(fish.id)
      return { ok: true, turn_id: turn.turn_id, turn }
    }),
  )

  app.get('/lobby', h(async ({ fish }) => buildLobby(db, fish, engine)))

  // 去个地方（码头 / 电玩城）。码头可 do=fish 钓鱼（带冷却 / 每日上限 / 可选鱼饵成本，防无限铸币）。
  app.post(
    '/goto',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const place = String(body.place ?? '')
      if (place !== 'pier' && place !== 'arcade') throw new DomainError('BAD_REQUEST', 'place must be pier or arcade')
      engine.setLocation(fish.id, place)
      const now = Date.now()
      let outcome: unknown = null
      const action = typeof body.do === 'string' ? body.do : ''
      if (place === 'pier' && (action === 'fish' || action === '钓鱼')) {
        // F1-a：冷却——同一鱼两次钓鱼之间至少 cooldownMs
        const last = Number(getMeta(db, 'fish:' + fish.id + ':lastFishAt') ?? 0)
        if (fishCfg.cooldownMs > 0 && last > 0 && now - last < fishCfg.cooldownMs) {
          const wait = Math.ceil((fishCfg.cooldownMs - (now - last)) / 1000)
          return { ok: false, code: 'FISH_COOLDOWN', error: 'FISH_COOLDOWN', reason: `钓鱼太频繁，${wait} 秒后再来`, where: 'pier', balance: getFish(db, fish.id)!.balance }
        }
        // F1-b：每日（本地自然日）鱼获上限
        const dayKey = String(startOfLocalDay(now))
        const storedDay = getMeta(db, 'fish:' + fish.id + ':fishDay')
        const count = storedDay === dayKey ? Number(getMeta(db, 'fish:' + fish.id + ':fishCount') ?? 0) : 0
        if (count >= fishCfg.dailyLimit) {
          return { ok: false, code: 'FISH_LIMIT', error: 'FISH_LIMIT', reason: `今天钓够 ${fishCfg.dailyLimit} 条了，明天再来`, where: 'pier', balance: getFish(db, fish.id)!.balance }
        }
        // F1-c：可选鱼饵成本（默认 0=免费）
        if (fishCfg.baitCost > 0) {
          try {
            spend(db, fish.id, fishCfg.baitCost, 'buy', 'bait')
          } catch (e) {
            const err = e as { code?: string; message?: string }
            return { ok: false, code: err?.code ?? 'INSUFFICIENT', error: err?.code ?? 'INSUFFICIENT', reason: err?.message, where: 'pier', balance: getFish(db, fish.id)!.balance }
          }
        }
        const c = addCatch(db, fish.id, '小鱼', 1)
        setMeta(db, 'fish:' + fish.id + ':lastFishAt', String(now))
        setMeta(db, 'fish:' + fish.id + ':fishDay', dayKey)
        setMeta(db, 'fish:' + fish.id + ':fishCount', String(count + 1))
        outcome = { item: '小鱼', qty: 1, catch_id: c.id, producedToday: count + 1, dailyLimit: fishCfg.dailyLimit }
      }
      const turn = engine.createActivity(fish.id, place, typeof body.situation === 'string' ? body.situation : undefined)
      const fresh = getFish(db, fish.id)!
      return {
        ok: true,
        place,
        outcome,
        note: `到了${place === 'pier' ? '码头' : '电玩城'}`,
        turn_id: turn.turn_id,
        receipt: receipt({ where: place, balance: fresh.balance }),
      }
    }),
  )

  // ================= 赚钱：打工 / 钓鱼卖钱 =================

  app.get(
    '/jobs',
    h(async ({ fish }) => ({
      ok: true,
      jobs: listJobOffers(db).map((o) => ({
        id: o.id,
        title: o.title,
        place: o.place,
        pay: o.pay,
        duration: o.durationMin,
        duration_min: o.durationMin,
        slots: o.slots,
        taken: o.taken,
        available: o.available,
        requirements: o.requirements,
      })),
      mine: listFishContracts(db, fish.id),
    })),
  )

  app.post(
    '/jobs/take',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const offerId = body.offer_id ?? body.offerId
      if (!offerId) throw new DomainError('BAD_REQUEST', 'offer_id is required')
      const contract = takeJob(db, fish.id, String(offerId))
      const fresh = getFish(db, fish.id)!
      return { ok: true, receipt: receipt({ where: 'job', balance: fresh.balance, contract_id: contract.id }), contract }
    }),
  )

  app.post(
    '/jobs/quit',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const contractId = body.contract_id ?? body.contractId
      if (!contractId) throw new DomainError('BAD_REQUEST', 'contract_id is required')
      const contract = quitJob(db, fish.id, String(contractId))
      const fresh = getFish(db, fish.id)!
      return { ok: true, receipt: receipt({ where: 'job', balance: fresh.balance }), contract }
    }),
  )

  app.get(
    '/market',
    h(async ({ fish }) => ({ ok: true, items: getMarket(db, fish.id), catch: listCatch(db, fish.id) })),
  )

  app.post(
    '/sell',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const catchId = body.catch_id ?? body.catchId
      const item = typeof body.item === 'string' ? body.item : undefined
      const qty = body.qty === undefined ? undefined : Number(body.qty)
      const sale = sellCatch(db, fish.id, { catchId: catchId ? String(catchId) : undefined, item, qty })
      return {
        ok: true,
        receipt: receipt({ where: 'market', delta: sale.amount, balance: sale.balance }),
        sale,
      }
    }),
  )

  // ================= 插件对齐：战绩 / 回执 / 花钱 / 名片 / 关系 =================

  app.get('/record', h(async ({ fish }) => buildRecord(db, fish)))

  app.get(
    '/receipts',
    h(async ({ fish, req }) => {
      const q = req.query as Record<string, string | undefined>
      return buildReceipts(db, fish, num(q.limit, 20))
    }),
  )

  app.get('/spending', h(async ({ fish }) => buildSpending(db, fish)))

  app.get('/bonds', h(async ({ fish }) => buildBonds(db, fish)))

  // 改名 / 自我介绍：过长截断（name ≤ 20 字、intro ≤ 200 字）
  app.post(
    '/card',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const cur = getFish(db, fish.id)!
      let name = cur.name
      let intro = cur.intro
      if (body.name !== undefined) {
        const n = String(body.name).trim()
        if (!n) throw new DomainError('BAD_REQUEST', 'name cannot be empty')
        name = [...n].slice(0, 20).join('')
      }
      if (body.intro !== undefined) intro = [...String(body.intro).trim()].slice(0, 200).join('')
      db.prepare('UPDATE fish SET name = ?, intro = ? WHERE id = ?').run(name, intro, fish.id)
      return { ok: true, refused: false, name, intro }
    }),
  )

  // 串门 / 开桌：P2 已由 resident-p2.ts 提供真实实现（同前缀注册，故此处不再占位）。
  // 取消报名：P1 没有报名，直接成功（空操作）
  app.post('/signup_cancel', h(async () => ({ ok: true, note: '没有在等的桌', cancelled: 0 })))

  // ===== 未开放（插件 extras 会探测；404 + NOT_OPEN，插件按 isGone 当「没有」，不崩） =====
  const notOpen = (reply: FastifyReply, reason: string) =>
    reply.code(404).send({ ok: false, code: 'NOT_OPEN', error: 'NOT_OPEN', reason })

  // 已接线（resident-p3 / resident-p35 提供真实实现）：social/phone/relations/court、album/photo/song/paint/bless、rps/dice/lottery
  app.get('/week', h(async ({ reply }) => notOpen(reply, '她的一周还没开放')))
  app.get('/room', h(async ({ reply }) => notOpen(reply, '房间礼物还没开放')))
  app.post('/social', h(async ({ reply }) => notOpen(reply, '社交消费还没开放')))
  app.post('/consent', h(async ({ reply }) => notOpen(reply, '心上的事还没开放')))
  app.post('/paint_social', h(async ({ reply }) => notOpen(reply, '画铺还没开放')))
  app.post('/look', h(async ({ reply }) => notOpen(reply, '长相设置还没开放')))
  app.post('/paint_file', h(async ({ reply }) => notOpen(reply, '画铺还没开放')))
}

export default residentRoutes
