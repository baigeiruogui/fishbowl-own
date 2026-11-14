import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFish, getFish, openDb } from '../src/db/index.ts'
import { ledgerSum } from '../src/domain/account.ts'
import {
  addPainting,
  genSceneSvg,
  getAlbumFile,
  listAlbum,
  orderSong,
  takePhoto,
} from '../src/domain/media.ts'

const TMP = mkdtempSync(join(tmpdir(), 'fishbowl-album-'))
process.env.ALBUM_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

function svgFiles(): string[] {
  try {
    return readdirSync(TMP).filter((f) => f.endsWith('.svg'))
  } catch {
    return []
  }
}

// 1. 拍照：默认扣 25，写文件 + 相册记录
test('takePhoto：默认 25 鱼币，扣款 + 生成 SVG 文件 + 相册记录', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '拍照鱼', balance: 100 })
  const entry = await takePhoto(db, fish.id, { scene: '海边日落' }, 1000)

  assert.equal(entry.kind, 'photo')
  assert.equal(entry.price, 25)
  assert.equal(entry.title, '海边日落')
  assert.ok(entry.path && entry.path.endsWith('.svg'))
  assert.equal(existsSync(entry.path!), true)
  assert.equal(getFish(db, fish.id)!.balance, 75)

  const row = db
    .prepare(`SELECT delta, reason FROM ledger WHERE fish_id = ? AND reason = 'social'`)
    .get(fish.id) as { delta: number; reason: string }
  assert.equal(Number(row.delta), -25)
  db.close()
})

// 2. genSceneSvg 内容包含标题 / 鱼名；getAlbumFile 能读回 SVG
test('genSceneSvg + getAlbumFile：SVG 含标题/鱼名，可读回', async () => {
  const svg = genSceneSvg({ scene: '码头', title: '我的画', fishName: '小银', ts: 1000 })
  assert.ok(svg.includes('<svg'))
  assert.ok(svg.includes('我的画'))
  assert.ok(svg.includes('小银'))

  const db = openDb(':memory:')
  const fish = createFish(db, { name: '小银', balance: 100 })
  const entry = await takePhoto(db, fish.id, { scene: '码头' }, 1000)
  const got = getAlbumFile(db, entry.id)
  assert.ok(got)
  assert.equal(got!.entry.id, entry.id)
  assert.ok(got!.svg && got!.svg.includes('码头'))
  assert.equal(getAlbumFile(db, 'album_nope'), null)
  db.close()
})

// 3. 余额不足：失败且无副作用（无相册、无文件、余额不变）
test('takePhoto：余额不足抛 INSUFFICIENT，无相册/无文件/余额不变', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '穷鱼', balance: 10 })
  const beforeFiles = svgFiles().length
  const beforeSum = ledgerSum(db, fish.id)

  await assert.rejects(
    () => takePhoto(db, fish.id, { scene: 'x', price: 25 }, 1000),
    (e: any) => e.code === 'INSUFFICIENT',
  )
  assert.equal(listAlbum(db, fish.id).length, 0)
  assert.equal(getFish(db, fish.id)!.balance, 10)
  assert.equal(ledgerSum(db, fish.id), beforeSum)
  assert.equal(svgFiles().length, beforeFiles) // 没有留下孤立文件
  db.close()
})

// 4. 点歌：扣费 + 记录，无音频文件
test('orderSong：默认 50 鱼币，记录 kind=song，无音频文件', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '点歌鱼', balance: 100 })
  const beforeFiles = svgFiles().length
  const entry = await orderSong(db, fish.id, { title: '海边的歌' }, 1000)

  assert.equal(entry.kind, 'song')
  assert.equal(entry.price, 50)
  assert.equal(entry.path, null)
  assert.equal(getFish(db, fish.id)!.balance, 50)
  assert.equal(svgFiles().length, beforeFiles) // 不生成文件
  const got = getAlbumFile(db, entry.id)
  assert.ok(got)
  assert.equal(got!.svg, null)
  assert.equal(got!.bytes, null)
  db.close()
})

// 5. 画铺：扣费 + 生成 SVG
test('addPainting：扣费 + 生成 SVG 文件，kind=painting', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '画家鱼', balance: 100 })
  const entry = await addPainting(db, fish.id, { title: '星空', price: 40 }, 1000)
  assert.equal(entry.kind, 'painting')
  assert.equal(entry.price, 40)
  assert.ok(entry.path && existsSync(entry.path))
  assert.equal(getFish(db, fish.id)!.balance, 60)
  db.close()
})

// 6. listAlbum：时间倒序、limit 生效
test('listAlbum：按时间倒序，limit 生效', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '收藏鱼', balance: 500 })
  await takePhoto(db, fish.id, { scene: '一号', price: 10 }, 1000)
  await takePhoto(db, fish.id, { scene: '二号', price: 10 }, 2000)
  await takePhoto(db, fish.id, { scene: '三号', price: 10 }, 3000)

  const all = listAlbum(db, fish.id)
  assert.deepEqual(all.map((e) => e.title), ['三号', '二号', '一号'])
  const two = listAlbum(db, fish.id, 2)
  assert.deepEqual(two.map((e) => e.title), ['三号', '二号'])
  db.close()
})

// 7. 非法价格 / 缺场景
test('takePhoto/addPainting：非法价格与缺场景被拒，无副作用', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '校验鱼', balance: 100 })
  for (const bad of [0, -5, 1.5]) {
    await assert.rejects(
      () => takePhoto(db, fish.id, { scene: 'x', price: bad as number }),
      (e: any) => e.code === 'BAD_REQUEST',
    )
  }
  await assert.rejects(
    () => takePhoto(db, fish.id, { scene: '   ' }),
    (e: any) => e.code === 'BAD_REQUEST',
  )
  await assert.rejects(
    () => addPainting(db, fish.id, { title: '', price: 10 }),
    (e: any) => e.code === 'BAD_REQUEST',
  )
  assert.equal(listAlbum(db, fish.id).length, 0)
  assert.equal(getFish(db, fish.id)!.balance, 100)
  db.close()
})

// 8. 鱼不存在
test('takePhoto/orderSong：鱼不存在 → NOT_FOUND', async () => {
  const db = openDb(':memory:')
  await assert.rejects(
    () => takePhoto(db, 'f_nope', { scene: 'x', price: 5 }),
    (e: any) => e.code === 'NOT_FOUND',
  )
  await assert.rejects(
    () => orderSong(db, 'f_nope', { title: 'x', price: 5 }),
    (e: any) => e.code === 'NOT_FOUND',
  )
  db.close()
})

// 9. 相册不串鱼：只列自己的
test('listAlbum：只返回该鱼自己的作品', async () => {
  const db = openDb(':memory:')
  const a = createFish(db, { name: 'A', balance: 200 })
  const b = createFish(db, { name: 'B', balance: 200 })
  await takePhoto(db, a.id, { scene: 'A的照片', price: 10 }, 1000)
  await takePhoto(db, b.id, { scene: 'B的照片', price: 10 }, 1000)
  assert.deepEqual(listAlbum(db, a.id).map((e) => e.title), ['A的照片'])
  assert.deepEqual(listAlbum(db, b.id).map((e) => e.title), ['B的照片'])
  db.close()
})
