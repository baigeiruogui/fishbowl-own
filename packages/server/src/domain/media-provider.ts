// 可插拔媒体生成 provider。
//
// 设计目标：
// - **零外部依赖也能跑**：默认 provider 用纯字符串生成增强版 SVG（渐变 + 场景元素 + 文字），全程无网络。
// - **配置了外部服务就用真的**：`IMAGE_GEN_URL` / `IMAGE_GEN_KEY` 配好 → 走 OpenAI 兼容 images 接口
//   （或自定义 endpoint）；`SONG_URL` 配好 → 拉真实音频。
// - **绝不崩**：所有外部调用带超时 + 大小上限，任何异常/超限都返回 null，由上层回落程序化，不抛出。
// - **key 不进日志**：key 只放进请求头，任何错误/异常都不打印 URL query、header 或 key。
//
// provider 只负责「产字节」，不碰数据库、不扣费、不写盘——这些都在 media.ts 里完成。
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export interface MediaBytes {
  /** 媒体二进制（SVG 文本也编码成 UTF-8 字节） */
  bytes: Uint8Array
  /** MIME 类型，如 `image/svg+xml; charset=utf-8` / `image/png` / `audio/mpeg` */
  type: string
}

export interface GenImageInput {
  /** 画面描述（必填）。外部 provider 会据此拼提示词。 */
  prompt: string
  /** 风格提示（photo / painting / 自定义） */
  style?: string
  /** 可选：标题，供程序化 SVG 渲染与提示词使用 */
  title?: string
  /** 可选：出图鱼的昵称，供程序化 SVG 落款 */
  fishName?: string
  /** 可选：生成时间戳（ms），供程序化 SVG 落款；缺省用当前时间 */
  ts?: number
}

export interface GenSongInput {
  title: string
}

/**
 * 媒体生成 provider。方法可同步或异步返回；返回 `null` 表示「本 provider 不产此类媒体 / 生成失败」，
 * 由上层决定回落（图片回落程序化 SVG；歌曲回落「仅记录不存文件」）。
 */
export interface MediaProvider {
  readonly name?: string
  genImage(input: GenImageInput): Promise<MediaBytes | null> | MediaBytes | null
  genSong(input: GenSongInput): Promise<MediaBytes | null> | MediaBytes | null
}

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 // 8 MiB
const MAX_MAX_BYTES = 32 * 1024 * 1024 // 32 MiB 硬上限

function envInt(env: NodeJS.ProcessEnv, keys: string[], dflt: number, cap: number): number {
  for (const k of keys) {
    const raw = env[k]
    if (raw === undefined || raw === '') continue
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), cap)
  }
  return dflt
}

