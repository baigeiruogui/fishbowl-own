import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/index.ts'
import { createFish, getFish, openDb } from '../src/db/index.ts'
import type { DB } from '../src/db/index.ts'
import { getAlbumFile, orderSong, takePhoto } from '../src/domain/media.ts'
import {
  createHttpImageProvider,
  createHttpSongProvider,
  defaultComfyWorkflow,
  injectComfyPrompt,
  programmaticProvider,
  resolveMediaProvider,
} from '../src/domain/media-provider.ts'
import type { MediaProvider } from '../src/domain/media-provider.ts'

const TMP = mkdtempSync(join(tmpdir(), 'fishbowl-media-provider-'))
process.env.ALBUM_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x01, 0x02, 0x03, 0x04,
])
const MP3_BYTES = Buffer.concat([Buffer.from('ID3'), Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64])])

function fakeImageProvider(bytes: Uint8Array, type: string): MediaProvider {
  return {
    name: 'fake-image',
    genImage: () => ({ bytes, type }),
    genSong: () => null,
  }
}

function fakeSongProvider(bytes: Uint8Array, type: string): MediaProvider {
  return {
    name: 'fake-song',
    genImage: () => null,
    genSong: () => ({ bytes, type }),
  }
}

const throwingProvider: MediaProvider = {
  name: 'boom',
  genImage() {
    throw new Error('provider exploded')
  },
  genSong() {
    throw new Error('provider exploded')
  },
}

// 1) 默认（无 env）provider 生成可读 SVG，点歌不产音频
test('默认 provider：生成可读 SVG（渐变+场景+文字），genSong 返回 null', async () => {
  assert.equal(resolveMediaProvider({}), programmaticProvider)
  const img = await resolveMediaProvider({}).genImage({ prompt: '码头晚霞', style: 'photo', title: '晚霞', fishName: '小银', ts: 1000 })
  assert.ok(img)
  assert.equal(img!.type, 'image/svg+xml; charset=utf-8')
  const text = new TextDecoder().decode(img!.bytes)
  assert.ok(text.startsWith('<?xml'))
  assert.ok(text.includes('<svg'))
  assert.ok(text.includes('</svg>'))
  assert.ok(text.includes('linearGradient')) // 渐变
  assert.ok(text.includes('晚霞')) // 标题/场景文字
  assert.ok(text.includes('小银')) // 落款
  assert.equal(await resolveMediaProvider({}).genSong({ title: 'x' }), null)
})

// 2) 注入假 provider：返回图片 bytes 被正确存储（扩展名/MIME/字节一致）
test('注入假 provider：图片 bytes 正确写入文件并可读回（image/png）', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '注入鱼', balance: 100 })
  const entry = await takePhoto(db, fish.id, { scene: '注入的图' }, 1000, fakeImageProvider(PNG_BYTES, 'image/png'))

  assert.equal(entry.kind, 'photo')
  assert.ok(entry.path && entry.path.endsWith('.png'))
  assert.equal(entry.mime, 'image/png')
  assert.equal(existsSync(entry.path!), true)
  assert.deepEqual(readFileSync(entry.path!), PNG_BYTES)

  const got = getAlbumFile(db, entry.id)
  assert.ok(got)
  assert.equal(got!.mime, 'image/png')
  assert.deepEqual(Buffer.from(got!.bytes!), PNG_BYTES)
  assert.equal(got!.svg, null) // 二进制图不是 SVG 文本
  assert.equal(getFish(db, fish.id)!.balance, 75)
  db.close()
})

