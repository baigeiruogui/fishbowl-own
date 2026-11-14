#!/usr/bin/env node
// 本地 stub 后端：server 未就绪 / 独立演示时，给 web 面板提供真实 HTTP 数据。
// 数据与前端 mock 兜底同源（复用 src/mock.ts，Node 24 原生跑 TS）；主人 API 的建鱼/换码/暂停
// 用进程内内存模拟（重启即清空，仅用于演示与联调前自测）。
// 用法：node mock/api-server.mjs [port]
//   主人令牌：默认 stub-admin（可用环境变量 ADMIN_TOKEN 覆盖）。
import { createServer } from 'node:http'
import {
  mockTown,
  mockFishList,
  mockFishDetail,
  mockLobby,
  mockTable,
  mockBoard,
  mockPaper,
  mockCourt,
  mockRelations,
  mockPhone,
  mockAlbum,
  mockGallery,
  mockBless,
} from '../src/mock.ts'

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'stub-admin'

// ---- 进程内可变状态（建鱼 / 状态覆盖 / 接入码 / 多主人账号） ----
const createdFish = new Map() // id -> fish summary 形状
const statusOverride = new Map() // fishId -> status
const codes = new Map() // fishId -> code
const ownerAccounts = new Map() // ownerToken -> { id, name }
const ownerFishIds = new Map() // ownerToken -> fishId[]
let seq = 1
let ownerSeq = 1

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readJson(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > 64 * 1024) buf = buf.slice(0, 64 * 1024)
    })
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function adminTokenFrom(req) {
  const x = req.headers['x-admin-token']
  if (typeof x === 'string' && x) return x
  const auth = req.headers.authorization
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m) return m[1].trim()
  }
  return ''
}

function isAdmin(req) {
  return !!ADMIN_TOKEN && adminTokenFrom(req) === ADMIN_TOKEN
}

function withStatus(f) {
  return { ...f, status: statusOverride.get(f.id) ?? f.status }
}

function allFish() {
  return [...mockFishList().map(withStatus), ...[...createdFish.values()].map(withStatus)]
}

function newCode() {
  return 'fbr_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
}

function newOwnerToken() {
  return 'own_stub_' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
}

/** 主人自助列表：token -> {ok, owner, fish:[{id,name,kind,status,balance,dayCap,hasCode,createdAt}]} */
function ownerSelfPayload(token) {
  const owner = ownerAccounts.get(token)
  const ids = ownerFishIds.get(token) ?? []
  const fish = ids
    .map((id) => createdFish.get(id))
    .filter(Boolean)
    .map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      status: statusOverride.get(f.id) ?? f.status,
      balance: f.balance,
      dayCap: f.dayCap ?? null,
      hasCode: codes.has(f.id),
      createdAt: f.createdAt,
    }))
  return { ok: true, owner: owner ?? null, fish }
}

