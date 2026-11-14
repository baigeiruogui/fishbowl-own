// P2 resident 接线：开桌/入座（play）、串门（visit）、桌列表、开店、悬赏。
// 与 resident.ts 同前缀注册（/town/api/resident），但独立封装鉴权与 paused/banned 写保护。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { getFish } from '../db/index.ts'
import type { TurnEngine } from '../engine/turns.ts'
import type { GameDriver } from '../games/driver.ts'
import { authenticate } from './auth.ts'
import { DomainError } from '../domain/errors.ts'
import { sendError } from './common.ts'
import { addItem, buyItem, createShop, listShop, setItemPrice, setStock } from '../domain/shop.ts'
import { claimBounty, createBounty, listBounties, takeBounty } from '../domain/bounty.ts'

export interface ResidentP2Deps {
  db: DB
  engine: TurnEngine
  driver: GameDriver
}

type Ctx = { fish: NonNullable<ReturnType<typeof getFish>>; req: FastifyRequest; reply: FastifyReply }
type Handler = (ctx: Ctx) => Promise<unknown> | unknown

function makeHandler(db: DB, fn: Handler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const fish = authenticate(db, req.headers.authorization)
    if (!fish) {
      return reply.code(401).send({ ok: false, error: 'RESIDENT_CODE', code: 'RESIDENT_CODE', reason: 'missing or invalid resident code' })
    }
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

function nonnegInt(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new DomainError('BAD_REQUEST', `${field} 必须是非负整数`)
  return n
}

export const residentP2Routes: FastifyPluginAsync<ResidentP2Deps> = async (app: FastifyInstance, opts) => {
  const { db, engine, driver } = opts
  const h = (fn: Handler) => makeHandler(db, fn) as unknown as Parameters<FastifyInstance['get']>[1]

  // ---------- 对局：开桌 / 入座 / 桌列表 ----------

  app.get(
    '/tables',
    h(async () => ({
      ok: true,
      tables: driver.listTables().map((t) => ({
        id: t.id,
        game: t.game,
        status: t.status,
        seatFee: t.seatFee,
        seats: t.seats,
        pot: t.pot,
        players: t.players,
      })),
    })),
  )

  // POST play {game?, venue_id?, seat_fee?}：有 venue_id 就入那桌；否则找该游戏还缺人的桌，没有就开一桌并入座。
  app.post(
    '/play',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const venueId = body.venue_id ? String(body.venue_id) : null
      // 支持斗地主 / 麻将 / 狼人杀 / 海龟汤
      const requested = String(body.game ?? 'ddz')
      const game: 'ddz' | 'mj' | 'werewolf' | 'turtlesoup' =
        requested === 'mj' || requested === 'werewolf' || requested === 'turtlesoup' ? requested : 'ddz'

      let tableId: string
      if (venueId) {
        const t = driver.getTable(venueId)
        if (!t) throw new DomainError('NOT_FOUND', `table not found: ${venueId}`)
        tableId = t.id
      } else {
        let t = driver.listTables().find((x) => x.status === 'waiting' && x.game === game && x.players.length < x.seats)
        if (!t) {
          const seatFee = body.seat_fee === undefined ? 0 : nonnegInt(body.seat_fee, 'seat_fee')
          t = driver.openTable({ game, seatFee })
        }
        tableId = t.id
      }

      const r = driver.seat(tableId, fish.id)
      if (!r.ok) {
        throw new DomainError(r.error === 'INSUFFICIENT' ? 'INSUFFICIENT' : 'CONFLICT', r.reason ?? r.error ?? 'seat failed')
      }
      const table = driver.getTable(tableId)!
      engine.addEvent(fish.id, 'signup', { tableId, game: table.game, seat: r.seat })
      return {
        ok: true,
        table: { id: table.id, game: table.game, status: table.status, seatFee: table.seatFee, seats: table.seats, players: table.players },
        state: table.status,
        note: table.status === 'playing' ? '人齐了，牌局开始，每一步小镇会叫你' : '报上了，等人凑齐就开打',
        receipt: { ok: true, code: 'OK', reason: '', where: 'table', balance: getFish(db, fish.id)!.balance, delta: -table.seatFee },
      }
    }),
  )

  // POST visit {fish_id|name, intent?}：P2 最小串门（记事件，不开回合）。
  app.post(
    '/visit',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      let target = body.fish_id ? getFish(db, String(body.fish_id)) : null
      if (!target && typeof body.name === 'string' && body.name.trim()) {
        const row = db.prepare('SELECT id FROM fish WHERE name = ? LIMIT 1').get(body.name.trim()) as { id: string } | undefined
        target = row ? getFish(db, row.id) : null
      }
      if (!target) throw new DomainError('NOT_FOUND', 'target fish not found')
      if (target.id === fish.id) throw new DomainError('BAD_REQUEST', '不能找自己串门')
      engine.addEvent(fish.id, 'visit', { target: target.id, targetName: target.name, intent: body.intent ?? null })
      engine.addEvent(target.id, 'visit', { from: fish.id, fromName: fish.name })
      return { ok: true, note: `去敲 ${target.name} 的门了`, receipt: { ok: true, code: 'OK', where: 'visit', balance: getFish(db, fish.id)!.balance } }
    }),
  )

  // ---------- 开店 ----------

  app.get(
    '/shop/mine',
    h(async ({ fish }) => ({ ok: true, shop: listShop(db, fish.id) })),
  )

  app.post(
    '/shop/open',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) throw new DomainError('BAD_REQUEST', 'name is required')
      const shop = createShop(db, fish.id, name, typeof body.kind === 'string' ? body.kind : null)
      engine.addEvent(fish.id, 'shop', { what: 'open', shopId: shop.id, name: shop.name })
      return { ok: true, shop }
    }),
  )

  app.post(
    '/shop/stock',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const shop = listShop(db, fish.id)
      if (!shop) throw new DomainError('NOT_FOUND', '先开店（POST /shop/open）')
      const name = typeof body.item === 'string' ? body.item.trim() : ''
      if (!name) throw new DomainError('BAD_REQUEST', 'item is required')
      const price = nonnegInt(body.price ?? 0, 'price')
      if (price < 1) throw new DomainError('BAD_REQUEST', 'price 至少 1')
      const stock = nonnegInt(body.stock ?? 0, 'stock')
      const existing = shop.items.find((it) => it.name === name)
      if (existing) {
        setItemPrice(db, existing.id, price)
        setStock(db, existing.id, stock)
      } else {
        addItem(db, shop.id, { name, price, stock, desc: typeof body.desc === 'string' ? body.desc : '' })
      }
      return { ok: true, shop: listShop(db, fish.id) }
    }),
  )

  app.post(
    '/shop/close',
    h(async ({ fish }) => {
      const shop = listShop(db, fish.id)
      if (!shop) throw new DomainError('NOT_FOUND', '没有自己的店')
      db.prepare('UPDATE shop SET open = 0 WHERE id = ? AND owner_fish_id = ?').run(shop.id, fish.id)
      return { ok: true, shop: listShop(db, fish.id) }
    }),
  )

  // 买货（供 P2 端到端：别人买 → 店主进账）
  app.post(
    '/shop/buy',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const itemId = body.item_id ? String(body.item_id) : ''
      if (!itemId) throw new DomainError('BAD_REQUEST', 'item_id is required')
      const qty = body.qty === undefined ? 1 : nonnegInt(body.qty, 'qty')
      const order = buyItem(db, fish.id, itemId, qty < 1 ? 1 : qty)
      engine.addEvent(fish.id, 'shop_buy', { item: itemId, qty: order.qty, total: order.total, shopId: order.shopId })
      engine.addEvent(order.ownerFishId, 'shop_sale', { item: itemId, qty: order.qty, total: order.total, buyer: fish.id })
      return {
        ok: true,
        receipt: { ok: true, code: 'OK', where: 'shop', balance: order.buyerBalance, delta: -order.total },
        order,
      }
    }),
  )

  // ---------- 悬赏 ----------

  app.get(
    '/bounties',
    h(async () => ({ ok: true, bounties: listBounties(db) })),
  )

  const postBounty = h(async ({ fish, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const reward = Number(body.reward)
    if (!Number.isInteger(reward) || reward < 1) throw new DomainError('BAD_REQUEST', 'reward 必须是正整数')
    const bounty = createBounty(db, fish.id, { title: String(body.title ?? ''), desc: typeof body.desc === 'string' ? body.desc : '', reward })
    engine.addEvent(fish.id, 'bounty', { what: 'post', bountyId: bounty.id, reward })
    return { ok: true, bounty }
  })

  app.post('/bounties/post', postBounty)
  // town-client 的 bountyPost 实际请求 POST /bounties（保持两条路径都可用）
  app.post('/bounties', postBounty)

  app.post(
    '/bounties/take',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const id = String(body.bounty_id ?? '')
      if (!id) throw new DomainError('BAD_REQUEST', 'bounty_id is required')
      const bounty = takeBounty(db, id, fish.id)
      engine.addEvent(fish.id, 'bounty', { what: 'take', bountyId: bounty.id, reward: bounty.reward })
      if (bounty.posterFishId) engine.addEvent(bounty.posterFishId, 'bounty', { what: 'taken', bountyId: bounty.id, taker: fish.id })
      return { ok: true, bounty }
    }),
  )

  app.post(
    '/bounties/claim',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const id = String(body.bounty_id ?? '')
      if (!id) throw new DomainError('BAD_REQUEST', 'bounty_id is required')
      const bounty = claimBounty(db, id, fish.id)
      engine.addEvent(fish.id, 'bounty', { what: 'claim', bountyId: bounty.id, reward: bounty.reward })
      if (bounty.posterFishId) engine.addEvent(bounty.posterFishId, 'bounty', { what: 'paid', bountyId: bounty.id, taker: fish.id })
      return { ok: true, bounty }
    }),
  )
}

export default residentP2Routes
