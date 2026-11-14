// 媒体领域（画铺 / 拍照 / 点歌 / 相册）。
// 金额一律走 account.spend（内部 postLedger，reason='social'）；图片/音频由可插拔 MediaProvider 产出：
// - 无任何配置 → 程序化 provider（增强版 SVG，无网络依赖）
// - 配了 IMAGE_GEN_URL / SONG_URL → 真实出图/点歌，失败自动回落程序化，绝不崩
// album 表由本模块按需 CREATE TABLE IF NOT EXISTS 建立（不改 schema.sql）。
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getFish, newId, tx } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { asDomainError, assertPositiveInt, DomainError } from './errors.ts'
import { spend } from './account.ts'
import {
  extFromMime,
  generateImageWithFallback,
  generateSongAudio,
  isValidMedia,
  mimeFromPath,
  resolveMediaProvider,
} from './media-provider.ts'
import type { MediaBytes, MediaProvider } from './media-provider.ts'

export type MediaKind = 'photo' | 'painting' | 'song'

export interface AlbumEntry {
  id: string
  fishId: string
  kind: MediaKind | string
  title: string
  path: string | null
  price: number
  ts: number
  /** 由文件路径推断的 MIME（song 仅记录/无文件时为 null） */
  mime: string | null
  data: Record<string, unknown>
}

export interface AlbumFileResult {
  entry: AlbumEntry
  /** SVG 文本（仅图片为 SVG 时非空；二进制图片/音频为 null） */
  svg: string | null
  /** 原始文件字节（文件存在时非空） */
  bytes: Uint8Array | null
  /** 服务的 Content-Type（无文件时 null） */
  mime: string | null
}

interface AlbumRow {
  id: string
  fish_id: string
  kind: string
  title: string
  path: string | null
  price: number
  ts: number
  data_json: string
}

const ensured = new WeakSet<object>()

