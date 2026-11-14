// scripts/e2e/lib.mjs — 端到端测试脚手架共用工具（真实 HTTP + 真 DB，不 mock 经济）。
//
// 运行方式：脚本以 ESM(.mjs) 直接 import packages/server/src/*.ts。
// Node 24 原生剥离 TypeScript 类型（type stripping），无需先编译；server 的
// 依赖（fastify / @fishbowl/shared）按其自身 node_modules 解析，故从仓库任意位置跑都行。
//
// 这个文件只做「脚手架」：起一个临时库/随机端口的真服务端、造带 fbr_ 接入码的鱼、
// 提供 HTTP 调用封装、账本查询与断言。具体场景放 p1-server.mjs（后续 t5 可复用本文件）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildServer } from '../../packages/server/src/index.ts'
import { createFish, getFish } from '../../packages/server/src/db/index.ts'
import { issueResidentCode } from '../../packages/server/src/api/auth.ts'
import { createJobOffer, takeJob } from '../../packages/server/src/domain/jobs.ts'
import { addCatch, getMarket, listCatch, sellCatch } from '../../packages/server/src/domain/fishing.ts'
import { ledgerSum, verifyBalance, spentToday } from '../../packages/server/src/domain/account.ts'
import { paySeatFee } from '../../packages/server/src/domain/seat.ts'

// 把 server 侧常用能力集中 re-export，场景脚本只需 import 本文件。
export {
  buildServer, createFish, getFish, issueResidentCode,
  createJobOffer, takeJob, addCatch, getMarket, listCatch, sellCatch,
  ledgerSum, verifyBalance, spentToday, paySeatFee,
}

export const RESIDENT_PREFIX = '/town/api/resident'

/**
 * 起一个真服务端：临时 SQLite 文件 + 随机端口（port 0）+ 关闭 Fastify 日志。
 * 返回 { app, db, engine, base, port, dbPath, close() }；close() 会关服务并删临时目录。
 */
export async function startTestServer(opts = {}) {
  // buildServer 依据 NODE_ENV 决定是否打请求日志；e2e 自己的报告更干净，默认静音。
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test'
  const dir = mkdtempSync(join(tmpdir(), 'fishbowl-e2e-'))
  const dbPath = opts.dbPath ?? join(dir, 'e2e.db')
  const app = await buildServer({
    dbPath,
    engine: { agencyCooldownMs: 0, ...(opts.engine ?? {}) },
    adminToken: opts.adminToken,
    seed: opts.seed,
    // e2e 快速模式：默认关掉钓鱼冷却（生产默认 60s），便于一次性验证「钓鱼→卖钱」
    fishing: opts.fishing !== undefined ? opts.fishing : { cooldownMs: 0 },
    // 限流可由 e2e 覆盖（压测脚本会跑很多请求，需要抬高 resident 限流；生产默认 60/10min）
    rateLimit: opts.rateLimit,
    // 公网入驻开关（false = 新鱼 pending 需管理员审批；e2e 可覆盖）
    openRegistration: opts.openRegistration,
  })
  await app.listen({ port: opts.port ?? 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : null
  if (!port) throw new Error('服务端没有绑定到端口')
  return {
    app,
    db: app.db,
    engine: app.engine,
    dbPath,
    port,
    base: `http://127.0.0.1:${port}`,
    async close() {
      try {
        await app.close() // onClose 会关 db
      } finally {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    },
  }
}

/**
 * 造一条会接入小镇的镇民鱼（db 直连回退路径）：
 * db.createFish 落库 → db.getFish 读回确认 → api/auth.issueResidentCode 发 fbr_ 接入码。
 * 返回 { fish, code }。t7 主人 API 就绪时优先用 createFishViaOwnerApi（HTTP）建鱼。
 */
export function createResidentFish(db, opts = {}) {
  const created = createFish(db, {
    name: opts.name ?? 'e2e小鱼',
    balance: opts.balance ?? 100,
    kind: opts.kind ?? 'resident',
    persona: opts.persona ?? '',
    intro: opts.intro ?? '',
  })
  const fish = getFish(db, created.id) // 读回，确认真的落库
  if (!fish) throw new Error(`createFish 之后 getFish 读不到 ${created.id}`)
  const { code } = issueResidentCode(db, fish.id)
  return { fish, code }
}

/**
 * 优先路径：通过 t7 主人 API（HTTP，ADMIN_TOKEN 保护）建鱼，一次性拿回明文 fbr_ 接入码。
 * POST /api/owner/fish {name,balance} → {ok, fish, code}。返回 { fish, code }。
 * 若主人 API 未就绪（404/401 等），调用方可回退到 createResidentFish(db)。
 */
export async function createFishViaOwnerApi(base, adminToken, opts = {}) {
  const res = await fetch(base + '/api/owner/fish', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: opts.name ?? 'e2e小鱼',
      balance: opts.balance ?? 100,
      kind: opts.kind ?? 'resident',
      persona: opts.persona ?? '',
      intro: opts.intro ?? '',
    }),
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!res.ok || !body || body.ok !== true || !body.fish || !body.code) {
    const err = new Error(`POST /api/owner/fish 失败：HTTP ${res.status} ${text}`)
    err.status = res.status
    err.body = body
    throw err
  }
  return { fish: body.fish, code: body.code }
}

/**
 * 给一个 fish 的 fbr_ 接入码封装 resident HTTP 客户端。
 * api.get(path) / api.post(path, body) → { status, ok, body }。
 * path 是相对 /town/api/resident 的部分（可带 query）。
 */
export function residentApi(base, code) {
  const headers = { authorization: `Bearer ${code}`, 'content-type': 'application/json' }
  const call = async (method, path, body) => {
    const res = await fetch(base + RESIDENT_PREFIX + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
    return { status: res.status, ok: res.ok, body: parsed }
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
  }
}

/** 某条鱼的全部账本行（按 id 升序，append-only 的真实顺序）。 */
export function ledgerRows(db, fishId) {
  return db
    .prepare('SELECT id, delta, balance_after, reason, ref, ts FROM ledger WHERE fish_id = ? ORDER BY id ASC')
    .all(fishId)
}

/** 按 reason 汇总 delta（Map<reason, sum>）。 */
export function sumByReason(rows) {
  const m = new Map()
  for (const r of rows) m.set(r.reason, (m.get(r.reason) ?? 0) + Number(r.delta))
  return m
}

// ---------------- 断言 / 格式化 ----------------

export function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `ASSERT FAILED: ${msg}（expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}）`,
    )
  }
}

/** 鱼币带符号展示：+30 / -12 / 0 */
export function money(n) {
  return (n > 0 ? '+' : '') + n
}

/** 接入码脱敏：只露头尾，避免整串进日志。 */
export function maskCode(code) {
  if (!code) return '(空)'
  return code.length <= 14 ? code.slice(0, 6) + '…' : code.slice(0, 9) + '…' + code.slice(-4)
}

/** 等宽对齐一格（仅用于报告表格美观）。 */
export function pad(s, width) {
  const str = String(s)
  return str.length >= width ? str : str + ' '.repeat(width - str.length)
}
