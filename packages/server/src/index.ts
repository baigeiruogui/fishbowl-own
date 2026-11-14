import Fastify from 'fastify'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig } from './config.ts'
import { openDb } from './db/index.ts'
import { createTurnEngine, type TurnEngineOptions } from './engine/index.ts'
import { residentRoutes } from './api/resident.ts'
import { residentP2Routes } from './api/resident-p2.ts'
import { residentP3Routes } from './api/resident-p3.ts'
import { residentP35Routes } from './api/resident-p35.ts'
import { ownerRoutes } from './api/owner.ts'
import { adminRoutes } from './api/admin.ts'
import { publicRoutes } from './api/public.ts'
import { publicP2Routes } from './api/public-p2.ts'
import { publicP3Routes } from './api/public-p3.ts'
import { publicP35Routes } from './api/public-p35.ts'
import { registerStatic } from './static.ts'
import { seedTown } from './seed.ts'
import { createDriver } from './games/driver.ts'
import { npcStep } from './sim/npc.ts'
import { generateDailyPaper } from './sim/paper.ts'
import { createRateLimiter, perIpKey, perResidentKey } from './api/rate-limit.ts'
import { cleanupEvents, cleanupTurns } from './maintenance.ts'

const here = dirname(fileURLToPath(import.meta.url))

export interface BuildOptions {
  dbPath?: string
  engine?: TurnEngineOptions
  /** 主人 API 的 admin token（默认读 env ADMIN_TOKEN） */
  adminToken?: string
  /** 覆盖静态目录（测试用）；默认 packages/web/dist */
  staticDir?: string
  /** 是否在 boot 时跑幂等种子。默认 true。 */
  seed?: boolean
  townName?: string
  /** F1 钓鱼防刷策略覆盖（冷却 / 每日上限 / 鱼饵成本） */
  fishing?: { cooldownMs?: number; dailyLimit?: number; baitCost?: number }
  /** 限流阈值覆盖（默认 resident/owner 60 次/10min、public 600 次/min、admin 120 次/10min） */
  rateLimit?: { residentMax?: number; ownerMax?: number; publicMax?: number; adminMax?: number; windowMs?: number }
  /** 公网开放注册：true=新鱼直接 active；false=新鱼 pending 待管理员审批（默认读 env OPEN_REGISTRATION） */
  openRegistration?: boolean
  /** 反代信任：true 时按 x-forwarded-for 解析真实客户端 IP（默认读 env TRUST_PROXY） */
  trustProxy?: boolean
}