function ensureAlbumTable(db: DB): void {
  if (ensured.has(db as unknown as object)) return
  db.exec(
    `CREATE TABLE IF NOT EXISTS album(
       id TEXT PRIMARY KEY,
       fish_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       title TEXT NOT NULL DEFAULT '',
       path TEXT,
       price INTEGER NOT NULL DEFAULT 0,
       ts INTEGER NOT NULL,
       data_json TEXT NOT NULL DEFAULT '{}'
     );`,
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_album_fish ON album(fish_id, id);')
  ensured.add(db as unknown as object)
}

function albumDir(): string {
  return resolve(process.env.ALBUM_DIR || 'data/album')
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 生成一幅占位场景 SVG（纯字符串，无外部依赖）。保留给 seed / 老调用方。 */
export function genSceneSvg(input: { scene: string; title: string; fishName: string; ts: number }): string {
  const scene = esc(input?.scene ?? '')
  const title = esc(input?.title ?? '')
  const fishName = esc(input?.fishName ?? '')
  const when = new Date(Number(input?.ts) || Date.now()).toISOString()
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0b3d5c"/>
      <stop offset="100%" stop-color="#0f6c8c"/>
    </linearGradient>
  </defs>
  <rect width="640" height="400" fill="url(#bg)"/>
  <circle cx="120" cy="90" r="46" fill="#ffe08a" opacity="0.85"/>
  <text x="320" y="170" fill="#ffffff" font-size="30" font-family="sans-serif" text-anchor="middle">${title}</text>
  <text x="320" y="220" fill="#cfefff" font-size="20" font-family="sans-serif" text-anchor="middle">${scene}</text>
  <text x="320" y="330" fill="#a9d8ea" font-size="16" font-family="sans-serif" text-anchor="middle">by ${fishName} · ${esc(when)}</text>
</svg>`
}

function toEntry(r: AlbumRow): AlbumEntry {
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(r.data_json || '{}') as Record<string, unknown>
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    fishId: r.fish_id,
    kind: r.kind,
    title: r.title,
    path: r.path,
    price: Number(r.price),
    ts: Number(r.ts),
    mime: r.path ? mimeFromPath(r.path) : null,
    data,
  }
}

function rowById(db: DB, id: string): AlbumRow | undefined {
  return db.prepare('SELECT * FROM album WHERE id = ?').get(id) as unknown as AlbumRow | undefined
}

interface CreateMediaArgs {
  kind: MediaKind
  title: string
  price: number
  now: number
  /** 图片场景描述（photo/painting 用）；song 不需要 */
  scene?: string
  /** 指定 provider（测试注入）；缺省按 env 解析 */
  provider?: MediaProvider
}

async function createMedia(db: DB, fishId: string, args: CreateMediaArgs): Promise<AlbumEntry> {
  const price = assertPositiveInt(args.price, 'price')
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title === '') throw new DomainError('BAD_REQUEST', 'title is required')
  ensureAlbumTable(db) // 建表放在事务外，避免事务回滚把 DDL 一起回滚

  // 先在事务外读鱼 + 做余额预检：既避免余额不足时白跑一次外部生成，也保证「失败无副作用」。
  const fish = getFish(db, fishId)
  if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
  if (fish.balance < price) throw new DomainError('INSUFFICIENT', 'insufficient balance', { balance: fish.balance })

  const provider = args.provider ?? resolveMediaProvider()
  const id = newId('album')
  let generated: MediaBytes | null = null
  try {
    if (args.kind === 'song') {
      // 点歌：有真实音频就存文件；没有就仅记录（path=null）
      generated = await generateSongAudio(provider, { title })
    } else {
      // 拍照 / 画作：provider 失败会回落程序化 SVG，保证一定有可读图片
      generated = await generateImageWithFallback(provider, {
        prompt: args.scene ?? title,
        style: args.kind,
        title,
        fishName: fish.name,
        ts: args.now,
      })
    }
  } catch {
    // 双保险：provider 层已兜底，这里再兜一次，绝不让生成失败拖垮主流程
    generated = null
  }

  let filePath: string | null = null
  if (isValidMedia(generated)) {
    const target = join(albumDir(), id + extFromMime(generated.type))
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(generated.bytes))
      filePath = target
    } catch {
      // 写盘失败：退回「仅记录」，不留半截文件，也不崩
      try {
        if (existsSync(target)) unlinkSync(target)
      } catch {
        /* ignore */
      }
      filePath = null
    }
  }

  try {
    return tx(db, () => {
      const f = getFish(db, fishId)
      if (!f) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
      spend(db, fishId, price, 'social', id, args.now)
      const dataJson = JSON.stringify({
        scene: args.scene ?? title,
        title,
        fishName: f.name,
        provider: provider.name ?? 'unknown',
        mime: isValidMedia(generated) ? generated.type : null,
      })
      db.prepare(
        'INSERT INTO album(id, fish_id, kind, title, path, price, ts, data_json) VALUES(?,?,?,?,?,?,?,?)',
      ).run(id, fishId, args.kind, title, filePath, price, args.now, dataJson)
      return toEntry(rowById(db, id)!)
    })
  } catch (e) {
    // 扣费/插入失败：删掉刚写的文件，保证「失败无副作用」
    if (filePath && existsSync(filePath)) {
      try {
        unlinkSync(filePath)
      } catch {
        /* ignore */
      }
    }
    throw asDomainError(e)
  }
}

/** 拍照：扣费（默认 25）+ provider 出图 + 记入相册（kind='photo'）。 */
export async function takePhoto(
  db: DB,
  fishId: string,
  input: { scene: string; price?: number },
  now: number = Date.now(),
  provider?: MediaProvider,
): Promise<AlbumEntry> {
  if (typeof input?.scene !== 'string' || input.scene.trim() === '') {
    throw new DomainError('BAD_REQUEST', 'scene is required')
  }
  return createMedia(db, fishId, {
    kind: 'photo',
    title: input.scene.trim(),
    price: input.price ?? 25,
    scene: input.scene.trim(),
    now,
    provider,
  })
}

/** 点歌：扣费（默认 50）+ provider 有音频则存音频文件（kind='song'），否则仅记录。 */
export async function orderSong(
  db: DB,
  fishId: string,
  input: { title: string; price?: number },
  now: number = Date.now(),
  provider?: MediaProvider,
): Promise<AlbumEntry> {
  return createMedia(db, fishId, {
    kind: 'song',
    title: input?.title,
    price: input.price ?? 50,
    now,
    provider,
  })
}

/** 画铺：订画：扣费 + provider 出图 + 记入相册（kind='painting'）。 */
export async function addPainting(
  db: DB,
  fishId: string,
  input: { title: string; price: number },
  now: number = Date.now(),
  provider?: MediaProvider,
): Promise<AlbumEntry> {
  return createMedia(db, fishId, {
    kind: 'painting',
    title: input?.title,
    price: input.price,
    now,
    provider,
  })
}

/** 相册：某条鱼的作品列表（时间倒序，默认 20，上限 200）。 */
export function listAlbum(db: DB, fishId: string, limit = 20): AlbumEntry[] {
  ensureAlbumTable(db)
  const n = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 20
  const rows = db
    .prepare('SELECT * FROM album WHERE fish_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(fishId, n) as unknown as AlbumRow[]
  return rows.map(toEntry)
}

/** 取相册条目 + 文件内容（bytes/mime；SVG 额外给文本）。不存在返回 null。 */
export function getAlbumFile(db: DB, id: string): AlbumFileResult | null {
  ensureAlbumTable(db)
  const row = rowById(db, id)
  if (!row) return null
  const entry = toEntry(row)
  const mime = entry.path ? mimeFromPath(entry.path) : null
  let bytes: Uint8Array | null = null
  let svg: string | null = null
  if (entry.path && existsSync(entry.path)) {
    try {
      const buf = readFileSync(entry.path)
      bytes = new Uint8Array(buf)
      if (mime && mime.includes('svg')) svg = buf.toString('utf8')
    } catch {
      bytes = null
      svg = null
    }
  }
  return { entry, svg, bytes, mime }
}
