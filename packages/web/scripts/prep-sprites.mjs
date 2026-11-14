#!/usr/bin/env node
/**
 * 精灵预处理：把 public/art/sprites/*.png（AI 生成的水彩素材）
 * → public/art/sprites-cut/<name>.png（裁剪选定单体 + 去背 + 缩放）。
 *
 * 零依赖：只用 node:fs / node:zlib 手写 PNG 解码 + 编码。
 * 运行：pnpm -C packages/web art:sprites
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SRC_DIR = path.resolve('public/art/sprites')
const OUT_DIR = path.resolve('public/art/sprites-cut')
const TARGET_W = 460

/** 每张素材的处理配置（crop 为源图坐标，null=整图；erase 为 crop 后坐标的抹除矩形） */
const CONFIG = {
  'house-teal': {
    crop: [296, 296, 600, 552], // 截 A 字顶小青顶屋（12 联张里挑一只）
    tol: 30,
    erase: [[0, 0, 64, 34]], // 抹掉左上角邻屋残影
  },
  'house-red': { crop: null, tol: 30 },
  'hall-boardgame': { crop: null, mode: 'neutral' }, // 灰色渐变底：按“近中性灰”判别
  'hall-arcade': { crop: null, tol: 30 },
  'hall-court': {
    crop: [24, 322, 588, 820], // 截钟楼大堂（5 联张里挑一只）
    tol: 30,
    erase: [[460, 0, 564, 28]], // 抹掉右上角邻楼残影
  },
  'hall-gallery': { crop: null, tol: 30 },
  'hall-shop': { crop: null, tol: 30 },
  fountain: {
    // 截中央「鲸鱼雕像」：池水做 chroma key，仅保留鲸鱼+泡沫圈，摆在 SVG 泳池上
    crop: [436, 356, 754, 588],
    tol: 42,
    despeckle: 220,
  },
}

// ---------- PNG 解码 ----------
function decodePng(file) {
  const b = fs.readFileSync(file)
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a png`)
  let off = 8
  const idat = []
  let w = 0
  let h = 0
  let ct = 0
  while (off < b.length) {
    const len = b.readUInt32BE(off)
    const type = b.toString('ascii', off + 4, off + 8)
    const data = b.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      ct = data[9]
      if (data[12] !== 0) throw new Error(`${file}: interlaced png unsupported`)
      if (data[8] !== 8) throw new Error(`${file}: only 8-bit depth supported`)
    }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  if (ct !== 2 && ct !== 6) throw new Error(`${file}: unsupported color type ${ct}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = ct === 6 ? 4 : 3
  const stride = w * bpp
  const px = Buffer.alloc(w * h * 4)
  const paeth = (a, b2, c) => {
    const p = a + b2 - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b2)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c
  }
  let pos = 0
  const line = Buffer.alloc(stride)
  const prevLine = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[pos++]
    for (let x = 0; x < stride; x++) {
      const cur = raw[pos + x]
      const a = x >= bpp ? line[x - bpp] : 0
      const up = y > 0 ? prevLine[x] : 0
      const ul = x >= bpp && y > 0 ? prevLine[x - bpp] : 0
      let v
      if (f === 0) v = cur
      else if (f === 1) v = cur + a
      else if (f === 2) v = cur + up
      else if (f === 3) v = cur + ((a + up) >> 1)
      else v = cur + paeth(a, up, ul)
      line[x] = v & 255
    }
    const o = y * w * 4
    for (let x = 0; x < w; x++) {
      px[o + x * 4] = line[x * bpp]
      px[o + x * 4 + 1] = line[x * bpp + 1]
      px[o + x * 4 + 2] = line[x * bpp + 2]
      px[o + x * 4 + 3] = 255
    }
    line.copy(prevLine)
    pos += stride
  }
  return { w, h, px }
}

