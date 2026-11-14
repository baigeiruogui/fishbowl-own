// scripts/e2e/p2-full.mjs — P2 全链路端到端验收：对局结算 + 开店买货 + 悬赏 + 公开只读端点。
//
// 真跑（临时 DB + 随机端口 + 真 Fastify + 真 HTTP + 真经济 ledger），不 mock：
//   1) 3 条鱼经 resident play 开桌/入座打一局斗地主（真 turns 长轮询取 game 回合 → 桩模型按合法出牌答 →
//      POST /turns/:id 推进），打到结算：断言 seat_fee 扣除、game_win 发放、底池守恒、SUM==balance。
//   2) 开店 → 上货 → 别的鱼买货：店主 shop_sale 进账 / 买家 buy 扣款 / 库存减。
//   3) 发悬赏 → 接 → 交：赏金从 poster 转到 taker（reason=bounty）。
//   4) 公开只读：GET /api/public/{lobby,table/:id,board,paper} 返回真实数据。
//
// 验收：node scripts/e2e/p2-full.mjs 退出码 0。真跑，不编。
// 用法：node scripts/e2e/p2-full.mjs [--out report.txt]
import { writeFileSync } from 'node:fs'
import {
  startTestServer, createFishViaOwnerApi, residentApi, ledgerRows, sumByReason,
  ledgerSum, verifyBalance, assert, assertEqual, money, pad, maskCode,
} from './lib.mjs'
import { legalPlays } from '../../packages/games/src/index.ts'

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null