export async function buildServer(opts: BuildOptions = {}) {
  const cfg = loadConfig()
  const db = openDb(opts.dbPath ?? cfg.dbPath)
  if (opts.seed !== false) {
    seedTown(db, { startBalance: cfg.startBalance, npcBalance: cfg.npcBalance })
  }
  const engine = createTurnEngine(db, opts.engine)
  const driver = createDriver(db)
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === 'true'
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy })

  app.decorate('db', db)
  app.decorate('engine', engine)
  app.decorate('driver', driver)
  app.decorate('cfg', cfg)

  // ADMIN_TOKEN 为空：只告警，不开放 owner 写（ownerRoutes 的 isAdmin 会拒绝所有请求）
  const adminToken = opts.adminToken ?? cfg.adminToken
  if (!adminToken) {
    app.log.warn('ADMIN_TOKEN 未配置：主人 API 将拒绝所有请求（仅 public / resident 可用）')
  }

  // 限流：resident/owner 按接入码或 IP 走较紧的阈值；public 只读宽松
  const windowMs = opts.rateLimit?.windowMs ?? 10 * 60_000
  const residentLimiter = createRateLimiter({ windowMs, max: opts.rateLimit?.residentMax ?? 60, keyOf: perResidentKey })
  const ownerLimiter = createRateLimiter({ windowMs, max: opts.rateLimit?.ownerMax ?? 60, keyOf: perIpKey })
  const publicLimiter = createRateLimiter({ windowMs: 60_000, max: opts.rateLimit?.publicMax ?? 600, keyOf: perIpKey })
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url
    let limiter: ReturnType<typeof createRateLimiter> | null = null
    if (url.startsWith('/town/api/resident')) limiter = residentLimiter
    else if (url.startsWith('/api/owner')) limiter = ownerLimiter
    else if (url.startsWith('/api/public')) limiter = publicLimiter
    if (!limiter) return
    await limiter(req, reply)
    if (reply.sent) return reply
  })

  app.get('/healthz', async () => {
    let dbReadable = false
    try {
      db.prepare('SELECT 1 AS ok').get()
      dbReadable = true
    } catch {
      dbReadable = false
    }
    return {
      ok: dbReadable,
      service: 'fishbowl-own',
      ts: Date.now(),
      db: dbReadable ? 'ok' : 'error',
      dbReadable,
      driverReady: !!driver,
    }
  })
  app.get('/api/public/ping', async () => ({ ok: true, town: opts.townName ?? 'fishbowl-own' }))

  // 镇民鱼协议（长轮询回合 / 事件 / 自助 / 赚钱）
  await app.register(residentRoutes, { prefix: '/town/api/resident', db, engine, fishing: opts.fishing, driver })
  // P2 镇民鱼：开桌/入座、串门、开店、悬赏（同前缀，独立封装）
  await app.register(residentP2Routes, { prefix: '/town/api/resident', db, engine, driver })
  // P3 镇民鱼：社交送礼 / 小手机 / 关系 / 法庭（同前缀）
  await app.register(residentP3Routes, { prefix: '/town/api/resident', db, engine })
  // P3.5 镇民鱼：媒体 / 夸夸 / 小游戏（同前缀）
  await app.register(residentP35Routes, { prefix: '/town/api/resident', db, engine })
  // 主人 API（ADMIN_TOKEN 全局管理员 或 ownerToken 多主人）
  await app.register(ownerRoutes, {
    prefix: '/api/owner',
    db,
    adminToken,
    startBalance: cfg.startBalance,
    openRegistration: opts.openRegistration ?? process.env.OPEN_REGISTRATION === 'true',
  })
  // 全局管理员 API（列全部鱼 / 审批 / 封禁 / 解封）
  await app.register(adminRoutes, { prefix: '/api/admin', db, adminToken, adminMax: opts.rateLimit?.adminMax, windowMs: opts.rateLimit?.windowMs })
  // 公开只读 API（web 用）
  await app.register(publicRoutes, { prefix: '/api/public', db, townName: opts.townName })
  // P2 公开只读：大厅 / 单桌 / 排行榜 / 日报
  await app.register(publicP2Routes, { prefix: '/api/public', db, driver })
  // P3 公开只读：法庭 / 关系 / 小手机（隐私占位）
  await app.register(publicP3Routes, { prefix: '/api/public', db })
  // P3.5 公开只读：相册 / 画廊 / 夸夸 / 相册文件
  await app.register(publicP35Routes, { prefix: '/api/public', db })

  // 静态托管：packages/web/dist 存在则同源提供（SPA）
  const staticDir = opts.staticDir ?? join(here, '../../web/dist')
  if (opts.staticDir !== undefined || existsSync(staticDir)) {
    registerStatic(app, staticDir)
  }

  app.addHook('onClose', async () => { try { db.close() } catch { /* ignore */ } })
  return app
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const cfg = loadConfig()
  const app = await buildServer()
  await app.listen({ port: cfg.port, host: cfg.host })
  app.log.info(`fishbowl-own server on http://${cfg.host}:${cfg.port}  db=${cfg.dbPath}`)

  // sim tick：结算到期打工 + NPC 决策（接活/入座/买货/接悬赏）+ 定期生成日报
  const db = (app as unknown as { db: ReturnType<typeof openDb> }).db
  const engine = (app as unknown as { engine: ReturnType<typeof createTurnEngine> }).engine
  const driver = (app as unknown as { driver: ReturnType<typeof createDriver> }).driver
  let lastPaper = 0
  let lastCleanup = 0
  const timer = setInterval(() => {
    try {
      engine.tick()
      npcStep(db, driver)
      const now = Date.now()
      if (now - lastPaper >= 60_000) {
        generateDailyPaper(db, now)
        lastPaper = now
      }
      // 运维清理：每 5 分钟清理历史回合（关闭/过期）与已读旧事件
      if (now - lastCleanup >= 5 * 60_000) {
        cleanupTurns(db, { olderThanMs: 60 * 60_000, now })
        cleanupEvents(db, { olderThanMs: 7 * 24 * 60 * 60_000, keepUnread: true, now })
        lastCleanup = now
      }
    } catch (e) {
      app.log.error(e, 'tick failed')
    }
  }, cfg.tickMs)
  timer.unref?.()

  // 优雅关闭：SIGTERM / SIGINT → 停 tick、app.close（触发 onClose 关 db）
  let closing = false
  const shutdown = async (sig: string) => {
    if (closing) return
    closing = true
    app.log.info(`收到 ${sig}，开始优雅关闭…`)
    try {
      clearInterval(timer)
    } catch {
      /* ignore */
    }
    try {
      await app.close()
    } catch (e) {
      app.log.error(e, '关闭 app 失败')
    }
    try {
      db.close()
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}
