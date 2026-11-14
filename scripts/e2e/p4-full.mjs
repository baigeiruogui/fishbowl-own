// scripts/e2e/p4-full.mjs — P4 全链路端到端验收：多主人隔离/限额/审批 + 狼人杀·海龟汤 + 媒体。
//
// 真跑（临时 DB + 随机端口 + 真 Fastify + 真 HTTP + 真经济 ledger），不 mock：
//   1) 两个 owner POST /api/owner/register 得 ownerToken，各建鱼拿 fbr_；断言 A 访问不到 B 的鱼（隔离 404）；
//      A 建第 4 条 → 409；OPEN_REGISTRATION=false 新鱼 pending → admin approve → active。
//   2) 狼人杀 6 人经 resident play + turns 驱动（桩按角色合法回答）走到结算；海龟汤问答到结束。
//   3) 媒体：默认 provider 拍照出 SVG（/api/public/album/:id/file 200 image/svg+xml）；点歌无音频仅记录；SUM==balance。
//
// 验收：node scripts/e2e/p4-full.mjs 退出码 0。真跑，不编。
// 用法：node scripts/e2e/p4-full.mjs [--out report.txt]
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startTestServer, createFishViaOwnerApi, residentApi, ledgerRows, sumByReason,
  ledgerSum, verifyBalance, money, pad, maskCode,
} from './lib.mjs'
import { werewolfNightNeed } from '../../packages/server/src/games/driver.ts'

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null