// 3) provider 抛错 → 回落程序化 SVG，不崩，照常扣费
test('provider 抛错：回落程序化 SVG，不崩溃，账照扣', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '兜底鱼', balance: 100 })
  const entry = await takePhoto(db, fish.id, { scene: '兜底场景' }, 1000, throwingProvider)

  assert.equal(entry.kind, 'photo')
  assert.ok(entry.path && entry.path.endsWith('.svg'))
  const got = getAlbumFile(db, entry.id)
  assert.ok(got && got.svg)
  assert.ok(got!.svg!.includes('<svg'))
  assert.ok(got!.svg!.includes('兜底场景'))
  assert.equal(getFish(db, fish.id)!.balance, 75)
  db.close()
})

// 4) 点歌：provider 有音频 → 存音频文件（kind=song 带 path，audio/mpeg）
test('点歌有音频：存 mp3 文件，kind=song 带 path，getAlbumFile 返回 audio/mpeg', async () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '听歌鱼', balance: 100 })
  const entry = await orderSong(db, fish.id, { title: '海边的歌' }, 1000, fakeSongProvider(MP3_BYTES, 'audio/mpeg'))

  assert.equal(entry.kind, 'song')
  assert.ok(entry.path && entry.path.endsWith('.mp3'))
  assert.equal(entry.mime, 'audio/mpeg')
  assert.equal(existsSync(entry.path!), true)
  assert.deepEqual(readFileSync(entry.path!), MP3_BYTES)

  const got = getAlbumFile(db, entry.id)
  assert.ok(got)
  assert.equal(got!.mime, 'audio/mpeg')
  assert.deepEqual(Buffer.from(got!.bytes!), MP3_BYTES)
  assert.equal(got!.svg, null)
  assert.equal(getFish(db, fish.id)!.balance, 50)

  // provider 抛错时点歌仍成功（仅记录，不存文件、不崩）
  const entry2 = await orderSong(db, fish.id, { title: '坏掉的歌', price: 10 }, 2000, throwingProvider)
  assert.equal(entry2.path, null)
  assert.equal(getAlbumFile(db, entry2.id)!.bytes, null)
  db.close()
})

