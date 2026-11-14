// scripts/e2e/full-chain.mjs — P1 全链路端到端验收：鱼自己赚钱又花钱（插件 + 服务端 + web）。
//
// 复用真实组件，不 mock 经济：
//   · 起真服务端（临时 DB + 随机端口，含真实种子/主人 API/公开 API/静态托管）
//   · 造一条鱼（owner API）拿 fbr_ 接入码
//   · 把真插件（packages/plugin/lib/index.js）挂到 test/fake-dsh-host 上，指向这个真服务端：
//       - 插件长轮询取 turn → 她的模型（桩）回答 → 交回服务端（真实 agency 回合往返）
//       - /town work 接活 → engine.tick 到期结算（job +）
//       - /town go pier fish 钓鱼 → /town sell 卖鱼获（fish_sell +）
//       - 入座费经服务端座位费领域通道扣（seat_fee −；P1 插件尚未接游戏入座付费接口）
//       - /town status 看余额 + 今日赚/花
//   · web：GET / 首屏 + 静态资源可服务；GET /api/public/town、/api/public/fish/:id 返回真实数据
//   · 断言 ledger 同时含赚(job/fish_sell)与花(seat_fee)，且 SUM(ledger.delta)==fish.balance
//
// 验收：node scripts/e2e/full-chain.mjs 退出码 0。真跑，不编。
// 用法：node scripts/e2e/full-chain.mjs [--out report.txt]
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  startTestServer, createFishViaOwnerApi, ledgerRows, sumByReason,
  paySeatFee, verifyBalance, ledgerSum, maskCode, assert, assertEqual, money, pad,
} from './lib.mjs'
import { createFakeHost } from '../../packages/plugin/test/fake-dsh-host.mjs'
import { settleDueJobs } from '../../packages/server/src/domain/jobs.ts'

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const lines = []
function out(s = '') { console.log(s); lines.push(s) }
function rule(ch = '─', n = 70) { out(ch.repeat(n)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 20000, label = '') {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(120) }
  throw new Error('等待超时' + (label ? '：' + label : ''))
}

const ADMIN_TOKEN = 'e2e-admin-' + randomBytes(6).toString('hex')
const START_BALANCE = 100
const SEAT_FEE = 12
const FISH_TIMES = 3
const FISH_PRICE = 5 // 小鱼市场价