const lines = []
function out(s = '') { console.log(s); lines.push(s) }
function rule(ch = '─', n = 72) { out(ch.repeat(n)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MAX_FISH = 3
const SEAT_FEE = 5
const PLAYER_BAL = 300

const failures = []
function fail(msg) { failures.push(msg); out(`      ❌ ${msg}`) }
function check(name, ok, detail = '') { out(`    ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(name + (detail ? '（' + detail + '）' : '')) }
function bal(db, id) { return db.prepare('SELECT balance FROM fish WHERE id = ?').get(id).balance }
function sumLedger(db, reason) { return Number(db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE reason = ?').get(reason).s) }

// 狼人杀下一手（按角色/阵营；镜像 party-games.test 的脚本，保证能走到终局）
function nextWerewolfMove(t) {
  const s = t.session
  if (!s || s.phase === 'ended') return null
  const alive = s.players.filter((p) => p.alive)
  if (s.phase === 'day') return { fishId: alive[0].id, action: { type: 'vote', target: alive[0].id } }
  if (s.phase === 'night') {
    for (const p of alive) {
      const need = werewolfNightNeed(s, p.id)
      if (!need) continue
      if (need === 'wolf') { const tgt = alive.find((x) => x.role !== 'werewolf') ?? alive.find((x) => x.id !== p.id); return { fishId: p.id, action: { type: 'wolf', target: tgt.id } } }
      if (need === 'seer') { const tgt = alive.find((x) => x.id !== p.id); return { fishId: p.id, action: { type: 'seer', target: tgt.id } } }
      if (need === 'witch') return { fishId: p.id, action: { type: 'witch', save: null, poison: null } }
      if (need === 'guard') return { fishId: p.id, action: { type: 'guard', target: p.id } }
    }
    return null
  }
  if (s.phase === 'vote') {
    for (const p of alive) {
      if (s.votes.some((v) => v.voter === p.id)) continue
      const wolves = alive.filter((x) => x.role === 'werewolf')
      const goods = alive.filter((x) => x.role !== 'werewolf')
      const target = p.role === 'werewolf' ? (goods[0]?.id ?? wolves[0].id) : (wolves[0]?.id ?? goods[0].id)
      return { fishId: p.id, action: { type: 'vote', target } }
    }
  }
  return null
}

async function run() {
  const albumDir = mkdtempSync(join(tmpdir(), 'fishbowl-p4-album-'))
  const prevAlbumDir = process.env.ALBUM_DIR
  process.env.ALBUM_DIR = albumDir
  const ADMIN = 'p4-admin-' + Math.floor(Math.random() * 1e9)
  // 公网入驻关：owner 新建鱼先 pending；压测限流抬高
  const srv = await startTestServer({ adminToken: ADMIN, openRegistration: false, engine: { agencyCooldownMs: 600000 }, rateLimit: { residentMax: 1_000_000, ownerMax: 1_000_000, publicMax: 1_000_000, windowMs: 60_000 } })
  const { base, db } = srv
  const driver = srv.app.driver
  let okExit = true
  const j = async (method, path, { token, body } = {}) => {
    const headers = {}
    if (token) headers.authorization = 'Bearer ' + token
    if (body !== undefined) headers['content-type'] = 'application/json'
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const t = await r.text()
    let b = null
    try { b = t ? JSON.parse(t) : null } catch { b = { raw: t } }
    return { status: r.status, body: b }
  }
  async function takeGameTurn(api) {
    for (let k = 0; k < 120; k++) {
      const res = await api.get('/turns?wait=0&kinds=game')
      const turn = (res.body?.turns || []).find((x) => x.kind === 'game')
      if (turn) return turn
      await sleep(5)
    }
    return null
  }

  try {
    out('='.repeat(72))
    out(' 鱼缸小镇 · P4 全链路端到端验收（多主人 / 狼人杀·海龟汤 / 媒体）')
    out('='.repeat(72))
    out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
    out(`Node 版本  : ${process.version}`)
    out(`验证命令   : node scripts/e2e/p4-full.mjs`)
    out('')
    out(`临时 DB    : ${srv.dbPath}`)
    out(`服务端     : ${base}  （Fastify · 临时库 · 随机端口 ${srv.port} · OPEN_REGISTRATION=false）`)
    out('')

    // ================= [1] 多主人：注册 / 建鱼 / 隔离 / 限额 / 审批 =================
    out('[1] 多主人：注册 → 建鱼拿 fbr_ → 隔离 / 3 条上限 / pending→approve→active')
    const regA = await j('POST', '/api/owner/register', { body: { name: '主人A' } })
    const regB = await j('POST', '/api/owner/register', { body: { name: '主人B' } })
    check('两个 owner 注册成功并拿到 ownerToken（明文一次性）', regA.status === 200 && /^own_[0-9a-f]+$/.test(regA.body.ownerToken || '') && regB.status === 200 && /^own_[0-9a-f]+$/.test(regB.body.ownerToken || ''), `A.ownerId=${regA.body?.ownerId}`)
    const tokenA = regA.body.ownerToken
    const tokenB = regB.body.ownerToken
    const ownerIdA = regA.body.ownerId
    const ownerIdB = regB.body.ownerId

    const aFish = []
    for (let i = 1; i <= MAX_FISH; i++) {
      const r = await j('POST', '/api/owner/fish', { token: tokenA, body: { name: 'A鱼' + i } })
      check(`A 建第 ${i} 条鱼（pending + fbr_ 码）`, r.status === 200 && r.body.fish?.status === 'pending' && /^fbr_/.test(r.body.code || ''), r.status === 200 ? `id=${r.body.fish.id.slice(0, 6)} status=${r.body.fish.status}` : JSON.stringify(r.body))
      if (r.status === 200) aFish.push({ id: r.body.fish.id, code: r.body.code, ownerId: r.body.fish.ownerId })
    }
    const over = await j('POST', '/api/owner/fish', { token: tokenA, body: { name: 'A鱼4' } })
    check('A 建第 ' + (MAX_FISH + 1) + ' 条被拒（409 CONFLICT）', over.status === 409 && over.body?.code === 'CONFLICT', `status=${over.status} code=${over.body?.code}`)
    const bReg = await j('POST', '/api/owner/fish', { token: tokenB, body: { name: 'B鱼1' } })
    const bFish = { id: bReg.body.fish.id, code: bReg.body.code, ownerId: bReg.body.fish.ownerId }
    check('B 建鱼成功（owner 维度）', bReg.status === 200 && bFish.ownerId === ownerIdB, `B鱼=${bFish.id.slice(0, 6)} ownerId=${bFish.ownerId}`)

    // 隔离：A 能看自己的鱼；看不到 B 的（越权 404）
    const aOwn = await j('GET', `/api/owner/fish/${aFish[0].id}`, { token: tokenA })
    const aCross = await j('GET', `/api/owner/fish/${bFish.id}`, { token: tokenA })
    const bOwn = await j('GET', `/api/owner/fish/${bFish.id}`, { token: tokenB })
    check('A 能查看自己的鱼（200，ownerId=A）', aOwn.status === 200 && aOwn.body.fish?.ownerId === ownerIdA, `status=${aOwn.status}`)
    check('A 看不到 B 的鱼（越权 404）', aCross.status === 404, `status=${aCross.status}`)
    check('B 能查看自己的鱼（200，ownerId=B）', bOwn.status === 200 && bOwn.body.fish?.ownerId === ownerIdB, `status=${bOwn.status}`)
    const meA = await j('GET', '/api/owner/me', { token: tokenA })
    const meB = await j('GET', '/api/owner/me', { token: tokenB })
    const aIds = new Set((meA.body.fish || []).map((f) => f.id))
    check('A GET /api/owner/me 只列出自己的 ' + MAX_FISH + ' 条（不含 B）', meA.status === 200 && meA.body.owner?.id === ownerIdA && aIds.size === MAX_FISH && aFish.every((f) => aIds.has(f.id)) && !aIds.has(bFish.id), `A.fish=${[...aIds].map((x) => x.slice(0, 6)).join(',')}`)
    check('B GET /api/owner/me 只有自己的 1 条（不含 A）', meB.status === 200 && (meB.body.fish || []).length === 1 && meB.body.fish[0].id === bFish.id, `B.fish=${(meB.body.fish || []).length}`)
    out(`    A GET /api/owner/me → 自己的 ${aIds.size} 条（ownerId=${ownerIdA}）；B → 自己的 1 条；A 看不到 B 的鱼（detail 404）。`)

    // DB owner 归属
    const ownerMap = db.prepare('SELECT id, owner_id FROM fish WHERE id IN (?,?,?,?)').all(aFish[0].id, aFish[1].id, aFish[2].id, bFish.id)
    const allA = aFish.every((f) => ownerMap.find((m) => m.id === f.id)?.owner_id === ownerIdA)
    check('库内 owner_id 归属正确（A 三条 / B 一条）', allA && ownerMap.find((m) => m.id === bFish.id)?.owner_id === ownerIdB)

    // 审批：a1 pending → approve → active
    const approve = await j('POST', `/api/admin/fish/${aFish[0].id}/approve`, { token: ADMIN })
    const afterApprove = await j('GET', `/api/owner/fish/${aFish[0].id}`, { token: tokenA })
    check('admin approve：pending → active', approve.status === 200 && afterApprove.body.fish?.status === 'active', `approve=${approve.status} status=${afterApprove.body?.fish?.status}`)
    // admin 能看到全部鱼（含两个主人）
    const adminList = await j('GET', '/api/admin/fish', { token: ADMIN })
    check('admin GET /api/admin/fish 可列全部鱼（含 A/B）', adminList.status === 200 && (adminList.body.fish || []).some((f) => f.id === aFish[0].id) && (adminList.body.fish || []).some((f) => f.id === bFish.id), `count=${adminList.body?.count}`)
    out(`    A ownerId=${ownerIdA}（3 条 pending，第4条409）；B ownerId=${ownerIdB}（1 条）；A 看不到 B；a1 approve→active`)
    out('')

    // ================= 造 6 条「玩家鱼」（admin 建，active，有 fbr_） =================
    out('[1b] admin 建 6 条活跃玩家鱼（有 fbr_ 码），用于对局与媒体（走正经 owner API + 真码）')
    const players = []
    for (let i = 0; i < 6; i++) {
      const c = await createFishViaOwnerApi(base, ADMIN, { name: '玩家' + (i + 1), balance: PLAYER_BAL })
      players.push({ id: c.fish.id, code: c.code, api: residentApi(base, c.code) })
    }
    const apiByFish = Object.fromEntries(players.map((p) => [p.id, p.api]))
    out(`    ${players.length} 条玩家鱼：${players.map((p) => p.id.slice(0, 6)).join(' / ')}（余额 ${PLAYER_BAL}）`)
    out('')

    // ================= [2a] 狼人杀 6 人一局（turns 驱动到结算） =================
    out(`[2a] 狼人杀 6 人：resident /play 入座（seat_fee=${SEAT_FEE}/人）→ turns 驱动 → 结算`)
    const team = players.slice(0, 6)
    const beforeWW = team.reduce((a, p) => a + bal(db, p.id), 0)
    for (const p of team) {
      const r = await p.api.post('/play', { game: 'werewolf', seat_fee: SEAT_FEE })
      if (r.status !== 200) throw new Error(`狼人杀入座失败：${r.status} ${JSON.stringify(r.body)}`)
    }
    const wwTable = driver.listTables().find((t) => t.game === 'werewolf' && t.status === 'playing')
    check('6 人入座并开局（werewolf）', !!wwTable && wwTable.players.length === 6, wwTable ? `seats=${wwTable.players.length} pot=${wwTable.pot}` : 'no table')
    const wwId = wwTable.id
    let wwMoves = 0
    let wwDone = null
    while (wwMoves < 4000) {
      const t = driver.getTable(wwId)
      if (!t || t.status !== 'playing') break
      const mv = nextWerewolfMove(t)
      if (!mv) break
      const turn = await takeGameTurn(apiByFish[mv.fishId])
      if (!turn) { fail(`狼人杀第 ${wwMoves + 1} 手拿不到 game 回合（${mv.action.type}）`); break }
      const ans = await apiByFish[mv.fishId].post('/turns/' + turn.turn_id, { answer: JSON.stringify({ action: mv.action }) })
      if (ans.status !== 200) { fail(`狼人杀第 ${wwMoves + 1} 手 answer 失败：${ans.status} ${JSON.stringify(ans.body)}`); break }
      wwMoves++
      if (ans.body.done) { wwDone = ans.body; break }
    }
    const wwT = driver.getTable(wwId)
    check('狼人杀走到终局（status=done）', !!wwT && wwT.status === 'done', `status=${wwT && wwT.status} moves=${wwMoves}`)
    check('终局有赢家（good/werewolf）', wwT?.session?.winner === 'good' || wwT?.session?.winner === 'werewolf', `winner=${wwT?.session?.winner}`)
    check('狼人杀底池结算：game_win 合计 = pot ' + (SEAT_FEE * 6), sumLedger(db, 'game_win') === SEAT_FEE * 6 && wwT?.pot === SEAT_FEE * 6, `game_win=${sumLedger(db, 'game_win')} pot=${wwT?.pot}`)
    const afterWW = team.reduce((a, p) => a + bal(db, p.id), 0)
    check('狼人杀总余额守恒（座位费收上来再发出去）', afterWW === beforeWW, `${beforeWW}→${afterWW}`)
    out(`    狼人杀 ${wwMoves} 手终局；winner=${wwT?.session?.winner}；game_win=${sumLedger(db, 'game_win')}（pot=${wwT?.pot}）`)
    out('')

    // ================= [2b] 海龟汤 2 人问答到结束 =================
    out('[2b] 海龟汤 2 人：主持+猜题（seat_fee=' + SEAT_FEE + '/人）→ ask → guess 谜底 → 结算')
    const soupPlayers = players.slice(4, 6)
    for (const p of soupPlayers) {
      const r = await p.api.post('/play', { game: 'turtlesoup', seat_fee: SEAT_FEE })
      if (r.status !== 200) throw new Error(`海龟汤入座失败：${r.status} ${JSON.stringify(r.body)}`)
    }
    const soupTable = driver.listTables().find((t) => t.game === 'turtlesoup' && t.status === 'playing')
    check('海龟汤 2 人开局', !!soupTable, soupTable ? `seats=${soupTable.players.length} pot=${soupTable.pot}` : 'no table')
    const sess = soupTable.session
    const guesserFishId = soupTable.players.find((p) => p.seat === sess.guesserSeat).fishId
    const correct = sess.soup.card.answer
    const gApi = apiByFish[guesserFishId]
    // ask
    let t1 = await takeGameTurn(gApi)
    check('猜题者收到海龟汤 game 回合', !!t1 && t1.packet?.game === 'turtlesoup', t1 ? `game=${t1.packet?.game}` : 'none')
    const askRes = await gApi.post('/turns/' + t1.turn_id, { answer: JSON.stringify({ action: { type: 'ask', question: '和食物有关吗？' } }) })
    check('提问成功（未结束）', askRes.status === 200 && !askRes.body.done, `status=${askRes.status}`)
    // guess 正确谜底
    let t2 = await takeGameTurn(gApi)
    const guessRes = await gApi.post('/turns/' + t2.turn_id, { answer: JSON.stringify({ action: { type: 'guess', answer: correct } }) })
    check('猜中谜底 → 结算（done，赢家=猜题者）', guessRes.status === 200 && guessRes.body.done === true && JSON.stringify(guessRes.body.settlement?.winners) === JSON.stringify([sess.guesserSeat]), `done=${guessRes.body?.done} winners=${JSON.stringify(guessRes.body?.settlement?.winners)}`)
    check('海龟汤底池结算：game_win 累计 = 狼人杀+海龟汤 = ' + (SEAT_FEE * 6 + SEAT_FEE * 2), sumLedger(db, 'game_win') === SEAT_FEE * 6 + SEAT_FEE * 2, `game_win=${sumLedger(db, 'game_win')}`)
    out(`    海龟汤：ask→guess「${correct}」猜中，赢家 seat=${sess.guesserSeat}；game_win 累计=${sumLedger(db, 'game_win')}`)
    out('')

    // ================= [3] 媒体（默认 provider：出 SVG / 点歌仅记录） =================
    out('[3] 媒体：默认 provider 拍照出 SVG（公开文件 image/svg+xml）/ 点歌无音频仅记录')
    const mFish = players[0]
    const beforePhoto = bal(db, mFish.id)
    const photo = await mFish.api.post('/photo', { scene: '小镇日出' })
    check('POST /photo 成功（kind=photo）', photo.status === 200 && photo.body.entry?.kind === 'photo', photo.status === 200 ? `id=${photo.body.entry.id}` : JSON.stringify(photo.body))
    check('拍照扣费（余额减少）', bal(db, mFish.id) === beforePhoto - photo.body.entry.price, `${beforePhoto}→${bal(db, mFish.id)}（-${photo.body.entry.price}）`)
    const fRes = await fetch(base + '/api/public/album/' + photo.body.entry.id + '/file')
    const fBuf = Buffer.from(await fRes.arrayBuffer())
    const fType = fRes.headers.get('content-type') || ''
    check('GET /api/public/album/:id/file → image/svg+xml 且字节>0', fRes.status === 200 && /image\/svg\+xml/.test(fType) && fBuf.length > 0, `status=${fRes.status} type=${fType} bytes=${fBuf.length}`)
    const song = await mFish.api.post('/song', { title: '晚风' })
    check('POST /song 成功（kind=song，无音频仅记录）', song.status === 200 && song.body.entry?.kind === 'song' && song.body.entry?.path == null, song.status === 200 ? `kind=${song.body.entry.kind} path=${song.body.entry.path}` : JSON.stringify(song.body))
    const vbm = verifyBalance(db, mFish.id)
    check('媒体鱼账本不变量 SUM==balance', vbm.ok === true, `SUM=${ledgerSum(db, mFish.id)} balance=${bal(db, mFish.id)}`)
    out(`    照片 ${photo.body.entry.id}（${fType} ${fBuf.length}B）；歌 kind=song path=null（无音频）`)
    out('')

    // ================= 全账本不变量（6 玩家） =================
    let allOk = true
    for (const p of players) { const vb = verifyBalance(db, p.id); if (!vb.ok) allOk = false }
    check('全部玩家鱼账本不变量 SUM(ledger.delta)==balance', allOk)
    out('')

    rule('=')
    const pass = failures.length === 0
    if (pass) out('✅ P4 全链路通过：多主人隔离/3条上限/pending→approve / 狼人杀6人turns结算(pot守恒) / 海龟汤问答到结束 / 媒体(出SVG·点歌仅记录) 均真跑通过。')
    else { out(`❌ P4 全链路发现 ${failures.length} 项问题：`); for (const f of failures.slice(0, 40)) out('   - ' + f) }
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
  console.error('\n❌ p4-full 运行失败：', err?.stack ?? err)
  if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  process.exit(1)
})