// 5) HTTP 图片 provider：图片字节解析 + 超时 + 大小上限（本地假服务，无外网）
test('HTTP 图片 provider：直出图片字节 / 超时 / 大小上限 都正确处理', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/img')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_BYTES)
    } else if (req.url?.startsWith('/huge')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '5000' })
      res.end(Buffer.alloc(5000, 1))
    } else {
      // /slow：一直不响应，等客户端超时
      setTimeout(() => {
        try {
          res.end('late')
        } catch {
          /* ignore */
        }
      }, 3000).unref?.()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`

  try {
    const okProvider = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/img`, IMAGE_GEN_KEY: 'secret-key', MEDIA_MAX_BYTES: '10000' })
    assert.ok(okProvider)
    const ok = await okProvider!.genImage({ prompt: 'cat' })
    assert.ok(ok)
    assert.equal(ok!.type, 'image/png')
    assert.deepEqual(Buffer.from(ok!.bytes), PNG_BYTES)

    // 大小上限：content-length 5000 > 1000 → 直接拒绝（返回 null）
    const bigProvider = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/huge`, MEDIA_MAX_BYTES: '1000' })
    assert.equal(await bigProvider!.genImage({ prompt: 'cat' }), null)

    // 超时：250ms 没响应 → 返回 null（不抛、不卡死）
    const slowProvider = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/slow`, MEDIA_TIMEOUT_MS: '250' })
    const t0 = Date.now()
    assert.equal(await slowProvider!.genImage({ prompt: 'cat' }), null)
    assert.ok(Date.now() - t0 < 2500, '超时应该很快返回')

    // 未配置 → null；组好的 provider 会在真实图片失败时回落程序化（这里指向已关闭端口）
    assert.equal(createHttpImageProvider({}), null)
    const downProvider = resolveMediaProvider({ IMAGE_GEN_URL: 'http://127.0.0.1:1/nope', MEDIA_TIMEOUT_MS: '500' })
    const fallback = await downProvider.genImage({ prompt: '连接失败也出图' })
    assert.ok(fallback)
    assert.equal(fallback!.type, 'image/svg+xml; charset=utf-8')
    assert.ok(new TextDecoder().decode(fallback!.bytes).includes('连接失败也出图'))
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 6) HTTP 点歌 provider：音频直出解析
test('HTTP 点歌 provider：audio/mpeg 直出被解析', async () => {
  assert.equal(createHttpSongProvider({}), null)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(MP3_BYTES)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  try {
    const provider = createHttpSongProvider({ SONG_URL: `http://127.0.0.1:${port}/song` })
    assert.ok(provider)
    const audio = await provider!.genSong({ title: '晴天' })
    assert.ok(audio)
    assert.equal(audio!.type, 'audio/mpeg')
    assert.deepEqual(Buffer.from(audio!.bytes), MP3_BYTES)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 7) 公开相册文件端点：音频 entry → 200 + audio/mpeg + 原始字节
test('public /album/:id/file：点歌音频以 audio/mpeg 正确下发', async () => {
  const app = await buildServer({ dbPath: ':memory:', adminToken: 'test-admin' })
  const db = (app as unknown as { db: DB }).db
  try {
    const fish = createFish(db, { name: '歌姬鱼', balance: 100 })
    const entry = await orderSong(db, fish.id, { title: '测试音频' }, 1000, fakeSongProvider(MP3_BYTES, 'audio/mpeg'))
    const res = await app.inject({ method: 'GET', url: `/api/public/album/${entry.id}/file` })
    assert.equal(res.statusCode, 200)
    assert.ok(String(res.headers['content-type']).includes('audio/mpeg'))
    assert.deepEqual(Buffer.from(res.rawPayload), MP3_BYTES)
  } finally {
    await app.close()
  }
})

// 8) H1 SSRF：外部图片响应里的 url / image_url 绝不被服务端 fetch（忽略并回落程序化）
test('H1 SSRF：外部图片返回 url 不被 fetch，回落程序化 SVG', async () => {
  let evilHits = 0
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/evil')) {
      evilHits++
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_BYTES)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ url: `http://${req.headers.host}/evil` }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const provider = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/img-url` })
    assert.ok(provider)
    assert.equal(await provider!.genImage({ prompt: 'url 应被忽略' }), null)

    const out = await resolveMediaProvider({ IMAGE_GEN_URL: `${base}/img-url` }).genImage({ prompt: 'SSRF 也不跟' })
    assert.ok(out)
    assert.equal(out!.type, 'image/svg+xml; charset=utf-8') // 回落程序化
    assert.ok(new TextDecoder().decode(out!.bytes).includes('SSRF 也不跟'))
    assert.equal(evilHits, 0) // 关键：外部内网 URL 一次都没被请求
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 9) H1 SSRF：外部点歌响应里的 url / audio_url 绝不被 fetch
test('H1 SSRF：外部点歌返回 url 不被 fetch（返回 null → 仅记录）', async () => {
  let evilHits = 0
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/evil')) {
      evilHits++
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(MP3_BYTES)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: `http://${req.headers.host}/evil` }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const provider = createHttpSongProvider({ SONG_URL: `${base}/song-url` })
    assert.ok(provider)
    assert.equal(await provider!.genSong({ title: '不该被拉' }), null)
    assert.equal(evilHits, 0)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 10) M1 存储型 XSS：外部返回 svg/xml 一律拒绝（直出 / b64 声明 / octet 嗅探 三种都拒）
test('M1：外部返回 svg/xml 被拒绝，不落盘、回落程序化安全 SVG', async () => {
  const SVG_EVIL = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
  const server = createServer((req, res) => {
    const u = req.url ?? ''
    if (u.startsWith('/svg-direct')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      res.end(SVG_EVIL)
    } else if (u.startsWith('/svg-b64')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from(SVG_EVIL).toString('base64'), mime_type: 'image/svg+xml' }] }))
    } else if (u.startsWith('/svg-octet')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(SVG_EVIL)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    for (const path of ['/svg-direct', '/svg-b64', '/svg-octet']) {
      const provider = createHttpImageProvider({ IMAGE_GEN_URL: `${base}${path}` })
      assert.equal(await provider!.genImage({ prompt: 'x' }), null, `${path} 外部 svg 应被拒绝`)
    }
    // 组合 provider 回落我们自己的程序化 SVG：绝不能包含外部脚本
    const out = await resolveMediaProvider({ IMAGE_GEN_URL: `${base}/svg-direct` }).genImage({ prompt: '外部svg拒绝' })
    assert.ok(out)
    const text = new TextDecoder().decode(out!.bytes)
    assert.ok(text.includes('<svg'))
    assert.ok(!text.includes('<script'))
    assert.ok(!text.includes('alert('))
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 11) M1：外部栅格图 png 通过（b64 声明 + octet-stream 嗅探都放行）
test('M1：外部栅格图 png 正常通过（b64 与 octet 嗅探）', async () => {
  const server = createServer((req, res) => {
    const u = req.url ?? ''
    if (u.startsWith('/png-b64')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64'), mime_type: 'image/png' }] }))
    } else if (u.startsWith('/png-octet')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(PNG_BYTES)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const b64 = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/png-b64` })
    const r1 = await b64!.genImage({ prompt: 'x' })
    assert.ok(r1)
    assert.equal(r1!.type, 'image/png')
    assert.deepEqual(Buffer.from(r1!.bytes), PNG_BYTES)

    const oct = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/png-octet` })
    const r2 = await oct!.genImage({ prompt: 'x' })
    assert.ok(r2)
    assert.equal(r2!.type, 'image/png')
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 12) M1：相册文件响应安全头 —— SVG 带 CSP + nosniff；PNG 带 nosniff 但无需 CSP
test('M1：album SVG 响应带 CSP + nosniff，PNG 带 nosniff', async () => {
  const app = await buildServer({ dbPath: ':memory:', adminToken: 'test-admin' })
  const db = (app as unknown as { db: DB }).db
  try {
    const fish = createFish(db, { name: '安全鱼', balance: 100 })
    const svgEntry = await takePhoto(db, fish.id, { scene: '安全场景' }, 1000) // 程序化 SVG
    const svgRes = await app.inject({ method: 'GET', url: `/api/public/album/${svgEntry.id}/file` })
    assert.equal(svgRes.statusCode, 200)
    assert.ok(String(svgRes.headers['content-type']).includes('image/svg+xml'))
    assert.equal(String(svgRes.headers['x-content-type-options']), 'nosniff')
    const csp = String(svgRes.headers['content-security-policy'] ?? '')
    assert.ok(csp.includes("default-src 'none'"), `CSP 应含 default-src 'none'，实际: ${csp}`)
    assert.ok(csp.includes("style-src 'unsafe-inline'"), `CSP 应含 style-src 'unsafe-inline'，实际: ${csp}`)

    const pngEntry = await takePhoto(db, fish.id, { scene: '栅格图' }, 2000, fakeImageProvider(PNG_BYTES, 'image/png'))
    const pngRes = await app.inject({ method: 'GET', url: `/api/public/album/${pngEntry.id}/file` })
    assert.equal(pngRes.statusCode, 200)
    assert.ok(String(pngRes.headers['content-type']).includes('image/png'))
    assert.equal(String(pngRes.headers['x-content-type-options']), 'nosniff')
    assert.equal(pngRes.headers['content-security-policy'], undefined)
  } finally {
    await app.close()
  }
})

function collectBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
  })
}

