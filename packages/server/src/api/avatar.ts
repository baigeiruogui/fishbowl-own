// 程序化鱼头像：根据 fish.id 确定性生成渐变鱼形 SVG（鱼身/鳍/眼/气泡 + 名字首字点缀）。
// 同一 id 永远同一图案；不同 id 至少有 id 哈希标注与配色/布局差异。
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { getFish } from '../db/index.ts'
import type { DB } from '../db/index.ts'

export interface AvatarPalette {
  body1: string
  body2: string
  fin: string
  eye: string
  bubble: string
  bg: string
}

const PALETTES: AvatarPalette[] = [
  { body1: '#ff9a3c', body2: '#ffd27a', fin: '#ff6b6b', eye: '#20232a', bubble: '#bfe9ff', bg: '#eaf7ff' },
  { body1: '#3aa0ff', body2: '#8fe0ff', fin: '#2b6cb0', eye: '#0b2136', bubble: '#d6f5ff', bg: '#e9faff' },
  { body1: '#59c76a', body2: '#b8f2b0', fin: '#2f8f4e', eye: '#12331c', bubble: '#e6ffe0', bg: '#f0fff0' },
  { body1: '#b06bff', body2: '#e2c6ff', fin: '#6a2fb0', eye: '#221033', bubble: '#f3e6ff', bg: '#f8f0ff' },
  { body1: '#ff6b9a', body2: '#ffc2d6', fin: '#c0306a', eye: '#330b1a', bubble: '#ffe6ef', bg: '#fff0f5' },
  { body1: '#ffd23c', body2: '#fff2a8', fin: '#c69a00', eye: '#332a00', bubble: '#fffbdc', bg: '#fffdf0' },
  { body1: '#2fd0c5', body2: '#a6fff6', fin: '#128077', eye: '#063330', bubble: '#dcfffb', bg: '#effffd' },
  { body1: '#7a8bff', body2: '#c3ccff', fin: '#3d4ac0', eye: '#101633', bubble: '#e6eaff', bg: '#f2f4ff' },
]

/** FNV-1a 32bit 哈希（稳定，跨进程一致）。 */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** SVG 文本转义（& < > " '）。 */
export function escXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function avatarUrl(fishId: string): string {
  return `/api/public/fish/${encodeURIComponent(fishId)}/avatar.svg`
}

export interface AvatarInput {
  id: string
  name?: string | null
}

/** 生成确定性鱼头像 SVG。 */
export function genFishAvatarSvg(input: AvatarInput): string {
  const id = String(input.id ?? '')
  const name = typeof input.name === 'string' && input.name ? input.name : ''
  const h = hashString(id)
  const p = PALETTES[h % PALETTES.length]!
  const h2 = hashString(id + '#2')
  const h3 = hashString(id + '#3')
  // 鱼身微微倾斜、尾巴方向、气泡数量都由哈希决定
  const tilt = (h2 % 9) - 4 // -4..4
  const bubbleCount = 3 + (h3 % 3) // 3..5
  const first = name ? Array.from(name)[0]! : Array.from(id.replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, ''))[0] ?? '鱼'
  const label = escXml(first)

  let bubbles = ''
  for (let i = 0; i < bubbleCount; i++) {
    const bh = hashString(id + '#b' + i)
    const bx = 150 + (bh % 34)
    const by = 40 + ((bh >>> 8) % 90)
    const r = 3 + ((bh >>> 16) % 6)
    bubbles += `<circle cx="${bx}" cy="${by}" r="${r}" fill="${p.bubble}" opacity="0.75"/>`
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" role="img" aria-label="fish avatar">
  <!-- fishId:${escXml(id)} palette:${h % PALETTES.length} -->
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p.body1}"/>
      <stop offset="100%" stop-color="${p.body2}"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" rx="24" fill="${p.bg}"/>
  <g transform="translate(100 108) rotate(${tilt})">
    <path d="M -58 0 L -96 -30 L -96 30 Z" fill="${p.fin}" opacity="0.9"/>
    <ellipse cx="0" cy="0" rx="72" ry="46" fill="url(#body)" stroke="${p.fin}" stroke-width="2"/>
    <path d="M -6 -44 Q 12 -70 34 -46 Q 14 -38 6 -40 Z" fill="${p.fin}" opacity="0.85"/>
    <circle cx="38" cy="-10" r="8" fill="${p.eye}"/>
    <circle cx="41" cy="-13" r="2.6" fill="#ffffff"/>
    <path d="M 46 10 q 14 6 26 0" fill="none" stroke="${p.fin}" stroke-width="2.4" stroke-linecap="round"/>
  </g>
  ${bubbles}
  <g>
    <circle cx="52" cy="150" r="18" fill="${p.body1}" opacity="0.95"/>
    <text x="52" y="157" font-family="sans-serif" font-size="20" font-weight="700" fill="#ffffff" text-anchor="middle">${label}</text>
  </g>
</svg>`
}

export interface AvatarDeps {
  db: DB
}

export const avatarRoutes: FastifyPluginAsync<AvatarDeps> = async (app: FastifyInstance, opts) => {
  const { db } = opts
  app.get(
    '/fish/:id/avatar.svg',
    (req, reply) => {
      const { id } = req.params as { id: string }
      const fish = getFish(db, id)
      const svg = genFishAvatarSvg({ id, name: fish?.name ?? null })
      return reply
        .header('Content-Type', 'image/svg+xml; charset=utf-8')
        .header('Cache-Control', 'public, max-age=86400, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
        .send(svg)
    },
  )
}

export default avatarRoutes
