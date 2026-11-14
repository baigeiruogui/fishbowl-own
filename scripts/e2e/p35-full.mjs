// scripts/e2e/p35-full.mjs — P3.5 全链路端到端验收：媒体(拍照/点歌/画铺) + 夸夸 + 小游戏 + 画铺 gallery。
//
// 真跑（临时 DB + 随机端口 + 真 Fastify + 真 HTTP + 真经济 ledger），不 mock：
//   1) 拍照：POST /photo 扣费 + GET /album 可见 + GET /api/public/album/:id/file 返回 image/svg+xml 且字节>0。
//   2) 点歌：POST /song 记录（kind=song）+ 画铺 POST /paint（kind=painting）。
//   3) 夸夸：POST /bless + GET /api/public/bless 可见。
//   4) 小游戏：rps 胜/负结算（逐局校验）、dice、lottery（当日第二次拒绝）。
//   5) 画铺：GET /api/public/gallery 有 seed 画；GET /api/public/album?fishId 返回该鱼相册。
//   全程断账本不变量 SUM(ledger.delta)==fish.balance。
//
// 验收：node scripts/e2e/p35-full.mjs 退出码 0。真跑，不编。
// 用法：node scripts/e2e/p35-full.mjs [--out report.txt]
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startTestServer, createFishViaOwnerApi, residentApi, ledgerRows, sumByReason,
  ledgerSum, verifyBalance, money, pad, maskCode,
} from './lib.mjs'

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null

const lines = []
function out(s = '') { console.log(s); lines.push(s) }
function rule(ch = '─', n = 72) { out(ch.repeat(n)) }

const START = 500
const PHOTO_PRICE = 25
const SONG_PRICE = 50
const PAINT_PRICE = 60
const RPS_ROUNDS = 40
const RPS_STAKE = 2
const DICE_ROUNDS = 20
const DICE_STAKE = 2