// ---------- 背景抠除 ----------
function dist(c, r, g, b) {
  const dr = c[0] - r
  const dg = c[1] - g
  const db = c[2] - b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/** 从四边种子出发的自适应洪水填充：背景=与已判定背景邻居颜色接近的区域 */
function removeBackground({ w, h, px, tol, adaptive }) {
  const n = w * h
  const isBg = new Uint8Array(n)
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0
  const push = (i) => {
    if (!isBg[i]) {
      isBg[i] = 1
      queue[qt++] = i
    }
  }
  // 收集边框像素，估计“主导背景色”（取出现最多亮度档）
  const border = []
  for (let x = 0; x < w; x++) {
    border.push(x, (h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    border.push(y * w, y * w + w - 1)
  }
  const hist = new Map()
  for (const i of border) {
    const o = i * 4
    const key = (Math.round(px[o] / 12) << 8) | (Math.round(px[o + 1] / 12) << 4) | Math.round(px[o + 2] / 12)
    hist.set(key, (hist.get(key) ?? 0) + 1)
  }
  let bestKey = 0
  let bestN = -1
  for (const [k, v] of hist) {
    if (v > bestN) {
      bestN = v
      bestKey = k
    }
  }
  const dom = [(bestKey >> 8) * 12 + 6, ((bestKey >> 4) & 15) * 12 + 6, (bestKey & 15) * 12 + 6]
  for (const i of border) {
    const o = i * 4
    if (dist(dom, px[o], px[o + 1], px[o + 2]) < tol * 2.2) push(i)
  }
  const neighbors = (i) => {
    const x = i % w
    const y = (i / w) | 0
    const out = []
    if (x > 0) out.push(i - 1)
    if (x < w - 1) out.push(i + 1)
    if (y > 0) out.push(i - w)
    if (y < h - 1) out.push(i + w)
    return out
  }
  while (qh < qt) {
    const i = queue[qh++]
    const o = i * 4
    for (const j of neighbors(i)) {
      if (isBg[j]) continue
      const p = j * 4
      const d = dist([px[o], px[o + 1], px[o + 2]], px[p], px[p + 1], px[p + 2])
      if (adaptive ? d < 26 : d < tol && dist(dom, px[p], px[p + 1], px[p + 2]) < tol * 1.9) push(j)
    }
  }
  // alpha：背景 0；前景边缘按与主导背景的差做软过渡，避免白边
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (isBg[i]) {
      px[o + 3] = 0
    } else {
      const d = dist(dom, px[o], px[o + 1], px[o + 2])
      let a = 255
      if (d < tol * 1.35) {
        const t = (d - tol * 0.55) / (tol * 0.8)
        a = Math.max(0, Math.min(255, Math.round(t * 255)))
      }
      px[o + 3] = a
    }
  }
  // 边界 alpha 平滑一次（去锯齿）
  const alpha = Buffer.alloc(n)
  for (let i = 0; i < n; i++) alpha[i] = px[i * 4 + 3]
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const s = alpha[i] + alpha[i - 1] + alpha[i + 1] + alpha[i - w] + alpha[i + w]
      px[i * 4 + 3] = (s / 5) | 0
    }
  }
}

/** 中性灰背景判别（hall-boardgame 的灰色渐变底）：range<18 且不太暗的连通区 */
function removeBackgroundNeutral({ w, h, px }) {
  const n = w * h
  const isBg = new Uint8Array(n)
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0
  const neutral = (i) => {
    const o = i * 4
    const r = px[o]
    const g = px[o + 1]
    const b = px[o + 2]
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    return mx - mn < 18 && mn > 115
  }
  const push = (i) => {
    if (!isBg[i] && neutral(i)) {
      isBg[i] = 1
      queue[qt++] = i
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (qh < qt) {
    const i = queue[qh++]
    const x = i % w
    const y = (i / w) | 0
    const cands = []
    if (x > 0) cands.push(i - 1)
    if (x < w - 1) cands.push(i + 1)
    if (y > 0) cands.push(i - w)
    if (y < h - 1) cands.push(i + w)
    for (const j of cands) push(j)
  }
  for (let i = 0; i < n; i++) px[i * 4 + 3] = isBg[i] ? 0 : 255
  // 边界 alpha 平滑一次（去锯齿）
  const alpha = Buffer.alloc(n)
  for (let i = 0; i < n; i++) alpha[i] = px[i * 4 + 3]
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const s = alpha[i] + alpha[i - 1] + alpha[i + 1] + alpha[i - w] + alpha[i + w]
      px[i * 4 + 3] = (s / 5) | 0
    }
  }
}
// ---------- 去除孤立小色斑（水花残点等） ----------
function despeckle({ w, h, px }, minArea) {
  const n = w * h
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    if (seen[i] || px[i * 4 + 3] === 0) continue
    let qh = 0
    let qt = 0
    queue[qt++] = i
    seen[i] = 1
    const comp = [i]
    while (qh < qt) {
      const cur = queue[qh++]
      const x = cur % w
      const y = (cur / w) | 0
      const cands = []
      if (x > 0) cands.push(cur - 1)
      if (x < w - 1) cands.push(cur + 1)
      if (y > 0) cands.push(cur - w)
      if (y < h - 1) cands.push(cur + w)
      for (const j of cands) {
        if (!seen[j] && px[j * 4 + 3] > 0) {
          seen[j] = 1
          queue[qt++] = j
          comp.push(j)
        }
      }
    }
    if (comp.length < minArea) {
      for (const j of comp) px[j * 4 + 3] = 0
    }
  }
}