const lines = []
function out(s = '') { console.log(s); lines.push(s) }
function rule(ch = '─', n = 72) { out(ch.repeat(n)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SEAT_FEE = 10
const GAME_START = 200
const SHOP_PRICE = 9
const SHOP_QTY = 2
const BOUNTY_REWARD = 30

const failures = []
function fail(msg) { failures.push(msg); out(`      ❌ ${msg}`) }
function check(name, ok, detail = '') { out(`    ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(name + (detail ? '（' + detail + '）' : '')) }

function bal(db, id) { return db.prepare('SELECT balance FROM fish WHERE id = ?').get(id).balance }

// —— 主流程（为清晰把实现放在单独函数，用同一 server 实例） ——
async function run() {
  const adminToken = 'p2-admin-' + Math.floor(Math.random() * 1e9)
  const srv = await startTestServer({ adminToken })
  const base = srv.base
  const db = srv.db
  const driver = srv.app.driver
  const fishes = {} // name -> { id, code, api }
  let okExit = true
  try {
    out('='.repeat(72))
    out(' 鱼缸小镇 · P2 全链路端到端验收（对局 / 开店 / 悬赏 / 公开只读）')
    out('='.repeat(72))
    out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
    out(`Node 版本  : ${process.version}`)
    out(`验证命令   : node scripts/e2e/p2-full.mjs`)
    out('')

    out(`临时 DB    : ${srv.dbPath}`)
    out(`服务端     : ${base}  （Fastify · 临时库 · 随机端口 ${srv.port} · 真种子 + P2 接线）`)
    out('')

    // ---- 造鱼 ----
    out('[0] 造鱼（owner API）')
    const names = ['阿甲', '阿乙', '阿丙']
    for (const name of names) {
      const created = await createFishViaOwnerApi(base, adminToken, { name, balance: GAME_START })
      fishes[name] = { id: created.fish.id, code: created.code, api: residentApi(base, created.code) }
      out(`    ${name}: id=${created.fish.id} 余额=${created.fish.balance} 码=${maskCode(created.code)}`)
    }
    const [A, B, C] = names.map((n) => fishes[n])
    const gameFish = [A, B, C]
    const beforeGame = Object.fromEntries(gameFish.map((f) => [f.id, bal(db, f.id)]))
    const sumBeforeGame = Object.values(beforeGame).reduce((a, b) => a + b, 0)
    out('')

    // ================= [1] 斗地主对局 =================
    out(`[1] 斗地主对局：3 鱼开桌/入座（seat_fee=${SEAT_FEE}/人）→ 真 game 回合 → 合法出牌 → 结算`)
    const seats = []
    for (const f of gameFish) {
      const r = await f.api.post('/play', { game: 'ddz', seat_fee: SEAT_FEE })
      if (r.status !== 200) throw new Error(`/play 失败：${r.status} ${JSON.stringify(r.body)}`)
      seats.push(r)
    }
    const tableId = seats[0].body.table.id
    let t = driver.getTable(tableId)
    assert(t, '应从 driver 拿到牌桌')

    check('3 条鱼都已入座，牌桌开局（status=playing）', t.players.length === 3 && t.status === 'playing', `players=${t.players.length} status=${t.status}`)
    check('入座即扣座位费（每条鱼 seat_fee -' + SEAT_FEE + '）', gameFish.every((f) => bal(db, f.id) === GAME_START - SEAT_FEE), gameFish.map((f) => `${f.id.slice(0, 6)}=${bal(db, f.id)}`).join(' '))
    const seatFeeRows = db.prepare(`SELECT SUM(delta) AS s FROM ledger WHERE reason='seat_fee' AND fish_id IN (?,?,?)`).get(A.id, B.id, C.id)
    check('账本 seat_fee 合计 = -' + SEAT_FEE * 3, Number(seatFeeRows.s) === -SEAT_FEE * 3, `sum=${seatFeeRows.s}`)
    out(`    牌桌 ${tableId}：game=ddz，seats=${t.seats}，seatFee=${t.seatFee}，开局玩家=${t.players.map((p) => p.seat + ':' + p.fishId.slice(0, 6)).join(' ')}`)

    // 逐手：driver.nextTurn → 该鱼 GET /turns 取 game 回合 → 按合法出牌回答
    const apiById = Object.fromEntries(gameFish.map((f) => [f.id, f.api]))
    let moves = 0
    let doneInfo = null
    while (moves < 600) {
      const tt = driver.getTable(tableId)
      if (!tt || tt.status !== 'playing' || !tt.session) break
      const turnFishId = driver.nextTurn(tableId)
      if (!turnFishId) break
      const seat = tt.players.find((p) => p.fishId === turnFishId).seat
      const session = tt.session
      const hand = session.hands[seat] || []
      const lastPlay = session.last ? session.last.play : null
      const plays = legalPlays(hand, lastPlay)
      const action = plays.length ? { type: 'play', cards: plays[0] } : { type: 'pass' }
      // 真长轮询取该鱼的 game 回合
      let turn = null
      for (let tries = 0; tries < 60 && !turn; tries++) {
        const res = await apiById[turnFishId].get('/turns?wait=0&kinds=game')
        const arr = (res.body && res.body.turns) || []
        turn = arr.find((x) => x.kind === 'game') || null
        if (!turn) await sleep(5)
      }
      if (!turn) { fail(`拿不到 ${turnFishId.slice(0, 6)} 的 game 回合（第 ${moves + 1} 手）`); break }
      const ans = await apiById[turnFishId].post(`/turns/${turn.turn_id}`, { answer: JSON.stringify({ action }) })
      if (ans.status !== 200) { fail(`第 ${moves + 1} 手 answer 失败：${ans.status} ${JSON.stringify(ans.body)}`); break }
      moves++
      if (ans.body.done) { doneInfo = ans.body; break }
    }
    t = driver.getTable(tableId)
    check('对局能走到终局（table.status=done）', !!t && t.status === 'done', `status=${t && t.status} moves=${moves}`)
    const settlement = doneInfo && doneInfo.settlement
    check('终局带 settlement（赢家/底池/分配）', !!settlement && Array.isArray(settlement.shares), settlement ? `winners=${JSON.stringify(settlement.winners)} pot=${settlement.pot}` : '无')
    out(`    对局共 ${moves} 手；终局底池 pot=${settlement?.pot}，赢家 seat=${JSON.stringify(settlement?.winners)}，分配=${JSON.stringify(settlement?.shares)}`)

    // 结算断言
    const seatToFish = Object.fromEntries(t.players.map((p) => [p.seat, p.fishId]))
    const payoutByFish = {}
    for (const sh of settlement.shares) payoutByFish[seatToFish[sh.seat]] = sh.amount
    const gameWinRows = db.prepare(`SELECT SUM(delta) AS s FROM ledger WHERE reason='game_win' AND fish_id IN (?,?,?)`).get(A.id, B.id, C.id)
    check('底池守恒：game_win 发放总额 == seat_fee 收取总额（' + SEAT_FEE * 3 + '）', Number(gameWinRows.s) === SEAT_FEE * 3 && Number(gameWinRows.s) === Number(settlement.pot), `game_win=${gameWinRows.s} pot=${settlement.pot}`)
    out('')
    out(`    ${pad('鱼', 8)}${pad('开局', 8)}${pad('seat_fee', 10)}${pad('game_win', 10)}${pad('结算后', 8)}${pad('账本SUM', 10)}${pad('守恒', 6)}`)
    let sumAfterGame = 0
    let allLedgerOk = true
    for (const f of gameFish) {
      const rows = ledgerRows(db, f.id)
      const byReason = sumByReason(rows)
      const sf = byReason.get('seat_fee') ?? 0
      const gw = byReason.get('game_win') ?? 0
      const after = bal(db, f.id)
      const sum = ledgerSum(db, f.id)
      const vb = verifyBalance(db, f.id)
      const okv = sum === after && vb.ok === true
      if (!okv) allLedgerOk = false
      sumAfterGame += after
      out(`    ${pad(f.id.slice(0, 6), 8)}${pad(beforeGame[f.id], 8)}${pad(money(sf), 10)}${pad(money(gw), 10)}${pad(after, 8)}${pad(sum, 10)}${pad(okv ? '✔' : '✗', 6)}`)
      // 单鱼守恒：开局 -seatFee +payout == 结算后
      const expect = beforeGame[f.id] - SEAT_FEE + (payoutByFish[f.id] || 0)
      check(`  ${f.id.slice(0, 6)} 余额守恒（开局-座位费+赢得=${expect}）`, after === expect, `after=${after}`)
    }
    check('全桌账本 SUM==balance（3 条鱼）', allLedgerOk)
    check('全桌总余额守恒（对局前后总额不变）', sumAfterGame === sumBeforeGame, `${sumBeforeGame}→${sumAfterGame}`)
    out('')

    // ================= [2] 开店买货 =================
    out('[2] 开店 → 上货 → 别的鱼买货（店主 shop_sale / 买家 buy / 库存减）')
    const owner = A // 店主 = 阿甲
    const buyer = B // 买家 = 阿乙
    const beforeOwnerShop = bal(db, owner.id)
    const beforeBuyerShop = bal(db, buyer.id)
    const open = await owner.api.post('/shop/open', { name: '阿甲杂货铺', kind: 'general' })
    check('/shop/open 开店成功', open.status === 200 && open.body.ok && open.body.shop?.id, open.status === 200 ? `shop=${open.body.shop?.id}` : JSON.stringify(open.body))
    const shopId = open.body.shop.id
    const stock = await owner.api.post('/shop/stock', { item: '小鱼干', price: SHOP_PRICE, stock: 5 })
    check('/shop/stock 上货成功', stock.status === 200 && stock.body.ok, JSON.stringify(stock.body.shop?.items?.map((i) => `${i.name}@${i.price}x${i.stock}`)))
    const item = stock.body.shop.items.find((i) => i.name === '小鱼干')
    assert(item, '上货后应有「小鱼干」')
    const buy = await buyer.api.post('/shop/buy', { item_id: item.id, qty: SHOP_QTY })
    check('别的鱼买货成功', buy.status === 200 && buy.body.ok, buy.status === 200 ? JSON.stringify(buy.body.order) : JSON.stringify(buy.body))
    const order = buy.body.order
    const afterOwnerShop = bal(db, owner.id)
    const afterBuyerShop = bal(db, buyer.id)
    const stockAfter = db.prepare('SELECT stock FROM shop_item WHERE id = ?').get(item.id).stock
    check('买家 buy 扣款 = -成交额', afterBuyerShop - beforeBuyerShop === -order.total, `${beforeBuyerShop}→${afterBuyerShop}（${money(afterBuyerShop - beforeBuyerShop)}）`)
    check('店主 shop_sale 进账 = +成交额', afterOwnerShop - beforeOwnerShop === order.total, `${beforeOwnerShop}→${afterOwnerShop}（${money(afterOwnerShop - beforeOwnerShop)}）`)
    check('库存减少（5→' + (5 - SHOP_QTY) + '）', stockAfter === 5 - SHOP_QTY, `stock=${stockAfter}`)
    const buyerBuy = sumByReason(ledgerRows(db, buyer.id)).get('buy') ?? 0
    const ownerSale = sumByReason(ledgerRows(db, owner.id)).get('shop_sale') ?? 0
    check('账本买家 reason=buy 合计 = -成交额', buyerBuy === -order.total, `buy=${money(buyerBuy)}`)
    check('账本店主 reason=shop_sale 合计 = +成交额', ownerSale === order.total, `shop_sale=${money(ownerSale)}`)
    out(`    「${item.name}」${SHOP_PRICE}/件 × ${SHOP_QTY} = ${order.total} 鱼币；库存 5→${stockAfter}；买家 ${money(-order.total)}、店主 ${money(order.total)}`)
    out('')

    // ================= [3] 悬赏 =================
    out('[3] 悬赏：发 → 接 → 交（赏金从 poster 转 taker，reason=bounty）')
    const poster = C // 阿丙
    const taker = A // 阿甲
    const beforePoster = bal(db, poster.id)
    const beforeTaker = bal(db, taker.id)
    const post = await poster.api.post('/bounties', { title: '找回走失的小海龟', desc: '在码头附近走丢', reward: BOUNTY_REWARD })
    check('发悬赏成功', post.status === 200 && post.body.ok && post.body.bounty?.id, post.status === 200 ? `bounty=${post.body.bounty?.id} reward=${post.body.bounty?.reward}` : JSON.stringify(post.body))
    const bountyId = post.body.bounty.id
    const take = await taker.api.post('/bounties/take', { bounty_id: bountyId })
    check('接悬赏成功（state=taken）', take.status === 200 && take.body.bounty?.state === 'taken', take.status === 200 ? `state=${take.body.bounty?.state}` : JSON.stringify(take.body))
    const claim = await taker.api.post('/bounties/claim', { bounty_id: bountyId })
    check('交差领赏成功（state=done）', claim.status === 200 && claim.body.bounty?.state === 'done', claim.status === 200 ? `state=${claim.body.bounty?.state}` : JSON.stringify(claim.body))
    const afterPoster = bal(db, poster.id)
    const afterTaker = bal(db, taker.id)
    check('赏金从 poster 扣除 = -' + BOUNTY_REWARD, beforePoster - afterPoster === BOUNTY_REWARD, `${beforePoster}→${afterPoster}（${money(afterPoster - beforePoster)}）`)
    check('赏金进 taker = +' + BOUNTY_REWARD, afterTaker - beforeTaker === BOUNTY_REWARD, `${beforeTaker}→${afterTaker}（${money(afterTaker - beforeTaker)}）`)
    const posterBounty = ledgerRows(db, poster.id).filter((r) => r.reason === 'bounty').reduce((a, r) => a + Number(r.delta), 0)
    const takerBounty = ledgerRows(db, taker.id).filter((r) => r.reason === 'bounty').reduce((a, r) => a + Number(r.delta), 0)
    check('账本 poster reason=bounty = -' + BOUNTY_REWARD, posterBounty === -BOUNTY_REWARD, `bounty=${money(posterBounty)}`)
    check('账本 taker reason=bounty = +' + BOUNTY_REWARD, takerBounty === BOUNTY_REWARD, `bounty=${money(takerBounty)}`)
    out(`    悬赏「${post.body.bounty.title}」赏金 ${BOUNTY_REWARD}：poster ${money(-BOUNTY_REWARD)}、taker ${money(+BOUNTY_REWARD)}`)
    out('')

    // ================= [4] 公开只读端点 =================
    out('[4] 公开只读：GET /api/public/lobby、/table/:id、/board、/paper')
    const lobby = await (await fetch(base + '/api/public/lobby')).json()
    const lobbyTable = (lobby.tables || []).find((x) => x.id === tableId)
    check('GET /api/public/lobby 返回真实牌桌（含本局 table）', lobby.ok === true && !!lobbyTable && lobbyTable.game === 'ddz', lobbyTable ? `state=${lobbyTable.state} seatFee=${lobbyTable.seatFee} pot=${lobbyTable.pot} seats=${lobbyTable.seats?.length}` : `tables=${lobby.tables?.length}`)
    check('lobby 含 games/places', Array.isArray(lobby.games) && lobby.games.length > 0 && Array.isArray(lobby.places), `games=${(lobby.games || []).map((g) => g.id).join('/')} places=${(lobby.places || []).map((p) => p.id).join('/')}`)

    const tRes = await fetch(base + '/api/public/table/' + encodeURIComponent(tableId))
    const tBody = await tRes.json()
    check('GET /api/public/table/:id 返回真实单桌详情', tRes.status === 200 && tBody.ok && tBody.table?.id === tableId && tBody.table?.game === 'ddz', tRes.status === 200 ? `pot=${tBody.table.pot} seatFee=${tBody.table.seatFee} seats=${tBody.table.seats?.length} round=${tBody.table.round}` : JSON.stringify(tBody))

    const board = await (await fetch(base + '/api/public/board')).json()
    const entries = board.entries || []
    const winnerFishId = seatToFish[settlement.winners[0]]
    const winEntry = entries.find((e) => e.fishId === winnerFishId)
    check('GET /api/public/board 返回排行榜', board.ok === true && entries.length >= 3 && entries.every((e) => 'rank' in e && 'fishId' in e && 'balance' in e && 'wins' in e && 'net' in e), `entries=${entries.length}`)
    check('排行榜里赢家 wins>=1 且 net>0', !!winEntry && winEntry.wins >= 1 && winEntry.net > 0, winEntry ? `wins=${winEntry.wins} net=${winEntry.net}` : '未找到赢家')

    const paper = await (await fetch(base + '/api/public/paper')).json()
    const items = paper.items || []
    check('GET /api/public/paper 返回真实动态条目', paper.ok === true && items.length > 0 && items.every((i) => i.id && i.kind && typeof i.ts === 'number' && 'title' in i && 'summary' in i), `items=${items.length}`)
    out(`    lobby: tables=${lobby.tables.length}（本局 state=${lobbyTable?.state} pot=${lobbyTable?.pot}）；games=${lobby.games.length} places=${lobby.places.length}`)
    out(`    table: id=${tBody.table?.id} game=${tBody.table?.game} pot=${tBody.table?.pot} seats=${tBody.table?.seats?.length}`)
    out(`    board: entries=${entries.length}，赢家 ${winEntry?.name} wins=${winEntry?.wins} net=${winEntry?.net}`)
    out(`    paper: items=${items.length}（如「${items[0]?.title}」kind=${items[0]?.kind}）`)
    out('')

    // ================= 全账本不变量 =================
    rule('-', 44)
    let allOk = true
    for (const f of gameFish) { const vb = verifyBalance(db, f.id); if (!vb.ok) allOk = false }
    check('全部鱼账本不变量 SUM(ledger.delta)==balance', allOk)
    out('')

    rule('=')
    const pass = failures.length === 0
    if (pass) out('✅ P2 全链路通过：对局结算(底池守恒) / 开店买货(shop_sale·buy·库存) / 悬赏(bounty 转移) / 公开只读端点（lobby·table·board·paper）均真跑通过。')
    else { out(`❌ P2 全链路发现 ${failures.length} 项问题：`); for (const f of failures.slice(0, 40)) out('   - ' + f) }
    rule('=')
    okExit = pass
  } catch (e) {
    fail(`运行异常：${e?.stack ?? e}`)
    okExit = false
  } finally {
    try { await srv.close() } catch { /* ignore */ }
    if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  }
  process.exit(okExit ? 0 : 1)
}

run().catch(async (err) => {
  console.error('\n❌ p2-full 运行失败：', err?.stack ?? err)
  if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  process.exit(1)
})