function timeoutMs(env: NodeJS.ProcessEnv): number {
  return envInt(env, ['MEDIA_TIMEOUT_MS', 'IMAGE_GEN_TIMEOUT_MS', 'SONG_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

function maxBytes(env: NodeJS.ProcessEnv): number {
  return envInt(env, ['MEDIA_MAX_BYTES'], DEFAULT_MAX_BYTES, MAX_MAX_BYTES)
}

// ---------------------------------------------------------------------------
// 程序化 provider（默认，零依赖、无网络）
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** 简单确定性伪随机：同一 seed 每次生成同一张图（便于回归测试 / 缓存）。 */
function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

interface Palette {
  skyTop: string
  skyBottom: string
  sun: string
  accent: string
  water: string
}

const PALETTES: Palette[] = [
  { skyTop: '#0b3d5c', skyBottom: '#0f6c8c', sun: '#ffe08a', accent: '#7fe3c4', water: '#0a2f47' },
  { skyTop: '#2b1055', skyBottom: '#7597de', sun: '#ffd6a5', accent: '#c792ea', water: '#1c1240' },
  { skyTop: '#134e5e', skyBottom: '#71b280', sun: '#fddb92', accent: '#8ff7c0', water: '#0d3a44' },
  { skyTop: '#141e30', skyBottom: '#243b55', sun: '#f7b733', accent: '#4facfe', water: '#0a1420' },
  { skyTop: '#3a1c71', skyBottom: '#d76d77', sun: '#ffd86f', accent: '#ffaf7b', water: '#2a1450' },
]

/**
 * 生成一幅增强版场景 SVG：多段渐变天空 + 光晕日月 + 水面波光 + 泡泡 + 鱼 + 水草 + 文字面板。
 * 纯字符串拼接、无外部依赖。所有用户输入都会转义，不会破坏 XML。
 */
export function renderProgrammaticSvg(input: GenImageInput): string {
  const prompt = String(input?.prompt ?? '')
  const title = clip(esc(input?.title ?? prompt ?? '鱼缸小镇'), 36)
  const scene = clip(esc(prompt), 46)
  const fishName = clip(esc(input?.fishName ?? ''), 24)
  const style = clip(esc(input?.style ?? ''), 16)
  const when = new Date(Number(input?.ts) || Date.now()).toISOString()

  const seed = hashStr(prompt + '|' + (input?.style ?? '') + '|' + (input?.fishName ?? ''))
  const rng = makeRng(seed)
  const pal = PALETTES[seed % PALETTES.length]

  const sunX = 110 + Math.round(rng() * 420)
  const sunY = 70 + Math.round(rng() * 60)
  const fishX = 250 + Math.round(rng() * 120)
  const fishY = 300 + Math.round(rng() * 30) - 40
  const flip = rng() > 0.5 ? 1 : -1

  const bubbles: string[] = []
  for (let i = 0; i < 14; i++) {
    const cx = Math.round(rng() * 620) + 10
    const cy = 40 + Math.round(rng() * 240)
    const r = 2 + Math.round(rng() * 7)
    const o = (0.08 + rng() * 0.18).toFixed(2)
    bubbles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff" opacity="${o}"/>`)
  }

  const waves: string[] = []
  for (let i = 0; i < 4; i++) {
    const y = 262 + i * 20
    waves.push(
      `<path d="M-40 ${y} q40 -9 80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0" fill="none" stroke="${pal.accent}" stroke-width="1.5" opacity="${(0.22 - i * 0.04).toFixed(2)}"/>`,
    )
  }

  const weeds: string[] = []
  for (let i = 0; i < 5; i++) {
    const x = 30 + i * 130 + Math.round(rng() * 30)
    const h = 70 + Math.round(rng() * 90)
    weeds.push(
      `<path d="M${x} 400 q-16 -${Math.round(h / 2)} 4 -${h} q16 ${Math.round(h / 2)} -2 ${h}" fill="${pal.accent}" opacity="${(0.18 + rng() * 0.16).toFixed(2)}"/>`,
    )
  }

  const styleChip = style ? `<text x="596" y="46" text-anchor="end" fill="#ffffff" font-size="13" font-family="sans-serif" opacity="0.8">#${style}</text>` : ''
  const footer = [fishName ? `by ${fishName}` : '', when].filter(Boolean).join(' · ')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400" role="img" aria-label="${title}">
  <title>${title}</title>
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${pal.skyTop}"/>
      <stop offset="100%" stop-color="${pal.skyBottom}"/>
    </linearGradient>
    <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${pal.accent}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${pal.water}" stop-opacity="0.98"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${pal.sun}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${pal.sun}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="frame"><rect x="0" y="0" width="640" height="400" rx="18"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <rect x="0" y="0" width="640" height="400" fill="url(#sky)"/>
    <circle cx="${sunX}" cy="${sunY}" r="92" fill="url(#glow)"/>
    <circle cx="${sunX}" cy="${sunY}" r="${28 + Math.round(rng() * 10)}" fill="${pal.sun}" opacity="0.92"/>
    <rect x="0" y="250" width="640" height="150" fill="url(#water)"/>
    <path d="M0 250 Q160 238 320 250 T640 250 L640 260 L0 260 Z" fill="#ffffff" opacity="0.16"/>
    ${waves.join('\n    ')}
    ${weeds.join('\n    ')}
    ${bubbles.join('\n    ')}
    <g transform="translate(${fishX},${fishY}) scale(${flip},1)">
      <ellipse cx="0" cy="0" rx="62" ry="33" fill="${pal.accent}" opacity="0.92"/>
      <path d="M-58 0 L-108 -26 L-94 0 L-108 26 Z" fill="${pal.accent}" opacity="0.92"/>
      <path d="M-4 -32 q12 16 0 32" fill="none" stroke="${pal.skyTop}" stroke-width="3" opacity="0.5"/>
      <circle cx="30" cy="-8" r="8" fill="#0b1220"/>
      <circle cx="33" cy="-11" r="2.6" fill="#ffffff"/>
    </g>
  </g>
  <rect x="6" y="6" width="628" height="388" rx="14" fill="none" stroke="#ffffff" stroke-opacity="0.25"/>
  ${styleChip}
  <rect x="24" y="286" width="592" height="92" rx="12" fill="#03060b" opacity="0.42"/>
  <text x="44" y="321" fill="#ffffff" font-size="25" font-weight="600" font-family="sans-serif">${title}</text>
  <text x="44" y="350" fill="#dff3ff" font-size="16" font-family="sans-serif">${scene}</text>
  <text x="44" y="371" fill="#a9d8ea" font-size="12" font-family="sans-serif">${esc(footer)}</text>
</svg>`
}

/** 默认程序化 provider：生成增强版 SVG；点歌不产音频（返回 null → 仅记录）。 */
export const programmaticProvider: MediaProvider = {
  name: 'programmatic-svg',
  genImage(input: GenImageInput): MediaBytes {
    const svg = renderProgrammaticSvg(input)
    return { bytes: new TextEncoder().encode(svg), type: 'image/svg+xml; charset=utf-8' }
  },
  genSong(): null {
    return null
  },
}

// ---------------------------------------------------------------------------
// HTTP provider（配置了外部服务才启用）
// ---------------------------------------------------------------------------

interface FetchedMedia {
  bytes: Uint8Array
  type: string
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** 带超时 + 流式大小上限的 fetch；任何失败都返回 null（不抛、不打印敏感信息）。 */
async function fetchCapped(url: string, init: RequestInit, env: NodeJS.ProcessEnv): Promise<FetchedMedia | null> {
  const controller = new AbortController()
  const ms = timeoutMs(env)
  const limit = maxBytes(env)
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) return null
    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) return null

    const body = res.body as unknown as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null
    let bytes: Uint8Array
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > limit) {
          try {
            await reader.cancel()
          } catch {
            /* ignore */
          }
          return null
        }
        chunks.push(value)
      }
      bytes = concatChunks(chunks, total)
    } else {
      bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength > limit) return null
    }
    if (bytes.byteLength === 0) return null
    return { bytes, type: ct || 'application/octet-stream' }
  } catch {
    // 超时 / DNS / 连接错误 / 解析错误：统一回落
    return null
  } finally {
    clearTimeout(timer)
  }
}

function sniffImageType(bytes: Uint8Array): string {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  const head = new TextDecoder().decode(b.subarray(0, Math.min(256, b.length))).trimStart().toLowerCase()
  if (head.startsWith('<svg') || head.includes('<svg')) return 'image/svg+xml; charset=utf-8'
  return ''
}

function sniffAudioType(bytes: Uint8Array): string {
  const b = bytes
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg' // ID3
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg' // MPEG frame
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav'
  if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg'
  return ''
}

function base64ToBytes(s: string): Uint8Array | null {
  try {
    const clean = s.includes(',') ? s.slice(s.indexOf(',') + 1) : s
    const buf = Buffer.from(clean, 'base64')
    return buf.byteLength > 0 ? new Uint8Array(buf) : null
  } catch {
    return null
  }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

// --- 外部媒体类型白名单（M1：外部只允许栅格图 / 常见音频；svg/xml 一律拒绝，防存储型 XSS）---
const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
])

function baseType(type: unknown): string {
  return String(type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

/** 是否是 XML/SVG 类（存储型 XSS 风险源，外部一律拒绝）。 */
function isXmlLike(type: unknown): boolean {
  const t = baseType(type)
  return t.includes('svg') || t === 'application/xml' || t === 'text/xml' || t.endsWith('+xml')
}

function isAllowedRasterImage(type: unknown): boolean {
  const t = baseType(type)
  return !isXmlLike(t) && RASTER_IMAGE_TYPES.has(t)
}

function isAllowedAudio(type: unknown): boolean {
  const t = baseType(type)
  return !isXmlLike(t) && ALLOWED_AUDIO_TYPES.has(t)
}

/** 解码一个内联图片项（string b64 / data-url / {b64|bytes|image} 对象）。只放行栅格图。 */
function decodeInlineImage(item: unknown): MediaBytes | null {
  if (typeof item === 'string' && item.trim()) {
    const m = /^data:([^;,]+)[^,]*,/i.exec(item.trim())
    const declared = m ? baseType(m[1]) : ''
    const bytes = base64ToBytes(item)
    if (!bytes) return null
    if (declared) return isAllowedRasterImage(declared) ? { bytes, type: declared } : null
    const sniffed = baseType(sniffImageType(bytes))
    return isAllowedRasterImage(sniffed) ? { bytes, type: sniffed } : null
  }
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>
    const b64 = pickString(o, ['b64_json', 'b64', 'base64', 'bytes', 'image'])
    if (!b64) return null
    const bytes = base64ToBytes(b64)
    if (!bytes) return null
    const stated = baseType(pickString(o, ['mime_type', 'type', 'content_type']) ?? '')
    if (stated) return isAllowedRasterImage(stated) ? { bytes, type: stated } : null
    const sniffed = baseType(sniffImageType(bytes))
    return isAllowedRasterImage(sniffed) ? { bytes, type: sniffed } : null
  }
  return null
}

/**
 * 把图片接口响应解析成 {bytes,type}。
 *
 * 安全约束（H1 SSRF + M1 存储型 XSS）：
 * - **绝不跟随响应里出现的 url / image_url**：这类 URL 由不可信的外部服务提供，服务端若去 fetch 会变成 SSRF
 *   （打 127/内网/169.254 云元数据）。这里只接受内联 b64/bytes；纯 URL 一律忽略 → 返回 null（上层回落程序化）。
 * - **只接受栅格图**（png/jpeg/webp）；声明或嗅探为 svg/xml 的一律拒绝。
 */
async function interpretImageResponse(res: FetchedMedia): Promise<MediaBytes | null> {
  const ct = baseType(res.type)
  // 1) 直出图片字节 / 未标明类型：只放行栅格图，svg/xml 拒绝
  if (ct.startsWith('image/') || ct === 'application/octet-stream') {
    if (isAllowedRasterImage(ct)) return { bytes: res.bytes, type: ct }
    if (ct === 'application/octet-stream') {
      const sniffed = baseType(sniffImageType(res.bytes))
      if (isAllowedRasterImage(sniffed)) return { bytes: res.bytes, type: sniffed }
    }
    return null
  }
  // 2) 其余按 JSON 解析；不是 JSON 就嗅探
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(res.bytes))
  } catch {
    const sniffed = baseType(sniffImageType(res.bytes))
    return isAllowedRasterImage(sniffed) ? { bytes: res.bytes, type: sniffed } : null
  }
  if (!json || typeof json !== 'object') return null
  const root = json as Record<string, unknown>
  const firstData = Array.isArray(root.data) ? (root.data[0] as Record<string, unknown> | undefined) : undefined
  const candidates: Record<string, unknown>[] = []
  if (firstData && typeof firstData === 'object') candidates.push(firstData)
  candidates.push(root)

  // A1111 / 自定义服务常见的 `{ images: ["<b64 png>", ...] }`：取第一张可用的内联图；
  // url 项一律忽略（不 fetch，防 SSRF）。
  const imagesSource = Array.isArray(root.images)
    ? (root.images as unknown[])
    : firstData && Array.isArray((firstData as Record<string, unknown>).images)
      ? ((firstData as Record<string, unknown>).images as unknown[])
      : undefined
  if (imagesSource) {
    for (const item of imagesSource) {
      const parsed = decodeInlineImage(item)
      if (parsed) return parsed
    }
    return null
  }

  for (const c of candidates) {
    // 只认内联 b64/bytes；url / image_url 一律忽略（不 fetch，防 SSRF）
    const b64 = pickString(c, ['b64_json', 'b64', 'base64', 'image', 'bytes'])
    if (!b64) continue
    const bytes = base64ToBytes(b64)
    if (!bytes) continue
    const stated = baseType(pickString(c, ['mime_type', 'type', 'content_type']) ?? '')
    if (stated) {
      // 明确声明了类型：只放行栅格图，svg/xml 或其它一律拒绝
      return isAllowedRasterImage(stated) ? { bytes, type: stated } : null
    }
    const sniffed = baseType(sniffImageType(bytes))
    return isAllowedRasterImage(sniffed) ? { bytes, type: sniffed } : null
  }
  return null
}

/**
 * 把点歌接口响应解析成 {bytes,type}。
 *
 * 安全约束同图片：**绝不跟随响应里的 url / audio_url**（SSRF），只接受内联 b64/bytes；
 * 只接受常见音频类型，svg/xml 一律拒绝。
 */
async function interpretAudioResponse(res: FetchedMedia): Promise<MediaBytes | null> {
  const ct = baseType(res.type)
  if (ct.startsWith('audio/')) {
    return isAllowedAudio(ct) ? { bytes: res.bytes, type: ct } : null
  }
  if (ct === 'application/octet-stream') {
    const sniffed = baseType(sniffAudioType(res.bytes))
    return isAllowedAudio(sniffed) ? { bytes: res.bytes, type: sniffed } : null
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(res.bytes))
  } catch {
    const sniffed = baseType(sniffAudioType(res.bytes))
    return isAllowedAudio(sniffed) ? { bytes: res.bytes, type: sniffed } : null
  }
  if (!json || typeof json !== 'object') return null
  const root = json as Record<string, unknown>
  const candidates: Record<string, unknown>[] =
    Array.isArray(root.data) && root.data[0] && typeof root.data[0] === 'object'
      ? [root.data[0] as Record<string, unknown>, root]
      : [root]
  for (const c of candidates) {
    // 只认内联 b64/bytes；url / audio_url 一律忽略（不 fetch，防 SSRF）
    const b64 = pickString(c, ['b64_json', 'b64', 'base64', 'audio', 'bytes'])
    if (!b64) continue
    const bytes = base64ToBytes(b64)
    if (!bytes) continue
    const stated = baseType(pickString(c, ['mime_type', 'type', 'content_type']) ?? '')
    if (stated) {
      return isAllowedAudio(stated) ? { bytes, type: stated } : null
    }
    const sniffed = baseType(sniffAudioType(bytes))
    return isAllowedAudio(sniffed) ? { bytes, type: sniffed } : null
  }
  return null
}

function buildImagePrompt(input: GenImageInput): string {
  const parts: string[] = []
  if (input.title && input.title !== input.prompt) parts.push(input.title)
  if (input.prompt) parts.push(input.prompt)
  if (input.style) parts.push(`style: ${input.style}`)
  return parts.filter(Boolean).join(' — ') || 'a fish in a cozy fishbowl town'
}

function appendQuery(url: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  return url + (url.includes('?') ? '&' : '?') + qs
}

// ---------------------------------------------------------------------------
// ComfyUI（/prompt → /history/{id} → /view 文生图）
// ---------------------------------------------------------------------------

/** ComfyUI API 格式的内置默认 txt2img 工作流（checkpoint→CLIP 正负→latent→KSampler→VAEDecode→SaveImage）。 */
export function defaultComfyWorkflow(opts: {
  ckpt: string
  positive: string
  negative: string
  width: number
  height: number
  steps: number
  cfg: number
  sampler: string
  seed: number
}): Record<string, unknown> {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: opts.seed,
        steps: opts.steps,
        cfg: opts.cfg,
        sampler_name: opts.sampler || 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: opts.ckpt } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: opts.width, height: opts.height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: opts.positive, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: opts.negative, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'fishbowl', images: ['8', 0] } },
  }
}

/**
 * 把正向提示词注入到工作流里「正向 CLIPTextEncode」的 text。
 * 定位顺序：显式 IMAGE_GEN_PROMPT_NODE → 约定节点 '6'（内置模板/多数默认工作流）
 *          → 采样器（KSampler*）的 inputs.positive 指向的节点（最稳） → 第一个 CLIPTextEncode。
 */
export function injectComfyPrompt(workflow: Record<string, unknown>, prompt: string, nodeId?: string): Record<string, unknown> {
  const nodes = workflow as Record<string, any>
  let target: string | undefined = nodeId && nodes[nodeId] ? nodeId : undefined
  if (!target && nodes['6'] && nodes['6'].class_type === 'CLIPTextEncode') target = '6'
  if (!target) {
    // 从采样器的 positive 连接找正向节点
    for (const n of Object.values(nodes)) {
      if (!n || typeof n !== 'object') continue
      const ct = (n as any).class_type
      const isSampler = (typeof ct === 'string' && ct.includes('KSampler')) || ct === 'SamplerCustom'
      if (!isSampler) continue
      const link = (n as any).inputs?.positive
      if (Array.isArray(link) && typeof link[0] === 'string' && nodes[link[0]]) {
        target = link[0]
        break
      }
    }
  }
  if (!target) {
    for (const [id, n] of Object.entries(nodes)) {
      if (n && typeof n === 'object' && (n as any).class_type === 'CLIPTextEncode') {
        target = id
        break
      }
    }
  }
  if (target && nodes[target]) {
    const n = nodes[target]
    n.inputs = n.inputs && typeof n.inputs === 'object' ? n.inputs : {}
    n.inputs.text = prompt
  }
  return workflow
}

function loadComfyWorkflowOverride(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const file = (env.IMAGE_GEN_WORKFLOW ?? '').trim()
  if (!file) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    // 覆盖文件读/解析失败：回落内置默认模板，不崩
    return null
  }
}

interface ComfyImageRef {
  filename: string
  subfolder: string
  type: string
}

/** 从 /history 响应里找第一张图（outputs[*].images[{filename,subfolder,type}]）。 */
function extractComfyImage(bytes: Uint8Array): ComfyImageRef | null {
  let json: any
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const scan = (entry: any): ComfyImageRef | null => {
    const outputs = entry?.outputs
    if (!outputs || typeof outputs !== 'object') return null
    for (const node of Object.values(outputs) as any[]) {
      const images = node?.images
      if (!Array.isArray(images)) continue
      for (const im of images) {
        if (im && typeof im.filename === 'string' && im.filename) {
          return {
            filename: im.filename,
            subfolder: typeof im.subfolder === 'string' ? im.subfolder : '',
            type: typeof im.type === 'string' ? im.type : 'output',
          }
        }
      }
    }
    return null
  }
  // 常见形状：{ "<prompt_id>": { outputs: {...} } }；也兼容直接 { outputs: {...} }
  const direct = scan(json)
  if (direct) return direct
  for (const v of Object.values(json)) {
    const r = scan(v)
    if (r) return r
  }
  return null
}

/**
 * ComfyUI 文生图：POST /prompt 提交工作流 → 轮询 /history/{prompt_id} 拿 outputs → GET /view 下载二进制。
 * 只在配置的 IMAGE_GEN_URL（本机/可信 ComfyUI）上请求；超时 = MEDIA_TIMEOUT_MS；只返回栅格图；失败返回 null。
 */
async function generateComfyImage(baseUrl: string, prompt: string, env: NodeJS.ProcessEnv, key: string): Promise<MediaBytes | null> {
  const base = baseUrl.replace(/\/+$/, '')
  const deadline = Date.now() + timeoutMs(env)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers.authorization = 'Bearer ' + key

  const steps = envInt(env, ['IMAGE_GEN_STEPS'], 20, 150)
  const width = envInt(env, ['IMAGE_GEN_WIDTH'], 512, 2048)
  const height = envInt(env, ['IMAGE_GEN_HEIGHT'], 512, 2048)
  const cfg = envInt(env, ['IMAGE_GEN_CFG'], 7, 30)
  const seed = envInt(env, ['IMAGE_GEN_SEED'], 0, 2_147_483_647) || Math.floor(Math.random() * 2_000_000_000)
  const ckpt = (env.IMAGE_GEN_CKPT ?? '').trim() || 'v1-5-pruned-emaonly.safetensors'
  const negative = (env.IMAGE_GEN_NEGATIVE ?? '').trim()
  const sampler = (env.IMAGE_GEN_SAMPLER ?? '').trim() || 'euler'

  // 工作流：IMAGE_GEN_WORKFLOW 覆盖文件优先，否则内置默认模板；随后注入正向提示词
  const workflow =
    loadComfyWorkflowOverride(env) ??
    defaultComfyWorkflow({ ckpt, positive: prompt, negative, width, height, steps, cfg, sampler, seed })
  injectComfyPrompt(workflow, prompt, (env.IMAGE_GEN_PROMPT_NODE ?? '').trim() || undefined)

  const clientId = randomBytes(8).toString('hex')
  const submit = await fetchCapped(
    `${base}/prompt`,
    { method: 'POST', headers, body: JSON.stringify({ prompt: workflow, client_id: clientId }) },
    env,
  )
  if (!submit) return null
  let promptId = ''
  try {
    const j = JSON.parse(new TextDecoder().decode(submit.bytes)) as Record<string, unknown>
    promptId = typeof j.prompt_id === 'string' ? j.prompt_id : ''
  } catch {
    return null
  }
  if (!promptId) return null

  // 轮询 history 直到 outputs 就绪或整体超时
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    const pollEnv: NodeJS.ProcessEnv = { ...env, MEDIA_TIMEOUT_MS: String(Math.max(200, Math.min(remaining, 5000))) }
    const hist = await fetchCapped(`${base}/history/${encodeURIComponent(promptId)}`, { method: 'GET', headers }, pollEnv)
    if (hist) {
      const ref = extractComfyImage(hist.bytes)
      if (ref) {
        const viewUrl = appendQuery(`${base}/view`, { filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
        const fileRes = await fetchCapped(viewUrl, { method: 'GET', headers }, pollEnv)
        if (!fileRes) return null
        const ct = baseType(fileRes.type)
        if (isAllowedRasterImage(ct)) return { bytes: fileRes.bytes, type: ct }
        const sniffed = baseType(sniffImageType(fileRes.bytes))
        return isAllowedRasterImage(sniffed) ? { bytes: fileRes.bytes, type: sniffed } : null
      }
    }
    const wait = Math.min(400, Math.max(0, deadline - Date.now()))
    if (wait <= 0) return null
    await new Promise((r) => setTimeout(r, wait))
  }
}

/**
 * 真实出图 provider（可插拔 `IMAGE_GEN_KIND`）。未配置 `IMAGE_GEN_URL` → 返回 null（用程序化 provider）。
 *
 * kind：
 * - `a1111`  ：POST `IMAGE_GEN_URL`（如 http://host:7860/sdapi/v1/txt2img），body `{prompt,negative_prompt?,steps,width,height,sampler_name?}`，
 *              解析 `{images:[b64,...]}` 取第一张（PNG）。
 * - `openai` ：POST `IMAGE_GEN_URL`（如 .../v1/images/generations），body `{prompt,n,size,response_format:'b64_json'}`，
 *              解析 `{data:[{b64_json}]}`。
 * - `generic`：POST 自定义 body（`{prompt,style?,model?,size?}`），解析 `{b64|bytes|image}` 或 `{images:[b64]}`。
 * - `comfy`  ：ComfyUI（`IMAGE_GEN_URL=http://host:8188`）：POST `/prompt` 提交工作流 → 轮询 `/history/{id}` → GET `/view` 下载图片。
 * - 不设置 kind（auto）：兼容旧行为，按 generic 的宽松响应解析。
 *
 * 安全（H1 SSRF / M1 存储型 XSS）：**只接受内联 b64/bytes，绝不 fetch 响应里的 url**；只允许栅格图 png/jpeg/webp，
 * svg/xml 一律拒绝；超时/大小上限/失败回落程序化；key 只进 Authorization 头，不进日志。
 */
export function createHttpImageProvider(env: NodeJS.ProcessEnv = process.env): MediaProvider | null {
  const url = (env.IMAGE_GEN_URL ?? '').trim()
  if (!url) return null
  const key = (env.IMAGE_GEN_KEY ?? '').trim()
  const model = (env.IMAGE_GEN_MODEL ?? '').trim()
  const size = (env.IMAGE_GEN_SIZE ?? '').trim()
  const kindRaw = (env.IMAGE_GEN_KIND ?? '').trim().toLowerCase()
  const kind: 'a1111' | 'openai' | 'generic' | 'comfy' | 'auto' =
    kindRaw === 'a1111' || kindRaw === 'sd' || kindRaw === 'sdwebui' || kindRaw === 'automatic1111'
      ? 'a1111'
      : kindRaw === 'openai'
        ? 'openai'
        : kindRaw === 'comfy' || kindRaw === 'comfyui'
          ? 'comfy'
          : kindRaw === 'generic' || kindRaw === 'custom'
            ? 'generic'
            : 'auto'

  const steps = envInt(env, ['IMAGE_GEN_STEPS'], 20, 150)
  const width = envInt(env, ['IMAGE_GEN_WIDTH'], 512, 2048)
  const height = envInt(env, ['IMAGE_GEN_HEIGHT'], 512, 2048)
  const negative = (env.IMAGE_GEN_NEGATIVE ?? '').trim()
  const sampler = (env.IMAGE_GEN_SAMPLER ?? '').trim()

  return {
    name: `http-image:${kind}`,
    async genImage(input: GenImageInput): Promise<MediaBytes | null> {
      const prompt = buildImagePrompt(input)
      if (kind === 'comfy') {
        return generateComfyImage(url, prompt, env, key)
      }
      let payload: Record<string, unknown>
      if (kind === 'a1111') {
        payload = { prompt, steps, width, height }
        if (negative) payload.negative_prompt = negative
        if (sampler) payload.sampler_name = sampler
      } else if (kind === 'openai') {
        payload = { prompt, n: 1, size: size || '1024x1024', response_format: 'b64_json' }
        if (model) payload.model = model
      } else {
        // generic / auto：尽量通用的 body
        payload = { prompt }
        if (input.style) payload.style = input.style
        if (model) payload.model = model
        if (size) payload.size = size
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (key) headers.authorization = 'Bearer ' + key
      const res = await fetchCapped(url, { method: 'POST', headers, body: JSON.stringify(payload) }, env)
      if (!res) return null
      return interpretImageResponse(res)
    },
    genSong(): null {
      return null
    },
  }
}

/**
 * 真实点歌 provider。配置 `SONG_URL` 才启用。
 *
 * 请求约定：默认 `GET <SONG_URL>?title=<歌名>`；若 `SONG_METHOD=POST` 则改发 JSON `{title}`。
 * 可带 `Authorization: Bearer <SONG_KEY || IMAGE_GEN_KEY>`。
 * 响应支持（安全子集）：直接返回常见 `audio/*` 字节；或 JSON `{b64_json|audio|bytes}`。
 * **不接受/不跟随响应里的 url**（防 SSRF）；svg/xml 一律拒绝。
 */
export function createHttpSongProvider(env: NodeJS.ProcessEnv = process.env): MediaProvider | null {
  const url = (env.SONG_URL ?? '').trim()
  if (!url) return null
  const key = (env.SONG_KEY ?? env.IMAGE_GEN_KEY ?? '').trim()
  const method = (env.SONG_METHOD ?? 'GET').trim().toUpperCase() === 'POST' ? 'POST' : 'GET'

  return {
    name: 'http-song',
    genImage(): null {
      return null
    },
    async genSong(input: GenSongInput): Promise<MediaBytes | null> {
      const headers: Record<string, string> = {}
      if (key) headers.authorization = 'Bearer ' + key
      let res: FetchedMedia | null
      if (method === 'POST') {
        headers['content-type'] = 'application/json'
        res = await fetchCapped(url, { method: 'POST', headers, body: JSON.stringify({ title: input.title }) }, env)
      } else {
        res = await fetchCapped(appendQuery(url, { title: input.title }), { method: 'GET', headers }, env)
      }
      if (!res) return null
      return interpretAudioResponse(res)
    },
  }
}

// ---------------------------------------------------------------------------
// 组合 + 回落
// ---------------------------------------------------------------------------

export function isValidMedia(m: MediaBytes | null | undefined): m is MediaBytes {
  if (!m || typeof m !== 'object') return false
  const bytes = (m as MediaBytes).bytes as unknown
  const okBytes =
    bytes instanceof Uint8Array ||
    (typeof bytes === 'object' && bytes !== null && typeof (bytes as { byteLength?: number }).byteLength === 'number')
  return okBytes && (bytes as Uint8Array).byteLength > 0 && typeof m.type === 'string' && m.type.length > 0
}

/**
 * 按环境变量解析出实际 provider：
 * - 都没配置 → 纯程序化 provider（全本地可用）。
 * - 配了图片/点歌 → 组合 provider：优先真实服务，失败/未产出一律回落程序化（点歌回落「无音频」）。
 */
export function resolveMediaProvider(env: NodeJS.ProcessEnv = process.env): MediaProvider {
  const image = createHttpImageProvider(env)
  const song = createHttpSongProvider(env)
  if (!image && !song) return programmaticProvider

  return {
    name: 'composite',
    async genImage(input: GenImageInput): Promise<MediaBytes> {
      if (image) {
        try {
          const r = await image.genImage(input)
          if (isValidMedia(r)) return r
        } catch {
          /* 回落程序化 */
        }
      }
      const fallback = await programmaticProvider.genImage(input)
      return fallback as MediaBytes
    },
    async genSong(input: GenSongInput): Promise<MediaBytes | null> {
      if (song) {
        try {
          const r = await song.genSong(input)
          if (isValidMedia(r)) return r
        } catch {
          /* 回落「仅记录」 */
        }
      }
      return null
    },
  }
}

/** 生成图片（带兜底）：provider 抛错/返回非法 → 程序化 SVG，保证一定拿到可读字节。 */
export async function generateImageWithFallback(provider: MediaProvider, input: GenImageInput): Promise<MediaBytes> {
  try {
    const r = await provider.genImage(input)
    if (isValidMedia(r)) return r
  } catch {
    /* 回落程序化 */
  }
  const fallback = await programmaticProvider.genImage(input)
  return fallback as MediaBytes
}

/** 生成点歌音频（无兜底）：provider 抛错/返回非法 → null（上层仅记录，不存文件）。 */
export async function generateSongAudio(provider: MediaProvider, input: GenSongInput): Promise<MediaBytes | null> {
  try {
    const r = await provider.genSong(input)
    if (isValidMedia(r)) return r
  } catch {
    /* 回落「仅记录」 */
  }
  return null
}

/** 从 MIME 推断文件扩展名。 */
export function extFromMime(mime: string | undefined): string {
  const t = String(mime ?? '').split(';')[0].trim().toLowerCase()
  switch (t) {
    case 'image/svg+xml':
      return '.svg'
    case 'image/png':
      return '.png'
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3'
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav'
    case 'audio/ogg':
      return '.ogg'
    case 'audio/mp4':
    case 'audio/m4a':
      return '.m4a'
    default:
      return '.bin'
  }
}

/** 从文件扩展名推断服务的 Content-Type。 */
export function mimeFromPath(path: string | null | undefined): string {
  const ext = String(path ?? '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  switch (ext) {
    case '.svg':
      return 'image/svg+xml; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.ogg':
      return 'audio/ogg'
    case '.m4a':
      return 'audio/mp4'
    default:
      return 'application/octet-stream'
  }
}