function ownerView(f) {
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    persona: f.persona ?? '',
    intro: f.intro ?? '',
    lookNote: f.lookNote ?? '',
    avatar: f.avatar ?? '🐠',
    status: statusOverride.get(f.id) ?? f.status ?? 'active',
    balance: f.balance ?? 0,
    dayCap: f.dayCap ?? null,
    createdAt: f.createdAt ?? Date.now(),
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,accept,x-admin-token,authorization',
    })
    res.end()
    return
  }

  // ---------- 主人 API（ADMIN_TOKEN 或 ownerToken，内存模拟） ----------
  if (path.startsWith('/api/owner/')) {
    // 注册（免鉴权）
    if (req.method === 'POST' && path === '/api/owner/register') {
      const body = await readJson(req)
      const name = (typeof body.name === 'string' ? body.name.trim() : '') || '热心主人'
      const ownerToken = newOwnerToken()
      const owner = { id: 'owner_stub_' + ownerSeq++, name }
      ownerAccounts.set(ownerToken, owner)
      ownerFishIds.set(ownerToken, [])
      json(res, 200, { ok: true, ownerId: owner.id, ownerToken, name: owner.name })
      return
    }

    // 多主人自助（Bearer ownerToken）
    const ownerToken = adminTokenFrom(req)
    const owner = ownerAccounts.get(ownerToken)
    if (owner) {
      if (req.method === 'GET' && (path === '/api/owner/me' || path === '/api/owner/fish')) {
        json(res, 200, ownerSelfPayload(ownerToken))
        return
      }
      if (req.method === 'POST' && path === '/api/owner/fish') {
        const body = await readJson(req)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) {
          json(res, 400, { ok: false, code: 'BAD_REQUEST', reason: 'name is required' })
          return
        }
        const ids = ownerFishIds.get(ownerToken) ?? []
        if (ids.length >= 3) {
          json(res, 409, { ok: false, code: 'CONFLICT', reason: '每个主人最多 3 条鱼' })
          return
        }
        const id = 'f_stub_owner_' + seq++
        const fish = {
          id,
          name,
          kind: 'resident',
          avatar: '🐠',
          intro: typeof body.intro === 'string' ? body.intro : '',
          persona: typeof body.persona === 'string' ? body.persona : '',
          lookNote: '',
          balance: Number.isInteger(body.balance) ? body.balance : 100,
          dayCap: null,
          status: 'active',
          online: true,
          createdAt: Date.now(),
        }
        createdFish.set(id, fish)
        const code = newCode()
        codes.set(id, code)
        ids.push(id)
        ownerFishIds.set(ownerToken, ids)
        json(res, 200, { ok: true, fish: ownerView(fish), code, status: 'active' })
        return
      }
      const orotate = /^\/api\/owner\/fish\/([^/]+)\/code\/rotate$/.exec(path)
      if (req.method === 'POST' && orotate) {
        const id = decodeURIComponent(orotate[1])
        const ids = ownerFishIds.get(ownerToken) ?? []
        if (!ids.includes(id)) {
          json(res, 404, { ok: false, code: 'NOT_FOUND', reason: `fish not found: ${id}` })
          return
        }
        const code = newCode()
        codes.set(id, code)
        json(res, 200, { ok: true, fish_id: id, code })
        return
      }
      const opause = /^\/api\/owner\/fish\/([^/]+)\/(pause|resume)$/.exec(path)
      if (req.method === 'POST' && opause) {
        const id = decodeURIComponent(opause[1])
        const ids = ownerFishIds.get(ownerToken) ?? []
        if (!ids.includes(id)) {
          json(res, 404, { ok: false, code: 'NOT_FOUND', reason: `fish not found: ${id}` })
          return
        }
        statusOverride.set(id, opause[2] === 'pause' ? 'paused' : 'active')
        const f = createdFish.get(id)
        json(res, 200, { ok: true, fish: ownerView({ ...f, status: statusOverride.get(id) }) })
        return
      }
      json(res, 404, { ok: false, code: 'NOT_FOUND', path })
      return
    }

    // 管理员（ADMIN_TOKEN）
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
      return
    }
    if (!isAdmin(req)) {
      json(res, 401, { ok: false, error: 'UNAUTHORIZED', code: 'UNAUTHORIZED', reason: 'missing or invalid admin token' })
      return
    }
    const body = await readJson(req)

    if (path === '/api/owner/fish') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        json(res, 400, { ok: false, code: 'BAD_REQUEST', reason: 'name is required' })
        return
      }
      const balance = Number.isInteger(body.balance) ? body.balance : 100
      if (balance < 0) {
        json(res, 400, { ok: false, code: 'BAD_REQUEST', reason: 'balance must be a non-negative integer' })
        return
      }
      const id = 'f_stub_' + seq++
      const fish = {
        id,
        name,
        kind: body.kind === 'npc' ? 'npc' : 'resident',
        avatar: '🐠',
        intro: typeof body.intro === 'string' ? body.intro : '',
        persona: typeof body.persona === 'string' ? body.persona : '',
        lookNote: '',
        balance,
        dayCap: null,
        status: 'active',
        online: true,
        createdAt: Date.now(),
      }
      createdFish.set(id, fish)
      const code = newCode()
      codes.set(id, code)
      json(res, 200, { ok: true, fish: ownerView(fish), code })
      return
    }

    const rotate = /^\/api\/owner\/fish\/([^/]+)\/code\/rotate$/.exec(path)
    if (rotate) {
      const id = decodeURIComponent(rotate[1])
      if (!allFish().some((f) => f.id === id)) {
        json(res, 404, { ok: false, code: 'NOT_FOUND', reason: `fish not found: ${id}` })
        return
      }
      const code = newCode()
      codes.set(id, code)
      json(res, 200, { ok: true, fish_id: id, code })
      return
    }

    const pause = /^\/api\/owner\/fish\/([^/]+)\/(pause|resume)$/.exec(path)
    if (pause) {
      const id = decodeURIComponent(pause[1])
      const fish = allFish().find((f) => f.id === id)
      if (!fish) {
        json(res, 404, { ok: false, code: 'NOT_FOUND', reason: `fish not found: ${id}` })
        return
      }
      statusOverride.set(id, pause[2] === 'pause' ? 'paused' : 'active')
      json(res, 200, { ok: true, fish: ownerView({ ...fish, status: statusOverride.get(id) }) })
      return
    }

    json(res, 404, { ok: false, code: 'NOT_FOUND', path })
    return
  }

  if (req.method !== 'GET') {
    json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
    return
  }

  if (path === '/healthz' || path === '/api/public/ping') {
    json(res, 200, { ok: true, service: 'fishbowl-web-stub', town: 'fishbowl-own', ts: Date.now() })
    return
  }

  if (path === '/api/public/town') {
    json(res, 200, { ok: true, ...mockTown() })
    return
  }

  if (path === '/api/public/fish') {
    json(res, 200, { ok: true, items: allFish() })
    return
  }

  const m = /^\/api\/public\/fish\/([^/]+)$/.exec(path)
  if (m) {
    const id = decodeURIComponent(m[1])
    const created = createdFish.get(id)
    if (created) {
      json(res, 200, {
        ok: true,
        fish: { ...ownerView(created), ownerName: null, online: true },
        ledger: [],
        stats: { todayEarned: 0, todaySpent: 0, totalEarned: 0, totalSpent: 0, entries: 0 },
      })
      return
    }
    const detail = mockFishDetail(id)
    if (!detail) {
      json(res, 404, { ok: false, code: 'NOT_FOUND', reason: `fish not found: ${id}` })
      return
    }
    const status = statusOverride.get(id) ?? detail.fish.status
    json(res, 200, { ok: true, ...detail, fish: { ...detail.fish, status, online: status === 'active' } })
    return
  }

  // P2：大厅 / 牌桌直播 / 积分榜 / 日报
  if (path === '/api/public/lobby') {
    json(res, 200, { ok: true, ...mockLobby() })
    return
  }
  if (path === '/api/public/board') {
    json(res, 200, { ok: true, ...mockBoard() })
    return
  }
  if (path === '/api/public/paper') {
    json(res, 200, { ok: true, ...mockPaper() })
    return
  }
  const tm = /^\/api\/public\/table\/([^/]+)$/.exec(path)
  if (tm) {
    const id = decodeURIComponent(tm[1])
    const table = mockTable(id)
    if (!table) {
      json(res, 404, { ok: false, code: 'NOT_FOUND', reason: `table not found: ${id}` })
      return
    }
    json(res, 200, { ok: true, table })
    return
  }

  // P3：法庭 / 关系 / 小手机（mock 优先，服务端未实现）
  if (path === '/api/public/court') {
    json(res, 200, { ok: true, ...mockCourt() })
    return
  }
  if (path === '/api/public/relations') {
    json(res, 200, { ok: true, ...mockRelations() })
    return
  }
  if (path === '/api/public/phone') {
    json(res, 200, { ok: true, ...mockPhone() })
    return
  }

  // P3.5：相册 / 画铺 / 夸夸墙（mock 优先）
  if (path === '/api/public/album') {
    const fishId = url.searchParams.get('fishId') || undefined
    json(res, 200, { ok: true, ...mockAlbum(fishId) })
    return
  }
  if (path === '/api/public/gallery') {
    json(res, 200, { ok: true, ...mockGallery() })
    return
  }
  if (path === '/api/public/bless') {
    const limit = Number(url.searchParams.get('limit') || 50)
    json(res, 200, { ok: true, ...mockBless(Number.isFinite(limit) ? limit : 50) })
    return
  }
  const af = /^\/api\/public\/album\/([^/]+)\/file$/.exec(path)
  if (af) {
    const id = decodeURIComponent(af[1]).replace(/[<>&"]/g, '')
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240">` +
      `<rect width="360" height="240" fill="#dff1fa"/><circle cx="300" cy="52" r="34" fill="rgba(255,255,255,0.5)"/>` +
      `<text x="180" y="120" font-size="56" text-anchor="middle">🐟</text>` +
      `<text x="180" y="186" font-size="16" text-anchor="middle" fill="#1d4a5c">${id}</text></svg>`
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-length': Buffer.byteLength(svg),
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    })
    res.end(svg)
    return
  }

  json(res, 404, { ok: false, code: 'NOT_FOUND', path })
})

server.listen(port, host, () => {
  console.log(
    `[fishbowl-web-stub] http://${host}:${port}  ADMIN_TOKEN=${ADMIN_TOKEN ? '(set)' : '(unset)'}  ` +
      `GET /api/public/{town,fish,fish/:id,lobby,table/:id,board,paper,court,relations,phone,album,gallery,bless,album/:id/file} · POST /api/owner/fish|fish/:id/{code/rotate,pause,resume}`,
  )
})
