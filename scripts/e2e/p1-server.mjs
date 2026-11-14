// scripts/e2e/p1-server.mjs — P1 服务端经济闭环端到端验证（真跑，不 mock 经济）。
//
// 覆盖：起临时服务端 → 造带 fbr_ 的鱼（优先 HTTP 主人 API）→ 回合(agency→answer)
//       → 打工(take→tick 结算) → 钓鱼卖钱(goto do=fish → sell) → 座位费(paySeatFee)
//       → 账本不变量校验（SUM(ledger.delta) == fish.balance）。
// 验收：退出码 0；stdout 是一份可直接贴进 docs 的真实证据报告。
//
// 用法：
//   node scripts/e2e/p1-server.mjs                 # 跑并把报告打到 stdout
//   node scripts/e2e/p1-server.mjs --out report.md # 同时把同一份报告写文件（供 docs 引用）
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  startTestServer,
  createResidentFish,
  createFishViaOwnerApi,
  residentApi,
  ledgerRows,
  sumByReason,
  createJobOffer,
  paySeatFee,
  verifyBalance,
  ledgerSum,
  assert,
  assertEqual,
  money,
  maskCode,
  pad,
} from './lib.mjs'

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null

// 报告缓冲：既实时打印，也在结束时落盘（--out）。
const lines = []
function out(s = '') {
  console.log(s)
  lines.push(s)
}
function rule(ch = '─', n = 66) {
  out(ch.repeat(n))
}

const START_BALANCE = 100
const FISH_TIMES = 3 // 去码头钓 3 次，每次 1 条「小鱼」
const FISH_PRICE = 5 // 小鱼市场价（domain/fishing.ts）
const SEAT_FEE = 12
const ADMIN_TOKEN = 'e2e-admin-' + randomBytes(6).toString('hex')

