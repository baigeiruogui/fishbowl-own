// P3.5 resident 接线：媒体（拍照/点歌/画铺/相册）、夸夸群、小游戏（猜拳/骰子/抽奖）。
// 与 resident.ts 同前缀注册，独立封装鉴权与 paused 写保护。
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { getFish } from '../db/index.ts'
import type { TurnEngine } from '../engine/turns.ts'
import { authenticate } from './auth.ts'
import { DomainError } from '../domain/errors.ts'
import { sendError } from './common.ts'
import { addPainting, listAlbum, orderSong, takePhoto } from '../domain/media.ts'
import { createBless } from '../domain/bless.ts'
import { lottery, playRps, rollDice } from '../domain/minigames.ts'
import type { RpsChoice } from '../domain/minigames.ts'

export interface ResidentP35Deps {
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

function optPrice(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new DomainError('BAD_REQUEST', 'price 必须是正整数')
  return n
}

export const residentP35Routes: FastifyPluginAsync<ResidentP35Deps> = async (app: FastifyInstance, opts) => {
  const { db, engine } = opts
  const h = (fn: Handler) => makeHandler(db, fn) as unknown as Parameters<FastifyInstance['get']>[1]

  // ---------- 媒体 ----------

  app.post(
    '/photo',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const entry = await takePhoto(db, fish.id, { scene: String(body.scene ?? ''), price: optPrice(body.price) })
      engine.addEvent(fish.id, 'media', { what: 'photo', albumId: entry.id, title: entry.title, price: entry.price })
      return { ok: true, receipt: { ok: true, code: 'OK', where: 'media', balance: getFish(db, fish.id)!.balance, delta: -entry.price }, entry }
    }),
  )

  app.post(
    '/song',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const entry = await orderSong(db, fish.id, { title: String(body.title ?? body.song ?? ''), price: optPrice(body.price) })
      engine.addEvent(fish.id, 'media', { what: 'song', albumId: entry.id, title: entry.title, price: entry.price })
      return { ok: true, receipt: { ok: true, code: 'OK', where: 'media', balance: getFish(db, fish.id)!.balance, delta: -entry.price }, entry }
    }),
  )

  app.post(
    '/paint',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const title = String(body.title ?? body.wish ?? '画作')
      const price = optPrice(body.price) ?? 60
      const entry = await addPainting(db, fish.id, { title, price })
      engine.addEvent(fish.id, 'media', { what: 'paint', albumId: entry.id, title: entry.title, price: entry.price })
      return { ok: true, receipt: { ok: true, code: 'OK', where: 'media', balance: getFish(db, fish.id)!.balance, delta: -entry.price }, entry }
    }),
  )

  app.get(
    '/album',
    h(async ({ fish, req }) => {
      const q = req.query as Record<string, string | undefined>
      const limit = q.limit ? Number(q.limit) : 20
      return { ok: true, album: listAlbum(db, fish.id, limit) }
    }),
  )

  // ---------- 夸夸群 ----------

  app.post(
    '/bless',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const res = createBless(db, fish.id, { text: String(body.text ?? '') })
      return { ok: true, blessId: res.blessId, recipients: res.recipients }
    }),
  )

  // ---------- 小游戏 ----------

  app.post(
    '/rps',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const res = playRps(db, fish.id, { choice: String(body.choice ?? '') as RpsChoice, stake: body.stake === undefined ? undefined : Number(body.stake) })
      engine.addEvent(fish.id, 'minigame', { game: 'rps', result: res.result, stake: res.stake, balance: res.balance })
      return { ok: true, result: res }
    }),
  )

  app.post(
    '/dice',
    h(async ({ fish, req }) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const res = rollDice(db, fish.id, { stake: body.stake === undefined ? undefined : Number(body.stake) })
      engine.addEvent(fish.id, 'minigame', { game: 'dice', result: res.result, stake: res.stake, balance: res.balance })
      return { ok: true, result: res }
    }),
  )

  app.post(
    '/lottery',
    h(async ({ fish }) => {
      const res = lottery(db, fish.id)
      engine.addEvent(fish.id, 'minigame', { game: 'lottery', hit: res.hit, bonus: res.bonus, balance: res.balance })
      return { ok: true, result: res }
    }),
  )
}

export default residentP35Routes
