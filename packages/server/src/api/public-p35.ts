// P3.5 公开只读：相册 / 画铺 gallery / 夸夸群 / 相册文件（SVG，防路径穿越）。
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { DB } from '../db/index.ts'
import { DomainError } from '../domain/errors.ts'
import { sendError } from './common.ts'
import { getAlbumFile, listAlbum } from '../domain/media.ts'
import { listBless } from '../domain/bless.ts'

export interface PublicP35Deps {
  db: DB
  now?: () => number
}

const ALBUM_ID_RE = /^album_[0-9a-f]{16}$/

function albumDir(): string {
  return resolve(process.env.ALBUM_DIR || 'data/album')
}

interface GalleryRow {
  id: string
  title: string
  scene: string
  path: string | null
  created_at: number
}

export const publicP35Routes: FastifyPluginAsync<PublicP35Deps> = async (app: FastifyInstance, opts) => {
  const { db } = opts

  const pub = (fn: (req: FastifyRequest, reply: FastifyReply) => unknown) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply)
      } catch (e) {
        return sendError(reply, e)
      }
    }
  }

  // 某条鱼的相册（?fishId=&limit=）
  app.get(
    '/album',
    pub((req) => {
      const q = req.query as Record<string, string | undefined>
      const fishId = q.fishId ?? ''
      if (!fishId) return { ok: true, album: [] }
      const limit = q.limit ? Number(q.limit) : 20
      return { ok: true, fishId, album: listAlbum(db, fishId, limit) }
    }),
  )

  // 画铺 gallery（种子生成）
  app.get(
    '/gallery',
    pub(() => {
      let rows: GalleryRow[] = []
      try {
        rows = db.prepare('SELECT id, title, scene, path, created_at FROM gallery ORDER BY created_at ASC, id ASC').all() as unknown as GalleryRow[]
      } catch {
        rows = []
      }
      return { ok: true, gallery: rows.map((r) => ({ id: r.id, title: r.title, scene: r.scene, path: r.path, createdAt: Number(r.created_at) })) }
    }),
  )

  // 夸夸群列表
  app.get(
    '/bless',
    pub((req) => {
      const q = req.query as Record<string, string | undefined>
      const limit = q.limit ? Number(q.limit) : 20
      return { ok: true, bless: listBless(db, limit) }
    }),
  )

  // 相册文件（图片 SVG/PNG… 或点歌音频 audio/mpeg）：
  // 严格校验 id 形态 + 读取路径必须在 album 目录内（防路径穿越），按文件扩展名回正确 Content-Type。
  app.get(
    '/album/:id/file',
    pub((req, reply) => {
      const { id } = req.params as { id: string }
      if (!ALBUM_ID_RE.test(id)) throw new DomainError('BAD_REQUEST', 'invalid album id')
      const found = getAlbumFile(db, id)
      if (!found) throw new DomainError('NOT_FOUND', `album not found: ${id}`)
      if (!found.entry.path) throw new DomainError('NOT_FOUND', `album file missing: ${id}`)
      const root = albumDir()
      const abs = resolve(found.entry.path)
      if (abs !== root && !abs.startsWith(root + sep)) {
        throw new DomainError('CONFLICT', 'blocked: album path escapes album dir')
      }
      if (!existsSync(abs)) throw new DomainError('NOT_FOUND', `album file missing: ${id}`)
      if (!found.bytes) throw new DomainError('NOT_FOUND', `album file missing: ${id}`)
      const mime = found.mime ?? 'application/octet-stream'
      // 安全头（M1 存储型 XSS）：nosniff 阻止浏览器把内容当别的类型执行；
      // SVG 可以被脚本化，额外上 CSP 禁掉一切外部加载/脚本（只允许内联 style）。
      reply.header('X-Content-Type-Options', 'nosniff')
      if (mime.includes('svg')) {
        reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      }
      return reply.type(mime).send(Buffer.from(found.bytes))
    }),
  )
}

export default publicP35Routes