async function main() {
  out('='.repeat(66))
  out(' 鱼缸小镇 · P1 服务端经济闭环 e2e（真跑，不 mock）')
  out('='.repeat(66))
  out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
  out(`Node 版本  : ${process.version}`)
  out(`验证命令   : node scripts/e2e/p1-server.mjs`)
  out('')

  // ---- 0. 起服务端（临时 DB + 随机端口，跑真实 boot：含种子镇民/招工） ----
  const srv = await startTestServer({ adminToken: ADMIN_TOKEN })
  try {
    out(`临时 DB    : ${srv.dbPath}`)
    out(`服务端     : ${srv.base}  （Fastify · 临时库 · 随机端口 ${srv.port}）`)
    const health = await fetch(srv.base + '/healthz').then((r) => r.json())
    out(`healthz    : ok=${health.ok} service=${health.service}`)
    out('')

    // ---- 1. 造一条带 fbr_ 接入码的鱼（优先 HTTP 主人 API） ----
    out('[1] 造鱼：优先用 t7 主人 API（POST /api/owner/fish，ADMIN_TOKEN 保护）；不可用则回退 db 直连')
    let fish
    let code
    let fishVia
    try {
      const created = await createFishViaOwnerApi(srv.base, ADMIN_TOKEN, { name: 'e2e小鱼', balance: START_BALANCE })
      fish = created.fish
      code = created.code
      fishVia = 'HTTP 主人 API（POST /api/owner/fish）'
    } catch (e) {
      out(`    · 主人 API 不可用（${e.status ?? '?'}），回退 db.createFish + api/auth.issueResidentCode`)
      const created = createResidentFish(srv.db, { name: 'e2e小鱼', balance: START_BALANCE })
      fish = created.fish
      code = created.code
      fishVia = 'db 直连（回退）'
    }
    const api = residentApi(srv.base, code)
    out(`    建鱼途径   : ${fishVia}`)
    out(`    fish_id    : ${fish.id}`)
    out(`    昵称       : ${fish.name}`)
    out(`    初始余额   : ${fish.balance} 鱼币`)
    out(`    接入码     : ${maskCode(code)}（脱敏）`)
    assertEqual(fish.balance, START_BALANCE, '初始余额应等于 START_BALANCE')
    out('')

    // ---- 2. 回合：agency → answer ----
    const got = await api.get('/turns?wait=1&kinds=agency')
    assertEqual(got.status, 200, 'GET /turns 应 200')
    const turns = got.body.turns
    assert(Array.isArray(turns) && turns.length >= 1, 'GET /turns 应至少拿到 1 个回合')
    const agency = turns.find((t) => t.kind === 'agency') ?? turns[0]
    assertEqual(agency.kind, 'agency', '首个回合应是 agency')
    out('[2] 回合：GET /turns?kinds=agency → POST /turns/:id（agency 拿主意）')
    out(`    → GET  /turns  200，回合 ${agency.turn_id}（kind=${agency.kind}，messages=${agency.packet.messages.length} 条，actions=[${(agency.packet.actions ?? []).join(', ')}]）`)
    const ans = await api.post(`/turns/${agency.turn_id}`, {
      answer: JSON.stringify({ action: 'pier', note: '去码头钓鱼赚钱' }),
    })
    assertEqual(ans.status, 200, 'POST /turns/:id 应 200')
    assertEqual(ans.body.receipt.ok, true, '回答回执应 ok')
    out(`    → POST /turns/${agency.turn_id}  {answer:{"action":"pier",...}}  200，receipt.ok=${ans.body.receipt.ok}，balance=${ans.body.receipt.balance}`)
    assertEqual(ans.body.receipt.balance, START_BALANCE, '拿主意不发钱，余额应不变')
    out(`    余额不变：${START_BALANCE} 鱼币（拿主意/走路不发钱）`)
    out('')

    // ---- 3. 赚钱·打工：GET /jobs（镇上已有招工）→ POST /jobs/take → engine.tick 结算 ----
    let jobs = await api.get('/jobs')
    assertEqual(jobs.status, 200, 'GET /jobs 应 200')
    if (!jobs.body.jobs.length) {
      // 极端兜底：种子里没有招工时，手工挂一个（不影响被测的经济闭环逻辑）
      createJobOffer(srv.db, { title: '临时帮工', pay: 20, durationMin: 1, place: 'pier' })
      jobs = await api.get('/jobs')
    }
    const offer = [...jobs.body.jobs].filter((j) => j.available > 0).sort((a, b) => b.pay - a.pay)[0]
    assert(offer, '应有一个可接的招工（available > 0）')
    const JOB_PAY = offer.pay
    out('[3] 赚钱·打工：GET /jobs（镇上种子招工）→ POST /jobs/take → engine.tick 到期结算')
    out(`    → GET  /jobs  200，共 ${jobs.body.jobs.length} 个招工；接最高薪「${offer.title}」pay=${offer.pay} 时长=${offer.duration_min}min 余 ${offer.available} 位`)
    const take = await api.post('/jobs/take', { offer_id: offer.id })
    assertEqual(take.status, 200, 'POST /jobs/take 应 200')
    assertEqual(take.body.contract.state, 'working', '接活后合同应为 working')
    assertEqual(take.body.contract.pay, JOB_PAY, '合同 pay 应等于招工 pay')
    out(`    → POST /jobs/take {offer_id:${offer.id}}  200，contract=${take.body.contract.id} state=working pay=${take.body.contract.pay}`)
    const beforeJob = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    // 推进时间至合同到期并结算（等价 sim tick）。
    const tickRes = srv.engine.tick(Date.now() + (offer.duration_min + 1) * 60_000)
    const settled = tickRes.settledJobs.find((j) => j.contractId === take.body.contract.id)
    assert(settled, 'tick 应结算我们这条合同')
    assertEqual(settled.pay, JOB_PAY, '结算 pay 应等于招工 pay')
    const afterJob = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    assertEqual(afterJob - beforeJob, JOB_PAY, '结算后余额应增加 JOB_PAY')
    const jobLedger = ledgerRows(srv.db, fish.id).filter((r) => r.reason === 'job')
    assertEqual(jobLedger.length, 1, '应有且仅有 1 条 reason=job 账本')
    assertEqual(jobLedger[0].delta, JOB_PAY, 'job 账本 delta 应为 +JOB_PAY')
    out(`    → engine.tick(+${offer.duration_min + 1}min) 结算 → settledJobs=${tickRes.settledJobs.length}（contract ${settled.contractId}, pay=${settled.pay}）`)
    out(`    余额 ${beforeJob} → ${afterJob}（${money(afterJob - beforeJob)}）`)
    out(`    账本       : job        ${money(jobLedger[0].delta)}  (ref=${jobLedger[0].ref})`)
    out('')

    // ---- 4. 赚钱·钓鱼卖钱：goto(pier,do=fish) ×3 → sell ----
    out(`[4] 赚钱·钓鱼卖钱：POST /goto(pier,do=fish) ×${FISH_TIMES} → GET /market → POST /sell`)
    for (let i = 1; i <= FISH_TIMES; i++) {
      const go = await api.post('/goto', { place: 'pier', do: 'fish' })
      assertEqual(go.status, 200, `第 ${i} 次 POST /goto 应 200`)
      assertEqual(go.body.outcome.item, '小鱼', '钓鱼产出应是「小鱼」')
      out(`    → POST /goto {place:pier,do:fish}  200，产出 ${go.body.outcome.item}×${go.body.outcome.qty}（catch_id=${go.body.outcome.catch_id}）`)
    }
    const market = await api.get('/market')
    assertEqual(market.status, 200, 'GET /market 应 200')
    const holding = market.body.catch.find((h) => h.item === '小鱼')
    assert(holding && holding.qty === FISH_TIMES, `鱼获应有 小鱼×${FISH_TIMES}`)
    assertEqual(holding.price, FISH_PRICE, `小鱼市场价应为 ${FISH_PRICE}`)
    out(`    → GET  /market  200，鱼获：${holding.item}×${holding.qty}，市场价 ${holding.price}/条`)
    const beforeFish = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    const sell = await api.post('/sell', { item: '小鱼', qty: FISH_TIMES })
    assertEqual(sell.status, 200, 'POST /sell 应 200')
    const expectFishAmount = FISH_PRICE * FISH_TIMES
    assertEqual(sell.body.sale.amount, expectFishAmount, '卖鱼所得应 = 单价×数量')
    const afterFish = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    assertEqual(afterFish - beforeFish, expectFishAmount, '卖鱼后余额应增加所得')
    const fishLedger = ledgerRows(srv.db, fish.id).filter((r) => r.reason === 'fish_sell')
    assertEqual(fishLedger.length, 1, '应有且仅有 1 条 reason=fish_sell 账本')
    assertEqual(fishLedger[0].delta, expectFishAmount, 'fish_sell 账本 delta 应为 +所得')
    out(`    → POST /sell {item:"小鱼", qty:${FISH_TIMES}}  200，sale.amount=${sell.body.sale.amount}（${holding.price}×${FISH_TIMES}）`)
    out(`    余额 ${beforeFish} → ${afterFish}（${money(afterFish - beforeFish)}）`)
    out(`    账本       : fish_sell  ${money(fishLedger[0].delta)}  (ref=${fishLedger[0].ref})`)
    out('')

    // ---- 5. 花钱·座位费：domain.paySeatFee ----
    out('[5] 花钱·座位费：domain.paySeatFee(fee=' + SEAT_FEE + ', ref=table_e2e)（自由消费走同一条 postLedger 通道）')
    const beforeSeat = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    const seat = paySeatFee(srv.db, fish.id, { fee: SEAT_FEE, ref: 'table_e2e' })
    assertEqual(seat.spent, SEAT_FEE, '座位费 spent 应等于 fee')
    const afterSeat = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    assertEqual(beforeSeat - afterSeat, SEAT_FEE, '扣座位费后余额应减少')
    const seatLedger = ledgerRows(srv.db, fish.id).filter((r) => r.reason === 'seat_fee')
    assertEqual(seatLedger.length, 1, '应有且仅有 1 条 reason=seat_fee 账本')
    assertEqual(seatLedger[0].delta, -SEAT_FEE, 'seat_fee 账本 delta 应为 -fee')
    out(`    → paySeatFee 返回 spent=${seat.spent}，余额 ${beforeSeat} → ${seat.balance}（${money(seat.balance - beforeSeat)}）`)
    out(`    账本       : seat_fee   ${money(seatLedger[0].delta)}  (ref=${seatLedger[0].ref})`)
    out('')

    // ---- 6. 账本 & 不变量校验 ----
    out('[6] 账本全量 & 不变量校验（SUM(ledger.delta) == fish.balance）')
    const rows = ledgerRows(srv.db, fish.id)
    out(`    （id 从 ${rows[0].id} 起，是因为种子先建了 6 条 NPC，其 init 账本占了前面几个 id；以下只列这条鱼的账本）`)
    out(`    ${pad('id', 3)}${pad('delta', 8)}${pad('balance_after', 15)}${pad('reason', 12)}${pad('ref', 14)}`)
    for (const r of rows) {
      out(`    ${pad(r.id, 3)}${pad(money(r.delta), 8)}${pad(r.balance_after, 15)}${pad(r.reason, 12)}${pad(r.ref ?? '', 14)}`)
    }
    const byReason = sumByReason(rows)
    const sum = ledgerSum(srv.db, fish.id)
    const bal = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    const check = verifyBalance(srv.db, fish.id)
    assertEqual(sum, bal, 'SUM(ledger.delta) 应等于 fish.balance')
    assertEqual(check.ok, true, 'verifyBalance.ok 应为 true')
    // 正向 reason 与 负向 reason 都要真实存在
    assert(byReason.get('job') === JOB_PAY, '账本应含 reason=job 正向收入')
    assert(byReason.get('fish_sell') === FISH_PRICE * FISH_TIMES, '账本应含 reason=fish_sell 正向收入')
    assert(byReason.get('seat_fee') === -SEAT_FEE, '账本应含 reason=seat_fee 负向支出')
    rule('-', 44)
    out(`    SUM(delta) = ${sum}  ；fish.balance = ${bal}  ；verifyBalance.ok = ${check.ok}`)
    out(`    含 job(${money(byReason.get('job'))}) / fish_sell(${money(byReason.get('fish_sell'))}) 正向，seat_fee(${money(byReason.get('seat_fee'))}) 负向 ✔`)
    out('')

    // ---- 7. 汇总：赚了多少 / 花多少 ----
    const earned = (byReason.get('job') ?? 0) + (byReason.get('fish_sell') ?? 0)
    const spent = -(byReason.get('seat_fee') ?? 0)
    out('[7] 汇总：赚了多少 / 花多少 / 净变化')
    out(`    初始余额      : ${START_BALANCE}`)
    out(`    打工赚 (job)  : ${money(byReason.get('job') ?? 0)}`)
    out(`    钓鱼卖钱赚    : ${money(byReason.get('fish_sell') ?? 0)}`)
    out(`    座位费花      : ${money(byReason.get('seat_fee') ?? 0)}`)
    rule('-', 30)
    out(`    总赚          : +${earned}`)
    out(`    总花          : -${spent}`)
    out(`    最终余额      : ${bal}  （净 ${money(bal - START_BALANCE)}）`)
    out('')
    out('='.repeat(66))
    out('✅ 全部断言通过：赚(job/fish_sell)已入库、花(seat_fee)已入库、SUM(ledger.delta)==fish.balance')
    out('='.repeat(66))

    if (outPath) {
      writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
      console.log(`\n（报告已写入 ${outPath}）`)
    }
  } finally {
    await srv.close()
  }
}

main().catch((err) => {
  console.error('\n❌ e2e 失败：', err?.stack ?? err)
  if (outPath) {
    try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ }
  }
  process.exitCode = 1
})
