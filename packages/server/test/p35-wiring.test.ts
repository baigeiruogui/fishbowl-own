import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/index.ts'
import { getFish } from '../src/db/index.ts'
import type { DB } from '../src/db/index.ts'

const ADMIN = 't35-admin'
const RES = '/town/api/resident'

async function setup() {
  const albumDir = mkdtempSync(join(tmpdir(), 'p35-album-'))
  const prev = process.env.ALBUM_DIR
  process.env.ALBUM_DIR = albumDir
  const app = await buildServer({ dbPath: ':memory:', adminToken: ADMIN })
  const db = (app as unknown as { db: DB }).db
  const restore = () => {
    if (prev === undefined) delete process.env.ALBUM_DIR
    else process.env.ALBUM_DIR = prev
    rmSync(albumDir, { recursive: true, force: true })
  }
  return { app, db, restore }
}

async function resident(app: Awaited<ReturnType<typeof buildServer>>, name: string, balance = 100) {
  const created = (
    await app.inject({ method: 'POST', url: '/api/owner/fish', headers: { 'x-admin-token': ADMIN }, payload: { name, balance } })
  ).json() as any
  return { id: created.fish.id, headers: { authorization: 'Bearer ' + created.code } }
}

// 1) 拍照扣费 + 相册可见 + 文件可取 + 路径穿越防护
test('P3.5：拍照扣费、相册可见、SVG 文件可取、非法 id 被拒', async () => {
  const { app, db, restore } = await setup()
  const fish = await resident(app, '摄影师', 100)

  const photo = await app.inject({ method: 'POST', url: `${RES}/photo`, headers: fish.headers, payload: { scene: '码头的黄昏', price: 25 } })
  const pb = photo.json() as any
  assert.equal(pb.ok, true)
  assert.equal(pb.receipt.delta, -25)
  assert.equal(getFish(db, fish.id)!.balance, 75)
  const albumId = pb.entry.id as string

  const album = await app.inject({ method: 'GET', url: `${RES}/album`, headers: fish.headers })
  assert.ok((album.json() as any).album.some((e: any) => e.id === albumId))

  const pubAlbum = await app.inject({ method: 'GET', url: `/api/public/album?fishId=${fish.id}` })
  assert.ok((pubAlbum.json() as any).album.some((e: any) => e.id === albumId))

  const file = await app.inject({ method: 'GET', url: `/api/public/album/${albumId}/file` })
  assert.equal(file.statusCode, 200)
  assert.ok(String(file.headers['content-type']).includes('image/svg+xml'))
  assert.ok(file.payload.includes('<svg'))

  // 路径穿越 / 非法 id → 400，不泄露文件
  const bad = await app.inject({ method: 'GET', url: `/api/public/album/..%2F..%2Fetc%2Fpasswd/file` })
  assert.equal(bad.statusCode, 400)
  restore()
})

// 2) 点歌 + 画铺（都可扣费入相册）
test('P3.5：点歌 / 画铺 扣费并进相册', async () => {
  const { app, db, restore } = await setup()
  const fish = await resident(app, '文艺鱼', 100)

  const song = await app.inject({ method: 'POST', url: `${RES}/song`, headers: fish.headers, payload: { title: '海风小调', price: 1 } })
  assert.equal((song.json() as any).ok, true)
  const paint = await app.inject({ method: 'POST', url: `${RES}/paint`, headers: fish.headers, payload: { title: '一只猫', price: 1 } })
  assert.equal((paint.json() as any).ok, true)

  const album = await app.inject({ method: 'GET', url: `${RES}/album`, headers: fish.headers })
  const kinds = (album.json() as any).album.map((e: any) => e.kind)
  assert.ok(kinds.includes('song'))
  assert.ok(kinds.includes('painting'))
  assert.equal(getFish(db, fish.id)!.balance, 98)
  restore()
})

// 3) 夸夸写入 + public 可见
test('P3.5：发夸夸写入事件，public /bless 可见', async () => {
  const { app, restore } = await setup()
  const fish = await resident(app, '夸夸鱼', 100)
  const r = await app.inject({ method: 'POST', url: `${RES}/bless`, headers: fish.headers, payload: { text: '你今天的鳞片真好看' } })
  const rb = r.json() as any
  assert.equal(rb.ok, true)
  assert.equal(typeof rb.blessId, 'string')
  assert.ok(rb.recipients >= 1)

  const pub = await app.inject({ method: 'GET', url: '/api/public/bless' })
  const list = (pub.json() as any).bless as any[]
  assert.ok(list.some((b) => b.text === '你今天的鳞片真好看'))
  restore()
})

// 4) 小游戏 rps / dice / lottery 结算与日上限
test('P3.5：rps / dice / lottery 结算；lottery 当日第二次被拒', async () => {
  const { app, restore } = await setup()
  const fish = await resident(app, '游戏鱼', 100)

  const rps = await app.inject({ method: 'POST', url: `${RES}/rps`, headers: fish.headers, payload: { choice: 'rock', stake: 1 } })
  const rpsB = rps.json() as any
  assert.equal(rpsB.ok, true)
  assert.ok(['win', 'lose', 'draw'].includes(rpsB.result.result))

  const dice = await app.inject({ method: 'POST', url: `${RES}/dice`, headers: fish.headers, payload: { stake: 1 } })
  assert.equal((dice.json() as any).ok, true)

  const lot1 = await app.inject({ method: 'POST', url: `${RES}/lottery`, headers: fish.headers, payload: {} })
  assert.equal((lot1.json() as any).ok, true)
  const lot2 = await app.inject({ method: 'POST', url: `${RES}/lottery`, headers: fish.headers, payload: {} })
  assert.notEqual(lot2.statusCode, 200)
  assert.equal((lot2.json() as any).error, 'DAY_CAP')
  restore()
})

// 5) gallery 种子 + public 列表
test('P3.5：seed 生成画廊（2-3 张），public /gallery 可读', async () => {
  const { app, restore } = await setup()
  const g = await app.inject({ method: 'GET', url: '/api/public/gallery' })
  const gb = g.json() as any
  assert.equal(gb.ok, true)
  assert.ok(Array.isArray(gb.gallery))
  assert.ok(gb.gallery.length >= 2 && gb.gallery.length <= 3, `gallery 数量应为 2-3，实际 ${gb.gallery.length}`)
  restore()
})