// ---------- 裁边 + 缩放 ----------
function trim({ w, h, px }) {
  let minX = w
  let maxX = -1
  let minY = h
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 12) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) throw new Error('empty after keying')
  const tw = maxX - minX + 1
  const th = maxY - minY + 1
  const out = Buffer.alloc(tw * th * 4)
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const s = ((y + minY) * w + x + minX) * 4
      const d = (y * tw + x) * 4
      out[d] = px[s]
      out[d + 1] = px[s + 1]
      out[d + 2] = px[s + 2]
      out[d + 3] = px[s + 3]
    }
  }
  return { w: tw, h: th, px: out }
}

function downscale({ w, h, px }, targetW) {
  if (w <= targetW) return { w, h, px }
  const tw = targetW
  const th = Math.max(1, Math.round((h * targetW) / w))
  const out = Buffer.alloc(tw * th * 4)
  const sx = w / tw
  const sy = h / th
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * sy)))
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * w + xx) * 4
          const al = px[o + 3] / 255
          r += px[o] * al
          g += px[o + 1] * al
          b += px[o + 2] * al
          a += px[o + 3]
          n++
        }
      }
      const o2 = (y * tw + x) * 4
      const al = a / 255
      out[o2] = al > 0.5 ? Math.min(255, Math.round(r / (a / 255))) : Math.round(r / n)
      out[o2 + 1] = al > 0.5 ? Math.min(255, Math.round(g / (a / 255))) : Math.round(g / n)
      out[o2 + 2] = al > 0.5 ? Math.min(255, Math.round(b / (a / 255))) : Math.round(b / n)
      out[o2 + 3] = Math.round(a / n)
    }
  }
  return { w: tw, h: th, px: out }
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng({ w, h, px }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 主流程 ----------
fs.mkdirSync(OUT_DIR, { recursive: true })
const manifest = []
for (const [name, cfg] of Object.entries(CONFIG)) {
  const src = path.join(SRC_DIR, `${name}.png`)
  const { w, h, px } = decodePng(src)
  let img = { w, h, px }
  if (cfg.crop) {
    const [cx0, cy0, cx1, cy1] = cfg.crop
    const cw = cx1 - cx0
    const ch = cy1 - cy0
    const cpx = Buffer.alloc(cw * ch * 4)
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const s = ((y + cy0) * w + x + cx0) * 4
        const d = (y * cw + x) * 4
        cpx[d] = px[s]
        cpx[d + 1] = px[s + 1]
        cpx[d + 2] = px[s + 2]
        cpx[d + 3] = px[s + 3]
      }
    }
    img = { w: cw, h: ch, px: cpx }
  }
  if (cfg.mode === 'neutral') {
    removeBackgroundNeutral(img)
  } else {
    removeBackground({ ...img, tol: cfg.tol, adaptive: cfg.adaptive })
  }
  // 抹除 crop 内指定的矩形区域（拼贴图邻楼残影）
  if (cfg.erase) {
    for (const [ex0, ey0, ex1, ey1] of cfg.erase) {
      for (let y = ey0; y < ey1; y++) {
        for (let x = ex0; x < ex1; x++) {
          img.px[(y * img.w + x) * 4 + 3] = 0
        }
      }
    }
  }
  if (cfg.despeckle) despeckle(img, cfg.despeckle)
  img = trim(img)
  img = downscale(img, TARGET_W)
  const buf = encodePng(img)
  const outPath = path.join(OUT_DIR, `${name}.png`)
  fs.writeFileSync(outPath, buf)
  manifest.push({ name, w: img.w, h: img.h, bytes: buf.length })
  console.log(`${name}.png  ${img.w}x${img.h}  ${(buf.length / 1024).toFixed(0)} KB`)
}
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('done →', OUT_DIR)