const failures = []
function fail(msg) { failures.push(msg); out(`      ❌ ${msg}`) }
function check(name, ok, detail = '') { out(`    ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(name + (detail ? '（' + detail + '）' : '')) }
function bal(db, id) { return db.prepare('SELECT balance FROM fish WHERE id = ?').get(id).balance }

async function run() {
  const albumDir = mkdtempSync(join(tmpdir(), 'fishbowl-album-'))
  const prevAlbumDir = process.env.ALBUM_DIR
  process.env.ALBUM_DIR = albumDir // 让媒体/种子把 SVG 写进临时目录，不污染仓库 data/
  const adminToken = 'p35-admin-' + Math.floor(Math.random() * 1e9)
  // 抬高限流：本脚本要连发 40+ 局 rps / 20 局 dice 等（生产 resident 默认 60/10min，e2e 压测需放宽）
  const srv = await startTestServer({ adminToken, rateLimit: { residentMax: 1_000_000, ownerMax: 1_000_000, publicMax: 1_000_000, windowMs: 60_000 } })
  const base = srv.base
  const db = srv.db
  let okExit = true
  try {
    out('='.repeat(72))
    out(' 鱼缸小镇 · P3.5 全链路端到端验收（媒体 / 夸夸 / 小游戏 / 画铺）')
    out('='.repeat(72))
    out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
    out(`Node 版本  : ${process.version}`)
    out(`验证命令   : node scripts/e2e/p35-full.mjs`)
    out('')
    out(`临时 DB    : ${srv.dbPath}`)
    out(`ALBUM_DIR  : ${albumDir}`)
    out(`服务端     : ${base}  （Fastify · 临时库 · 随机端口 ${srv.port} · 真种子 + P3.5 接线）`)
    out('')

    const created = await createFishViaOwnerApi(base, adminToken, { name: '阿画', balance: START })
    const fish = created.fish
    const api = residentApi(base, created.code)
    out(`[0] 造鱼：${fish.name} id=${fish.id} 余额=${START} 码=${maskCode(created.code)}`)
    out('')

    // ================= [1] 拍照 =================
    out(`[1] 拍照（POST /photo，默认 ${PHOTO_PRICE} 鱼币）：扣费 + 相册 + 公开 SVG 文件`)
    const beforePhoto = bal(db, fish.id)
    const photo = await api.post('/photo', { scene: '海边的日落' })
    check('POST /photo 成功', photo.status === 200 && photo.body.ok, photo.status === 200 ? `entry=${photo.body.entry?.id} kind=${photo.body.entry?.kind}` : JSON.stringify(photo.body))
    const photoEntry = photo.body.entry
    check('拍照扣费 = -' + PHOTO_PRICE, bal(db, fish.id) === beforePhoto - PHOTO_PRICE && photo.body.receipt?.delta === -PHOTO_PRICE, `${beforePhoto}→${bal(db, fish.id)}`)
    check('album 条目 kind=photo 且带 id/路径', photoEntry?.kind === 'photo' && /^album_[0-9a-f]{16}$/.test(photoEntry?.id), `id=${photoEntry?.id} price=${photoEntry?.price}`)
    const album1 = await (await api.get('/album')).body
    check('GET /album 可见该照片', album1.ok && album1.album.some((e) => e.id === photoEntry.id && e.kind === 'photo'), `album=${album1.album.map((e) => e.kind).join(',')}`)
    // 公开 SVG 文件
    const fileRes = await fetch(base + '/api/public/album/' + photoEntry.id + '/file')
    const ctype = fileRes.headers.get('content-type') || ''
    const buf = Buffer.from(await fileRes.arrayBuffer())
    check('GET /api/public/album/:id/file 返回 image/svg+xml 且字节>0', fileRes.status === 200 && /image\/svg\+xml/.test(ctype) && buf.length > 0 && buf.toString('utf8').includes('<svg'), `status=${fileRes.status} type=${ctype} bytes=${buf.length}`)
    // 非法 id 被拒
    const badFile = await fetch(base + '/api/public/album/album_deadbeef/file')
    check('非法相册 id 被拒（400/404）', badFile.status === 400 || badFile.status === 404, `status=${badFile.status}`)
    out(`    照片 ${photoEntry.id}（${photoEntry.title}）扣 ${PHOTO_PRICE}；公开文件 ${ctype} ${buf.length} bytes`)
    out('')

    // ================= [2] 点歌 + 画铺 =================
    out(`[2] 点歌（POST /song ${SONG_PRICE}）+ 画铺订画（POST /paint ${PAINT_PRICE}）均进相册`)
    const beforeSong = bal(db, fish.id)
    const song = await api.post('/song', { title: '小星星' })
    check('POST /song 成功（kind=song）', song.status === 200 && song.body.entry?.kind === 'song', song.status === 200 ? `entry=${song.body.entry?.id}` : JSON.stringify(song.body))
    check('点歌扣费 = -' + SONG_PRICE, bal(db, fish.id) === beforeSong - SONG_PRICE, `${beforeSong}→${bal(db, fish.id)}`)
    const beforePaint = bal(db, fish.id)
    const paint = await api.post('/paint', { title: '小镇夜景' })
    check('POST /paint 成功（kind=painting）', paint.status === 200 && paint.body.entry?.kind === 'painting', paint.status === 200 ? `entry=${paint.body.entry?.id}` : JSON.stringify(paint.body))
    check('订画扣费 = -' + PAINT_PRICE, bal(db, fish.id) === beforePaint - PAINT_PRICE, `${beforePaint}→${bal(db, fish.id)}`)
    const album2 = await (await api.get('/album')).body
    const kinds = album2.album.map((e) => e.kind)
    check('相册含 photo/song/painting', kinds.includes('photo') && kinds.includes('song') && kinds.includes('painting'), `kinds=${kinds.join(',')}`)
    const socialSum = sumByReason(ledgerRows(db, fish.id)).get('social') ?? 0
    check('媒体账本 reason=social 合计 = -(拍照+点歌+订画)', socialSum === -(PHOTO_PRICE + SONG_PRICE + PAINT_PRICE), `social=${money(socialSum)}`)
    out(`    歌 ${song.body.entry.id}、画 ${paint.body.entry.id}；相册 kinds=${kinds.join('/')}；social 合计 ${money(socialSum)}`)
    out('')

    // ================= [3] 夸夸 =================
    out('[3] 夸夸：POST /bless → GET /api/public/bless 可见')
    const bless = await api.post('/bless', { text: '大家今天都超棒！' })
    check('POST /bless 成功（写入给所有 active 鱼）', bless.status === 200 && bless.body.ok && typeof bless.body.blessId === 'string' && bless.body.recipients >= 1, `blessId=${bless.body?.blessId} recipients=${bless.body?.recipients}`)
    const pubBless = await (await fetch(base + '/api/public/bless')).json()
    const found = (pubBless.bless || []).find((b) => b.blessId === bless.body.blessId && b.text === '大家今天都超棒！')
    check('GET /api/public/bless 能看到该夸夸', pubBless.ok === true && !!found, found ? `recipients=${found.recipients}` : `bless=${(pubBless.bless || []).length}`)
    out(`    夸夸 ${bless.body.blessId} 发给 ${bless.body.recipients} 条鱼；public /bless 可见`)
    out('')

    // ================= [4] 小游戏 =================
    out(`[4] 小游戏：rps(${RPS_ROUNDS}局 stake=${RPS_STAKE}) 胜/负结算、dice(${DICE_ROUNDS}局)、lottery 当日第二次拒绝`)
    // rps
    let wins = 0, losses = 0, draws = 0, rpsBad = 0
    for (let i = 0; i < RPS_ROUNDS; i++) {
      const prev = bal(db, fish.id)
      const r = await api.post('/rps', { choice: 'rock', stake: RPS_STAKE })
      if (r.status !== 200 || !r.body.ok) { rpsBad++; continue }
      const res = r.body.result
      const expect = prev + (res.result === 'win' ? RPS_STAKE : res.result === 'lose' ? -RPS_STAKE : 0)
      if (bal(db, fish.id) !== expect || res.balance !== expect) rpsBad++
      if (res.result === 'win') wins++
      else if (res.result === 'lose') losses++
      else draws++
    }
    check('rps 每局结算与结果一致（win +stake / lose -stake / draw 0）', rpsBad === 0, `bad=${rpsBad}`)
    check('rps 观察到胜与负（' + RPS_ROUNDS + '局）', wins > 0 && losses > 0, `win=${wins} lose=${losses} draw=${draws}`)
    // dice
    let dWins = 0, dLosses = 0, dDraws = 0, dBad = 0
    for (let i = 0; i < DICE_ROUNDS; i++) {
      const prev = bal(db, fish.id)
      const r = await api.post('/dice', { stake: DICE_STAKE })
      if (r.status !== 200 || !r.body.ok) { dBad++; continue }
      const res = r.body.result
      const expect = prev + (res.result === 'win' ? DICE_STAKE : res.result === 'lose' ? -DICE_STAKE : 0)
      if (bal(db, fish.id) !== expect || res.balance !== expect) dBad++
      if (res.result === 'win') dWins++
      else if (res.result === 'lose') dLosses++
      else dDraws++
    }
    check('dice 每局结算与结果一致', dBad === 0 && dWins + dLosses + dDraws === DICE_ROUNDS, `bad=${dBad} win=${dWins} lose=${dLosses} draw=${dDraws}`)
    // lottery
    const beforeLot = bal(db, fish.id)
    const lot1 = await api.post('/lottery', {})
    const lotRes = lot1.body?.result
    check('lottery 首次可抽（命中给 1-10 鱼币）', lot1.status === 200 && lot1.body.ok && typeof lotRes?.hit === 'boolean', `hit=${lotRes?.hit} bonus=${lotRes?.bonus}`)
    check('lottery 奖励与余额一致', bal(db, fish.id) === beforeLot + (lotRes?.hit ? lotRes.bonus : 0) && lotRes?.balance === bal(db, fish.id), `${beforeLot}→${bal(db, fish.id)}（bonus=${lotRes?.bonus}）`)
    const lot2 = await api.post('/lottery', {})
    check('lottery 当日第二次被拒（DAY_CAP）', lot2.status === 409 && lot2.body?.code === 'DAY_CAP', `status=${lot2.status} code=${lot2.body?.code}`)
    out(`    rps: win=${wins} lose=${losses} draw=${draws}（0 异常）；dice: win=${dWins} lose=${dLosses} draw=${dDraws}`)
    out(`    lottery: 首次 hit=${lotRes?.hit} bonus=${lotRes?.bonus}；第二次 ${lot2.status} ${lot2.body?.code}`)
    out('')

    // ================= [5] 画铺 gallery + 公开相册 =================
    out('[5] 画铺：GET /api/public/gallery（seed 画）+ GET /api/public/album?fishId')
    const gallery = await (await fetch(base + '/api/public/gallery')).json()
    const g = gallery.gallery || []
    check('GET /api/public/gallery 有 seed 画（>=2 张）', gallery.ok === true && g.length >= 2 && g.every((x) => x.id && x.title && 'scene' in x), `gallery=${g.length}`)
    const pubAlbum = await (await fetch(base + '/api/public/album?fishId=' + encodeURIComponent(fish.id))).json()
    const pa = pubAlbum.album || []
    check('GET /api/public/album?fishId 返回该鱼相册（含 photo/song/painting）', pubAlbum.ok === true && pubAlbum.fishId === fish.id && pa.length >= 3 && ['photo', 'song', 'painting'].every((k) => pa.some((e) => e.kind === k)), `album=${pa.length} kinds=${pa.map((e) => e.kind).join(',')}`)
    out(`    gallery=${g.length} 张（如「${g[0]?.title}」）；public album=${pa.length} 条 kinds=${pa.map((e) => e.kind).join('/')}`)
    out('')

    // ================= 账本不变量 =================
    const vb = verifyBalance(db, fish.id)
    const sum = ledgerSum(db, fish.id)
    const b = bal(db, fish.id)
    check('账本不变量 SUM(ledger.delta)==balance', vb.ok === true && sum === b, `SUM=${sum} balance=${b}`)
    rule('-', 44)
    out(`    ${fish.name} 最终余额 ${b}；账本：${[...sumByReason(ledgerRows(db, fish.id))].map(([k, v]) => k + ' ' + money(v)).join(' / ')}`)
    out('')

    rule('=')
    const pass = failures.length === 0
    if (pass) out('✅ P3.5 全链路通过：拍照(扣费+相册+SVG文件) / 点歌 / 画铺 / 夸夸(public可见) / rps胜-负 / dice / lottery日限 / gallery seed / public相册 均真跑通过。')
    else { out(`❌ P3.5 全链路发现 ${failures.length} 项问题：`); for (const f of failures.slice(0, 40)) out('   - ' + f) }
    rule('=')
    okExit = pass
  } catch (e) {
    fail(`运行异常：${e?.stack ?? e}`)
    okExit = false
  } finally {
    try { await srv.close() } catch { /* ignore */ }
    if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
    if (prevAlbumDir === undefined) delete process.env.ALBUM_DIR; else process.env.ALBUM_DIR = prevAlbumDir
    try { rmSync(albumDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  process.exit(okExit ? 0 : 1)
}

run().catch(async (err) => {
  console.error('\n❌ p35-full 运行失败：', err?.stack ?? err)
  if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  process.exit(1)
})