// 13) IMAGE_GEN_KIND=a1111：POST {images:[b64]} → 取第一张，正确存成 png
test('IMAGE_GEN_KIND=a1111：images[b64] 被解析并用 takePhoto 存成 png', async () => {
  let seen: any = {}
  const server = createServer(async (req, res) => {
    const raw = await collectBody(req)
    try {
      seen = JSON.parse(raw)
    } catch {
      seen = {}
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ images: [PNG_BYTES.toString('base64')] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const provider = createHttpImageProvider({
      IMAGE_GEN_URL: `${base}/sdapi/v1/txt2img`,
      IMAGE_GEN_KIND: 'a1111',
      IMAGE_GEN_STEPS: '7',
      IMAGE_GEN_WIDTH: '64',
      IMAGE_GEN_HEIGHT: '48',
      IMAGE_GEN_NEGATIVE: 'lowres',
      IMAGE_GEN_SAMPLER: 'Euler',
    })
    assert.ok(provider)
    const img = await provider!.genImage({ prompt: '一只猫', style: 'photo' })
    assert.ok(img)
    assert.equal(img!.type, 'image/png')
    assert.deepEqual(Buffer.from(img!.bytes), PNG_BYTES)
    // a1111 body 字段正确
    assert.equal(seen.steps, 7)
    assert.equal(seen.width, 64)
    assert.equal(seen.height, 48)
    assert.equal(seen.negative_prompt, 'lowres')
    assert.equal(seen.sampler_name, 'Euler')
    assert.ok(String(seen.prompt).includes('一只猫'))

    // 落到相册：正确存成 .png，字节一致
    const db = openDb(':memory:')
    const fish = createFish(db, { name: 'A1111鱼', balance: 100 })
    const entry = await takePhoto(db, fish.id, { scene: '本地出图' }, 1000, provider!)
    assert.ok(entry.path && entry.path.endsWith('.png'), `应存成 png，实际 ${entry.path}`)
    assert.deepEqual(readFileSync(entry.path!), PNG_BYTES)
    db.close()
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 14) IMAGE_GEN_KIND=openai：{data:[{b64_json}]} → png，body 用 b64_json 协议
test('IMAGE_GEN_KIND=openai：data[0].b64_json 被解析，body 带 response_format=b64_json', async () => {
  let seen: any = {}
  const server = createServer(async (req, res) => {
    const raw = await collectBody(req)
    try {
      seen = JSON.parse(raw)
    } catch {
      seen = {}
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const provider = createHttpImageProvider({
      IMAGE_GEN_URL: `${base}/v1/images/generations`,
      IMAGE_GEN_KIND: 'openai',
      IMAGE_GEN_SIZE: '256x256',
      IMAGE_GEN_MODEL: 'gpt-image-1',
    })
    const img = await provider!.genImage({ prompt: '一只狗' })
    assert.ok(img)
    assert.equal(img!.type, 'image/png')
    assert.deepEqual(Buffer.from(img!.bytes), PNG_BYTES)
    assert.equal(seen.response_format, 'b64_json')
    assert.equal(seen.n, 1)
    assert.equal(seen.size, '256x256')
    assert.equal(seen.model, 'gpt-image-1')
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 15) IMAGE_GEN_KIND=generic：{b64} 与 {images:[b64]} 都解析
test('IMAGE_GEN_KIND=generic：{b64} 与 {images:[b64]} 都能解析', async () => {
  const server = createServer((req, res) => {
    const u = req.url ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    if (u.startsWith('/g-b64')) res.end(JSON.stringify({ b64: PNG_BYTES.toString('base64') }))
    else res.end(JSON.stringify({ images: [PNG_BYTES.toString('base64')] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const b64 = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/g-b64`, IMAGE_GEN_KIND: 'generic' })
    const r1 = await b64!.genImage({ prompt: 'x' })
    assert.ok(r1)
    assert.equal(r1!.type, 'image/png')
    assert.deepEqual(Buffer.from(r1!.bytes), PNG_BYTES)

    const imgs = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/g-images`, IMAGE_GEN_KIND: 'generic' })
    const r2 = await imgs!.genImage({ prompt: 'x' })
    assert.ok(r2)
    assert.equal(r2!.type, 'image/png')
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 16) 各 kind：响应里只有 url 时仍被忽略（不 fetch 外部 URL / SSRF）
test('a1111/openai/generic：返回 url 仍被忽略（evilHits=0，回落程序化）', async () => {
  let evilHits = 0
  const server = createServer(async (req, res) => {
    await collectBody(req)
    if ((req.url ?? '').startsWith('/evil')) {
      evilHits++
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_BYTES)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: `http://${req.headers.host}/evil`, image_url: `http://${req.headers.host}/evil` }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    for (const kind of ['a1111', 'openai', 'generic']) {
      const provider = createHttpImageProvider({ IMAGE_GEN_URL: `${base}/gen`, IMAGE_GEN_KIND: kind })
      assert.equal(await provider!.genImage({ prompt: 'x' }), null, `${kind} 的 url 应被忽略`)
      const out = await resolveMediaProvider({ IMAGE_GEN_URL: `${base}/gen`, IMAGE_GEN_KIND: kind }).genImage({ prompt: '回落' })
      assert.ok(out && out.type === 'image/svg+xml; charset=utf-8')
    }
    assert.equal(evilHits, 0)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 17) 外部出图超时 / 5xx → 回落程序化 SVG（不崩）
test('外部出图超时 / 5xx 失败 → 回落程序化 SVG', async () => {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/err')) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    // /slow：一直不响应，等客户端超时
    setTimeout(() => {
      try {
        res.end('late')
      } catch {
        /* ignore */
      }
    }, 3000).unref?.()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const slow = resolveMediaProvider({ IMAGE_GEN_URL: `${base}/slow`, IMAGE_GEN_KIND: 'a1111', MEDIA_TIMEOUT_MS: '250' })
    const s = await slow.genImage({ prompt: '超时也出图' })
    assert.ok(s && s.type === 'image/svg+xml; charset=utf-8')
    assert.ok(new TextDecoder().decode(s!.bytes).includes('超时也出图'))

    const err = resolveMediaProvider({ IMAGE_GEN_URL: `${base}/err`, IMAGE_GEN_KIND: 'openai' })
    const e = await err.genImage({ prompt: '5xx 也出图' })
    assert.ok(e && e.type === 'image/svg+xml; charset=utf-8')
    assert.ok(new TextDecoder().decode(e!.bytes).includes('5xx 也出图'))
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 18) IMAGE_GEN_KIND=comfy：/prompt→/history→/view 全链路，正向提示词注入 + 落盘 png
test('IMAGE_GEN_KIND=comfy：/prompt→/history→/view 返回 png，工作流注入正提示词并落盘 png', async () => {
  let submit: any = null
  const viewUrls: string[] = []
  const server = createServer(async (req, res) => {
    const u = req.url ?? ''
    if (u.startsWith('/prompt')) {
      const raw = await collectBody(req)
      try {
        submit = JSON.parse(raw)
      } catch {
        submit = {}
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: 'pid-abc' }))
      return
    }
    if (u.startsWith('/history/pid-abc')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          'pid-abc': { outputs: { '9': { images: [{ filename: 'fish_0001.png', subfolder: '', type: 'output' }] } } },
        }),
      )
      return
    }
    if (u.startsWith('/view')) {
      viewUrls.push(u)
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_BYTES)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const provider = createHttpImageProvider({
      IMAGE_GEN_URL: base, // ComfyUI 根
      IMAGE_GEN_KIND: 'comfy',
      MEDIA_TIMEOUT_MS: '4000',
      IMAGE_GEN_STEPS: '9',
      IMAGE_GEN_WIDTH: '64',
      IMAGE_GEN_HEIGHT: '48',
      IMAGE_GEN_CKPT: 'model.safetensors',
    })
    assert.ok(provider)
    const img = await provider!.genImage({ prompt: '一只赛博猫' })
    assert.ok(img)
    assert.equal(img!.type, 'image/png')
    assert.deepEqual(Buffer.from(img!.bytes), PNG_BYTES)

    // 提交的工作流：内置模板结构 + 正向提示词注入到 CLIPTextEncode('6')
    assert.ok(submit && submit.prompt, '应 POST {prompt: workflow, client_id}')
    const wf = submit.prompt
    assert.equal(wf['3'].class_type, 'KSampler')
    assert.equal(wf['3'].inputs.steps, 9)
    assert.equal(wf['4'].class_type, 'CheckpointLoaderSimple')
    assert.equal(wf['4'].inputs.ckpt_name, 'model.safetensors')
    assert.equal(wf['5'].class_type, 'EmptyLatentImage')
    assert.equal(wf['5'].inputs.width, 64)
    assert.equal(wf['5'].inputs.height, 48)
    assert.equal(wf['6'].class_type, 'CLIPTextEncode')
    assert.ok(String(wf['6'].inputs.text).includes('一只赛博猫'))
    assert.ok(submit.client_id)

    // /view 携带 filename 取回二进制
    assert.equal(viewUrls.length, 1)
    assert.ok(viewUrls[0].includes('filename=fish_0001.png'))

    // 落盘 png
    const db = openDb(':memory:')
    const fish = createFish(db, { name: 'Comfy鱼', balance: 100 })
    const entry = await takePhoto(db, fish.id, { scene: 'Comfy 出图' }, 1000, provider!)
    assert.ok(entry.path && entry.path.endsWith('.png'), `应存成 png，实际 ${entry.path}`)
    assert.deepEqual(readFileSync(entry.path!), PNG_BYTES)
    db.close()
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 19) comfy：history 一直无 outputs → 超时回落程序化；/prompt 5xx → 失败回落
test('IMAGE_GEN_KIND=comfy：超时 / 5xx 失败均回落程序化 SVG', async () => {
  // 超时：/prompt 正常，/history 一直 {}（无 outputs）
  const slowServer = createServer(async (req, res) => {
    const u = req.url ?? ''
    if (u.startsWith('/prompt')) {
      await collectBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: 'p2' }))
      return
    }
    if (u.startsWith('/history/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => slowServer.listen(0, '127.0.0.1', () => r()))
  const slowBase = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}`
  try {
    const t0 = Date.now()
    const out = await resolveMediaProvider({ IMAGE_GEN_URL: slowBase, IMAGE_GEN_KIND: 'comfy', MEDIA_TIMEOUT_MS: '500' }).genImage({
      prompt: 'comfy超时也出图',
    })
    assert.ok(out && out.type === 'image/svg+xml; charset=utf-8')
    assert.ok(new TextDecoder().decode(out!.bytes).includes('comfy超时也出图'))
    assert.ok(Date.now() - t0 < 5000, '应在超时后快速回落')
  } finally {
    slowServer.closeAllConnections?.()
    await new Promise<void>((r) => slowServer.close(() => r()))
  }

  // 失败：/prompt 直接 500
  const errServer = createServer(async (req, res) => {
    await collectBody(req)
    res.writeHead(500)
    res.end('boom')
  })
  await new Promise<void>((r) => errServer.listen(0, '127.0.0.1', () => r()))
  const errBase = `http://127.0.0.1:${(errServer.address() as AddressInfo).port}`
  try {
    const out = await resolveMediaProvider({ IMAGE_GEN_URL: errBase, IMAGE_GEN_KIND: 'comfy', MEDIA_TIMEOUT_MS: '1000' }).genImage({
      prompt: 'comfy5xx也出图',
    })
    assert.ok(out && out.type === 'image/svg+xml; charset=utf-8')
    assert.ok(new TextDecoder().decode(out!.bytes).includes('comfy5xx也出图'))
  } finally {
    errServer.closeAllConnections?.()
    await new Promise<void>((r) => errServer.close(() => r()))
  }
})

// 20) comfy：/view 返回 svg 被拒（只接受栅格图）
test('IMAGE_GEN_KIND=comfy：/view 返回 svg 被拒绝（provider 返回 null）', async () => {
  const server = createServer(async (req, res) => {
    const u = req.url ?? ''
    if (u.startsWith('/prompt')) {
      await collectBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: 'p3' }))
      return
    }
    if (u.startsWith('/history/p3')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ p3: { outputs: { '9': { images: [{ filename: 'x.svg', subfolder: '', type: 'output' }] } } } }))
      return
    }
    if (u.startsWith('/view')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const provider = createHttpImageProvider({ IMAGE_GEN_URL: base, IMAGE_GEN_KIND: 'comfy', MEDIA_TIMEOUT_MS: '2000' })
    assert.equal(await provider!.genImage({ prompt: 'x' }), null)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

// 21) injectComfyPrompt：默认节点 '6' / 显式节点 / 第一个 CLIPTextEncode 的注入规则
test('injectComfyPrompt：优先节点6，其次显式，其次第一个 CLIPTextEncode', () => {
  const wf6 = defaultComfyWorkflow({
    ckpt: 'a.safetensors',
    positive: 'old',
    negative: 'neg',
    width: 512,
    height: 512,
    steps: 20,
    cfg: 7,
    sampler: 'euler',
    seed: 1,
  })
  injectComfyPrompt(wf6, '新提示词')
  assert.equal((wf6 as any)['6'].inputs.text, '新提示词')

  const wfCustom = { pos: { class_type: 'CLIPTextEncode', inputs: { text: 'old' } }, neg: { class_type: 'CLIPTextEncode', inputs: { text: 'b' } } }
  injectComfyPrompt(wfCustom, '首节点注入')
  assert.equal((wfCustom as any).pos.inputs.text, '首节点注入') // 无节点6/无采样器 → 第一个 CLIPTextEncode

  const wfExplicit = { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a' } }, '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b' } } }
  injectComfyPrompt(wfExplicit, '显式指定', '7')
  assert.equal((wfExplicit as any)['7'].inputs.text, '显式指定')
})

// 22) IMAGE_GEN_WORKFLOW 覆盖文件：用文件里的工作流并注入正向提示词
test('IMAGE_GEN_WORKFLOW 覆盖：使用自定义工作流并注入正提示词', async () => {
  const wfFile = join(TMP, 'custom-workflow.json')
  writeFileSync(
    wfFile,
    JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { steps: 12, cfg: 6, sampler_name: 'euler', model: ['4', 0], positive: ['20', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'custom.safetensors' } },
      '20': { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['8', 0] } },
    }),
    'utf8',
  )
  let submit: any = null
  const server = createServer(async (req, res) => {
    const u = req.url ?? ''
    if (u.startsWith('/prompt')) {
      const raw = await collectBody(req)
      try {
        submit = JSON.parse(raw)
      } catch {
        submit = {}
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: 'p4' }))
      return
    }
    if (u.startsWith('/history/p4')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ p4: { outputs: { '9': { images: [{ filename: 'y.png', subfolder: '', type: 'output' }] } } } }))
      return
    }
    if (u.startsWith('/view')) {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_BYTES)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const provider = createHttpImageProvider({ IMAGE_GEN_URL: base, IMAGE_GEN_KIND: 'comfy', IMAGE_GEN_WORKFLOW: wfFile, MEDIA_TIMEOUT_MS: '3000' })
    const img = await provider!.genImage({ prompt: '覆盖工作流提示' })
    assert.ok(img && img.type === 'image/png')
    assert.equal(submit.prompt['4'].inputs.ckpt_name, 'custom.safetensors')
    assert.ok(String(submit.prompt['20'].inputs.text).includes('覆盖工作流提示'))
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