const failures = []
function fail(msg) { failures.push(msg); out(`      ❌ ${msg}`) }
function check(name, ok, detail = '') { out(`    ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(name + (detail ? '（' + detail + '）' : '')) }

async function main() {
  out('='.repeat(70))
  out(' 鱼缸小镇 · P1 全链路端到端验收：鱼自己赚钱又花钱（插件 + 服务端 + web）')
  out('='.repeat(70))
  out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
  out(`Node 版本  : ${process.version}`)
  out(`验证命令   : node scripts/e2e/full-chain.mjs`)
  out('')

  const srv = await startTestServer({ adminToken: ADMIN_TOKEN, engine: { agencyCooldownMs: 600000 } })
  const dshHome = mkdtempSync(join(tmpdir(), 'fishbowl-fullchain-home-'))
  process.env.DSH_HOME = dshHome
  const previousNodeEnv = process.env.NODE_ENV

  // 她的模型（桩）：agency 拿主意 → 返回 JSON；其它（activity/串门）→ 一句她的话
  const modelCalls = []
  function herModel({ history }) {
    const last = history[history.length - 1]?.text || ''
    modelCalls.push(last.replace(/\s+/g, ' ').slice(0, 48))
    if (/想做什么|拿主意|该你|接下来做什么/.test(last)) {
      return JSON.stringify({ action: 'none', note: '先看看有什么活可以干', next_wake: 30 })
    }
    return '海风真舒服呀，码头这会儿挺热闹。'
  }

  let host = null
  try {
    const base = srv.base
    out(`临时 DB    : ${srv.dbPath}`)
    out(`服务端     : ${base}  （Fastify · 临时库 · 随机端口 ${srv.port} · 真种子 + 主人/公开/静态）`)
    out(`DSH_HOME   : ${dshHome}`)
    out('')

    // ---- 1) 造鱼（owner API）+ 挂真插件指向真服务端 ----
    const created = await createFishViaOwnerApi(base, ADMIN_TOKEN, { name: '小圆子', balance: START_BALANCE })
    const fish = created.fish
    const code = created.code
    out('[1] 造鱼 + 挂真插件 → 真服务端')
    out(`    fish_id=${fish.id}  昵称=${fish.name}  初始余额=${fish.balance} 鱼币  接入码=${maskCode(code)}（脱敏）`)

    host = createFakeHost({ model: herModel, latencyMs: 10 })
    const pluginMod = await import('../../packages/plugin/lib/index.js?' + Math.random())
    pluginMod.apply(host.ctx, { code, base: `${base}/town/api/resident/`, eventsEverySeconds: 3600, answerWithinSeconds: 20 })
    out(`    插件已 apply（base=${base}/town/api/resident/，preset=fishbowl-town，零工具只带人设）；真长轮询已启动`)
    out('')

    // ---- 2) 真实 agency 回合往返：插件取回合 → 她的模型回答 → 交回服务端 ----
    const answeredAgency = await waitFor(() => {
      const r = srv.db.prepare("SELECT id, answer FROM turn WHERE fish_id = ? AND kind = 'agency' AND state = 'answered' ORDER BY created_at ASC LIMIT 1").get(fish.id)
      return r || null
    }, 20000, 'agency 回合被回答')
    let parsedAnswer = null
    try { parsedAnswer = JSON.parse(answeredAgency.answer) } catch { /* text */ }
    out('[2] 真实 agency 回合往返（插件长轮询取 turn → 她的模型 → POST turns/:id 交回）')
    out(`    服务端 turn ${answeredAgency.id} 已被插件回答；answer=${String(answeredAgency.answer).slice(0, 80)}`)
    out(`    她的模型被调用 ${modelCalls.length} 次（样例：${modelCalls.slice(0, 3).map((x) => '「' + x + '」').join(' ')}）`)
    check('插件确实取到并回答了一个真实 agency 回合', !!answeredAgency)
    check('回答内容来自她的模型（JSON 决策）', !!(parsedAnswer && parsedAnswer.action === 'none'), JSON.stringify(parsedAnswer))
    out('')

    // ---- 3) 她赚钱：接活 → 结算；钓鱼 → 卖鱼获 ----
    let r = await host.runCommand('town', 'jobs')
    check('/town jobs 能打到真服务端并列出招工', r.kind === 'success' && /还缺|能接的活/.test(r.text), r.text.split('\n')[0])
    out('[3] 她赚钱（真插件命令 → 真服务端 → 真 ledger）')
    out(`    /town jobs → ${r.text.split('\n').slice(0, 3).join(' / ')}`)

    // 接活：挑一个种子招工（码头帮工）
    r = await host.runCommand('town', 'work 码头帮工')
    check('/town work 接活成功', r.kind === 'success' && /接了/.test(r.text), r.text.replace(/\n/g, ' '))
    out(`    /town work 码头帮工 → ${r.text.replace(/\n/g, ' ')}`)
    const contract = srv.db.prepare("SELECT c.id, c.pay, c.ends_at, o.title FROM job_contract c JOIN job_offer o ON o.id = c.offer_id WHERE c.fish_id = ? AND c.state = 'working' ORDER BY c.started_at DESC LIMIT 1").get(fish.id)
    assert(contract, '应有一条 working 合同')
    const beforeJob = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    // 直接结算到期打工（只动 job_contract/ledger，不推进时间、不影响插件正在等的回合）
    const settled = settleDueJobs(srv.db, Number(contract.ends_at) + 1000)
    const afterJob = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    const jobDelta = afterJob - beforeJob
    check('到期结算把工钱记入余额', jobDelta === Number(contract.pay) && settled.length >= 1, `${beforeJob}→${afterJob}（${money(jobDelta)}，合同 pay=${contract.pay}）`)
    out(`    settleDueJobs 结算「${contract.title}」：余额 ${beforeJob} → ${afterJob}（${money(jobDelta)}）；settledJobs=${settled.length}`)

    // 钓鱼：去码头钓鱼 ×3（server goto do=fish 产出小鱼），再卖
    for (let i = 1; i <= FISH_TIMES; i++) {
      r = await host.runCommand('town', 'go pier fish')
      const catchN = srv.db.prepare('SELECT COALESCE(SUM(qty),0) AS c FROM catch WHERE fish_id = ?').get(fish.id).c
      out(`    /town go pier fish #${i} → ${r.text.replace(/\n/g, ' ').slice(0, 70)}（库内 catch=${catchN}）`)
      if (r.kind !== 'success') fail(`/town go pier fish 第 ${i} 次失败：${r.text}`)
    }
    const market = await host.runCommand('town', 'market')
    check('/town market 能看到鱼获与市场价', /小鱼/.test(market.text), market.text.replace(/\n/g, ' ').slice(0, 90))
    out(`    /town market → ${market.text.replace(/\n/g, ' ').slice(0, 110)}`)
    const beforeSell = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    r = await host.runCommand('town', 'sell 小鱼 ' + FISH_TIMES)
    const afterSell = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    const fishDelta = afterSell - beforeSell
    check('/town sell 卖鱼获把钱记入余额', r.kind === 'success' && fishDelta === FISH_PRICE * FISH_TIMES, `${beforeSell}→${afterSell}（${money(fishDelta)}）`)
    out(`    /town sell 小鱼 ${FISH_TIMES} → ${r.text.replace(/\n/g, ' ')}`)
    out('')

    // ---- 4) 她花钱：入座费（座位费领域通道；P1 插件未接游戏入座接口） ----
    out('[4] 她花钱：入座费（seat_fee）——经服务端座位费领域通道扣除（P1 插件尚未接游戏入座付费接口）')
    const beforeSeat = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    const seat = paySeatFee(srv.db, fish.id, { fee: SEAT_FEE, ref: 'table_e2e' })
    const afterSeat = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    check('入座费从余额扣除', beforeSeat - afterSeat === SEAT_FEE, `${beforeSeat}→${afterSeat}（${money(afterSeat - beforeSeat)}）`)
    out(`    paySeatFee(fee=${SEAT_FEE}, ref=table_e2e) → 余额 ${beforeSeat} → ${seat.balance}（${money(seat.balance - beforeSeat)}）`)

    // /town status：余额 + 今日赚/花
    r = await host.runCommand('town', 'status')
    check('/town status 返回余额与今日赚/花（鱼币）', r.kind === 'success' && /余额/.test(r.text) && /鱼币/.test(r.text), r.text.replace(/\n/g, ' ').slice(0, 100))
    out(`    /town status → ${r.text.replace(/\n/g, ' ').slice(0, 120)}`)
    out('')

    // ---- 5) 账本对账：同时含赚(job/fish_sell)与花(seat_fee)，SUM==balance ----
    out('[5] 账本对账（真 ledger：SUM(delta)==fish.balance）')
    const rows = ledgerRows(srv.db, fish.id)
    out(`    ${pad('id', 4)}${pad('delta', 8)}${pad('balance_after', 15)}${pad('reason', 12)}${pad('ref', 20)}`)
    for (const row of rows) out(`    ${pad(row.id, 4)}${pad(money(row.delta), 8)}${pad(row.balance_after, 15)}${pad(row.reason, 12)}${pad(row.ref ?? '', 20)}`)
    const byReason = sumByReason(rows)
    const bal = srv.db.prepare('SELECT balance FROM fish WHERE id = ?').get(fish.id).balance
    const sum = ledgerSum(srv.db, fish.id)
    const vb = verifyBalance(srv.db, fish.id)
    check('账本含赚 reason=job', (byReason.get('job') ?? 0) === Number(contract.pay), `job=${money(byReason.get('job') ?? 0)}`)
    check('账本含赚 reason=fish_sell', (byReason.get('fish_sell') ?? 0) === FISH_PRICE * FISH_TIMES, `fish_sell=${money(byReason.get('fish_sell') ?? 0)}`)
    check('账本含花 reason=seat_fee', (byReason.get('seat_fee') ?? 0) === -SEAT_FEE, `seat_fee=${money(byReason.get('seat_fee') ?? 0)}`)
    check('SUM(ledger.delta)==fish.balance', sum === bal && vb.ok === true, `SUM=${sum} balance=${bal} verify=${vb.ok}`)
    const earned = (byReason.get('job') ?? 0) + (byReason.get('fish_sell') ?? 0)
    const spent = -(byReason.get('seat_fee') ?? 0)
    rule('-', 40)
    out(`    她赚了多少：job ${money(byReason.get('job') ?? 0)} + fish_sell ${money(byReason.get('fish_sell') ?? 0)} = +${earned} 鱼币`)
    out(`    她花了多少：seat_fee ${money(byReason.get('seat_fee') ?? 0)} = -${spent} 鱼币`)
    out(`    余额变化：${START_BALANCE} → ${bal}（净 ${money(bal - START_BALANCE)}）；账本 SUM=${sum} == 余额 ${bal} ✔`)
    out('')

    // ---- 6) web：首屏/静态资源 + 公开只读 API 打真实服务端 ----
    out('[6] web 面板（真服务端静态托管 + 公开只读 API 真实数据）')
    const htmlRes = await fetch(base + '/')
    const html = await htmlRes.text()
    const assetMatch = /src="(\/assets\/[^"]+)"/.exec(html)
    const assetPath = assetMatch ? assetMatch[1] : null
    let assetOk = false
    let assetLen = 0
    if (assetPath) {
      const ares = await fetch(base + assetPath)
      const abuf = await ares.arrayBuffer()
      assetLen = abuf.byteLength
      assetOk = ares.status === 200 && assetLen > 0
    }
    check('GET / 首屏 HTML 200 且含 #root', htmlRes.status === 200 && /id="root"/.test(html), `status=${htmlRes.status} bytes=${html.length}`)
    check('静态资源（/assets/*.js）可服务', assetOk, `asset=${assetPath} bytes=${assetLen}`)
    out(`    GET / → ${htmlRes.status}，标题「${(/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '?'}」；静态 ${assetPath} → ${assetOk ? '200' : 'FAIL'}（${assetLen} bytes）`)

    const townRes = await fetch(base + '/api/public/town')
    const town = await townRes.json()
    const townOk = townRes.status === 200 && town?.town && Array.isArray(town.recent)
    check('GET /api/public/town 返回真实小镇数据', townOk, townOk ? `镇名=${town.town.name} onlineFish=${town.town.onlineFish} totalFish=${town.town.totalFish} 今日 net=${town.town.today?.net}` : `status=${townRes.status}`)
    const fishRes = await fetch(base + '/api/public/fish/' + encodeURIComponent(fish.id))
    const fj = await fishRes.json()
    const fishOk = fishRes.status === 200 && fj?.fish?.id === fish.id && Array.isArray(fj.ledger) && fj.ledger.length > 0 && fj?.stats?.entries > 0
    check('GET /api/public/fish/:id 返回真实名片+流水+stats', fishOk, fishOk ? `余额=${fj.fish.balance} 流水=${fj.ledger.length} 条 stats.entries=${fj.stats.entries}` : `status=${fishRes.status}`)
    if (townOk) out(`    GET /api/public/town → ${townRes.status}：镇「${town.town.name}」在线 ${town.town.onlineFish}/${town.town.totalFish}，今日赚/花/净 ${town.town.today?.earned}/${town.town.today?.spent}/${town.town.today?.net}，动态 ${town.recent.length} 条`)
    if (fishOk) out(`    GET /api/public/fish/:id → ${fishRes.status}：「${fj.fish.name}」余额 ${fj.fish.balance}，流水 ${fj.ledger.length} 条，stats={todayEarned:${fj.stats.todayEarned}, todaySpent:${fj.stats.todaySpent}, totalEarned:${fj.stats.totalEarned}, totalSpent:${fj.stats.totalSpent}}`)
    out('')

    // ---- 汇总 ----
    rule('=')
    if (failures.length === 0) {
      out(`✅ 全链路通过：她赚了 +${earned} 鱼币、花了 -${spent} 鱼币，余额 ${START_BALANCE}→${bal}，账本 SUM==余额；插件/服务端/web 均真实联通。`)
    } else {
      out(`❌ 全链路发现 ${failures.length} 项问题：`)
      for (const f of failures.slice(0, 30)) out('   - ' + f)
    }
    rule('=')
  } finally {
    try { await srv.close() } catch { /* ignore */ }
    try { await host?.dispose() } catch { /* ignore */ }
    await sleep(50)
    process.env.NODE_ENV = previousNodeEnv
    try { rmSync(dshHome, { recursive: true, force: true }) } catch { /* ignore */ }
    if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  }

  await sleep(30)
  process.exit(failures.length > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error('\n❌ full-chain 运行失败：', err?.stack ?? err)
  if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  await sleep(30)
  process.exit(1)
})
