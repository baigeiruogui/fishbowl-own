// 静态托管：若 packages/web/dist 存在，在 '/' 提供 index.html 与静态资源（同源，SPA 回退）。
// 说明：本机未安装 @fastify/static，这里用 node:fs 实现等价能力（不引入新依赖，保持 inScope）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function sendFile(reply: FastifyReply, file: string) {
  return reply.type(mimeFor(file)).send(readFileSync(file))
}

/** 在 app 上挂静态托管（用 notFound 兜底：只对非 /api、/town 的 GET 生效，SPA 回退到 index.html）。 */
export function registerStatic(app: FastifyInstance, dir: string): void {
  const root = resolve(dir)
  const indexPath = join(root, 'index.html')

  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ ok: false, error: 'NOT_FOUND' })
    }
    let pathname = '/'
    try {
      pathname = decodeURIComponent((req.raw.url ?? '/').split('?')[0])
    } catch {
      pathname = (req.raw.url ?? '/').split('?')[0]
    }
    if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/town' || pathname.startsWith('/town/')) {
      return reply.code(404).send({ ok: false, error: 'NOT_FOUND' })
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const file = resolve(root, rel)
    if (file !== root && file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
      return sendFile(reply, file)
    }
    // SPA 回退：未知前端路由都回 index.html
    if (existsSync(indexPath)) return sendFile(reply, indexPath)
    return reply.code(404).send({ ok: false, error: 'NOT_FOUND' })
  })
}
