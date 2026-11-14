// scripts/e2e/hardening.mjs — P1 健壮性与安全回归（真跑，不 mock）。
//
// [A] 账本随机压测：一条鱼随机执行 N=1000 次经济操作（打工结算/钓鱼卖出/座位费/买货），
//     每次之后断言 SUM(ledger.delta)==fish.balance 且 balance>=0 且为整数；结束再校验一次。
// [B] 并发不透支：余额 X 时并发 50 个座位费扣款（每笔 > X/50，总额远超余额），
//     断言绝不出现负余额、成功扣款总额<=X 且 = X-最终余额（无超卖/无透支）。
// [C] 鉴权/密钥：resident 无码/错码→401；admin 无/错 token→401；建鱼后库里 code_hash
//     只存 sha256（非明文）；比对 sha256(code)==code_hash。
// [D] 启动日志不泄漏：真起一个子进程服务端（日志落盘），HTTP 建鱼拿明文码后 grep 启动日志，
//     断言日志中没有出现明文 fbr_ 码。
//
// 验收：node scripts/e2e/hardening.mjs 退出码 0；stdout 是可直接贴进 docs 的真实证据报告。
//
// 用法：
//   node scripts/e2e/hardening.mjs                  # 跑并把报告打到 stdout
//   node scripts/e2e/hardening.mjs --out report.md  # 同时把同一份报告写文件（供 docs 引用）
import { writeFileSync, mkdtempSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'

import { getFish, newId } from '../../packages/server/src/db/index.ts'
import { createJobOffer, takeJob, settleDueJobs } from '../../packages/server/src/domain/jobs.ts'
import { addCatch, sellCatch } from '../../packages/server/src/domain/fishing.ts'
import { spend, ledgerSum, verifyBalance } from '../../packages/server/src/domain/account.ts'
import { paySeatFee } from '../../packages/server/src/domain/seat.ts'
import { hashCode } from '../../packages/server/src/api/auth.ts'
import {
  startTestServer,
  createResidentFish,
  createFishViaOwnerApi,
  residentApi,
  maskCode,
  assert,
  assertEqual,
  money,
  pad,
} from './lib.mjs'

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null

const lines = []
function out(s = '') { console.log(s); lines.push(s) }
function rule(ch = '─', n = 68) { out(ch.repeat(n)) }
function fnv(msg) { throw new Error('CHECK FAILED: ' + msg) }

const ADMIN_TOKEN = 'e2e-admin-' + randomBytes(6).toString('hex')
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// 固定随机种子 → 压测序列可复现
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}
async function waitHealth(base, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/healthz')
      if (r.ok) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}
function countOccurrences(hay, needle) {
  if (!needle) return 0
  let n = 0
  let i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length }
  return n
}

async function main() {
  out('='.repeat(68))
  out(' 鱼缸小镇 · P1 健壮性与安全回归（随机压测 / 并发不透支 / 鉴权与密钥）')
  out('='.repeat(68))
  out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
  out(`Node 版本  : ${process.version}`)
  out(`验证命令   : node scripts/e2e/hardening.mjs`)
  out('')

  const srv = await startTestServer({ adminToken: ADMIN_TOKEN })
  let allPass = true
  try {
    // ================= [A] 账本随机压测 =================
    out('[A] 账本随机压测（N=1000：打工结算 / 钓鱼卖出 / 座位费 / 买货）')
    const N = 1000
    const SEED = 0xc0ffee
    const rng = mulberry32(SEED)
    const randInt = (min, max) => min + Math.floor(rng() * (max - min + 1))
    const db = srv.db

    const { fish } = createResidentFish(db, { name: '压力测试鱼', balance: 200 })
    const offer = createJobOffer(db, { title: '压测短工', pay: 12, durationMin: 1, slots: 1_000_000 })
    // 给这条鱼配一个高库存的店/货，用于「买货」操作（价格 7/件）
    const shopOwner =
      (db.prepare(`SELECT id FROM fish WHERE kind = 'npc' LIMIT 1`).get())?.id ?? fish.id
    const shopId = newId('shop')
    db.prepare('INSERT INTO shop(id, owner_fish_id, name, kind, open, created_at) VALUES(?,?,?,?,1,?)').run(
      shopId, shopOwner, '压测杂货铺', 'general', Date.now(),
    )
    const itemId = newId('item')
    const BUY_PRICE = 7
    db.prepare('INSERT INTO shop_item(id, shop_id, name, price, stock, desc) VALUES(?,?,?,?,?,?)').run(
      itemId, shopId, '压测货', BUY_PRICE, 1_000_000_000, '',
    )

    let virtualNow = Date.now()
    const stats = {
      job: { try: 0, ok: 0, skip: 0 },
      fish: { try: 0, ok: 0, skip: 0 },
      seat: { try: 0, ok: 0, skip: 0 },
      buy: { try: 0, ok: 0, skip: 0 },
    }
    const isInsuff = (e) => e && (e.code === 'INSUFFICIENT' || e.code === 'DAY_CAP')

    function doJob() {
      stats.job.try++
      const t = virtualNow
      virtualNow += 60_000
      takeJob(db, fish.id, offer.id, t)
      settleDueJobs(db, virtualNow + 1)
      stats.job.ok++
    }
    function doFish() {
      stats.fish.try++
      const q = randInt(1, 3)
      addCatch(db, fish.id, '小鱼', q)
      sellCatch(db, fish.id, { item: '小鱼' })
      stats.fish.ok++
    }
    function doSeat() {
      stats.seat.try++
      const fee = randInt(1, 25)
      try { paySeatFee(db, fish.id, fee); stats.seat.ok++ } catch (e) { if (isInsuff(e)) stats.seat.skip++; else throw e }
    }
    function doBuy() {
      stats.buy.try++
      try {
        spend(db, fish.id, BUY_PRICE, 'buy', itemId)
        db.prepare('UPDATE shop_item SET stock = stock - 1 WHERE id = ?').run(itemId)
        db.prepare('INSERT INTO orders(id, buyer_fish_id, shop_id, item_id, qty, total, ts) VALUES(?,?,?,?,1,?,?)').run(
          newId('order'), fish.id, shopId, itemId, BUY_PRICE, Date.now(),
        )
        stats.buy.ok++
      } catch (e) { if (isInsuff(e)) stats.buy.skip++; else throw e }
    }

    let minBalance = Infinity
    let invariantChecked = 0
    for (let i = 1; i <= N; i++) {
      const bal = getFish(db, fish.id).balance
      let type
      if (bal < 30) {
        type = rng() < 0.5 ? 'job' : 'fish' // 钱少时强制做赚钱操作，避免一直饿死
      } else {
        const r = rng()
        type = r < 0.35 ? 'job' : r < 0.62 ? 'fish' : r < 0.85 ? 'seat' : 'buy'
      }
      try {
        if (type === 'job') doJob()
        else if (type === 'fish') doFish()
        else if (type === 'seat') doSeat()
        else doBuy()
      } catch (e) {
        fn(`第 ${i} 步操作「${type}」抛非预期错误：${e?.code ?? ''} ${e?.message ?? e}`)
      }
      // 每次之后断言经济不变量
      const f = getFish(db, fish.id)
      if (!Number.isInteger(f.balance)) fn(`第 ${i} 步后余额非整数：${f.balance}`)
      if (f.balance < 0) fn(`第 ${i} 步后余额为负：${f.balance}`)
      const s = ledgerSum(db, fish.id)
      if (s !== f.balance) fn(`第 ${i} 步后账本不变量破坏：SUM(delta)=${s} != balance=${f.balance}`)
      invariantChecked++
      if (f.balance < minBalance) minBalance = f.balance
    }
    const finalCheck = verifyBalance(db, fish.id)
    assertEqual(finalCheck.ok, true, '压测结束后 verifyBalance.ok 应为 true')
    out(`    鱼 ${fish.id}（起始 200 鱼币）；招工 pay=${offer.pay}/次；货价 ${BUY_PRICE}/件；随机种子 seed=${SEED}`)
    out(`    操作数 N=${N}`)
    out(`    ${pad('操作类型', 12)}${pad('尝试', 8)}${pad('成功', 8)}${pad('余额不足跳过', 14)}`)
    for (const [k, label] of [['job', '打工结算'], ['fish', '钓鱼卖出'], ['seat', '座位费'], ['buy', '买货']]) {
      const st = stats[k]
      out(`    ${pad(label, 12)}${pad(st.try, 8)}${pad(st.ok, 8)}${pad(st.skip, 14)}`)
      assert(st.try > 0, `压测应覆盖「${label}」`)
      assert(st.ok > 0, `「${label}」应至少成功一次`)
    }
    out(`    每次后断言 SUM(delta)==balance 且 balance>=0 且整数 —— ${invariantChecked}/${N} 全部通过`)
    out(`    观测到的最低余额 : ${minBalance}（>=0 ✔）`)
    out(`    结束账本不变量   : verifyBalance.ok=${finalCheck.ok}，SUM(delta)=${finalCheck.ledgerSum} == balance=${finalCheck.balance}`)
    out('    ✅ [A] 通过')
    out('')

    // ================= [B] 并发不透支 =================
    out('[B] 并发不透支（余额 X 时并发 50 个座位费请求，每笔 > X/50，总额远超余额）')
    const X = 100
    const FEE = 3 // > X/50 = 2，50×3 = 150 远超 100
    const CONC = 50
    const { fish: fish2 } = createResidentFish(db, { name: '并发透支测试鱼', balance: X })
    const before2 = getFish(db, fish2.id).balance
    assertEqual(before2, X, '并发鱼初始余额应为 X')

    // 同时发起 50 个扣费（同进程内经济写是同步串行的：DatabaseSync + BEGIN IMMEDIATE 保证逐笔原子）。
    const results = await Promise.allSettled(
      Array.from({ length: CONC }, () => Promise.resolve().then(() => paySeatFee(db, fish2.id, FEE))),
    )
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    const finalBal = getFish(db, fish2.id).balance
    const deducted = fulfilled.length * FEE
    const expectedSuccess = Math.floor(X / FEE) // 100/3 = 33
    const expectedBal = X - expectedSuccess * FEE // 1

    for (const r of rejected) {
      if (r.reason?.code !== 'INSUFFICIENT') fn(`并发扣费出现非 INSUFFICIENT 失败：${r.reason?.code} ${r.reason?.message}`)
    }
    assert(finalBal >= 0, `并发后余额不得为负：${finalBal}`)
    assert(deducted <= X, `成功扣款总额 ${deducted} 不得超过余额 X=${X}`)
    assertEqual(deducted, X - finalBal, '成功扣款总额应等于 X - 最终余额（账实一致）')
    assertEqual(fulfilled.length, expectedSuccess, `成功笔数应为 floor(X/fee)=${expectedSuccess}（无超卖）`)
    assertEqual(finalBal, expectedBal, `最终余额应为 X%fee=${expectedBal}`)
    assertEqual(ledgerSum(db, fish2.id), finalBal, '并发后账本不变量应成立')
    out(`    初始余额 X=${X}；并发 ${CONC} 笔，每笔 fee=${FEE}（> X/50=${X / 50}，总额 ${CONC * FEE} 远超 ${X}）`)
    out(`    成功扣款   : ${fulfilled.length} 笔 × ${FEE} = ${deducted}`)
    out(`    余额不足拒绝: ${rejected.length} 笔（code=INSUFFICIENT）`)
    out(`    最终余额   : ${finalBal}（>=0 ✔）；成功总额 ${deducted} <= ${X} ✔；${deducted}+${finalBal}=${X} == X ✔`)
    out(`    账本不变量 : SUM(delta)=${ledgerSum(db, fish2.id)} == balance=${finalBal} ✔`)
    out('    ✅ [B] 通过：无超卖、无透支')
    out('')

    // ================= [C] 鉴权 / 密钥不泄漏（库内只存 sha256） =================
    out('[C] 鉴权 / 密钥（resident 401、admin 401、库里只存 sha256）')
    const base = srv.base
    // C1 resident 无码
    const noCode = await fetch(base + '/town/api/resident/status')
    assertEqual(noCode.status, 401, 'resident 无码应 401')
    const noCodeBody = await noCode.json()
    assertEqual(noCodeBody.error, 'RESIDENT_CODE', 'resident 无码 error 应为 RESIDENT_CODE')
    // C2 resident 错码
    const badCode = await fetch(base + '/town/api/resident/status', { headers: { authorization: 'Bearer fbr_deadbeef' } })
    assertEqual(badCode.status, 401, 'resident 错码应 401')
    // C3 admin 无 token
    const noAdmin = await fetch(base + '/api/owner/fish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    assertEqual(noAdmin.status, 401, 'admin 无 token 应 401')
    const noAdminBody = await noAdmin.json()
    assertEqual(noAdminBody.error, 'UNAUTHORIZED', 'admin 无 token error 应为 UNAUTHORIZED')
    // C4 admin 错 token
    const badAdmin = await fetch(base + '/api/owner/fish', { method: 'POST', headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    assertEqual(badAdmin.status, 401, 'admin 错 token 应 401')
    // C5 admin 正确 token 建鱼（用于 sha256 校验）
    const created = await createFishViaOwnerApi(base, ADMIN_TOKEN, { name: '密钥校验鱼', balance: 50 })
    const plainCode = created.code
    assert(plainCode.startsWith('fbr_'), '主人 API 应返回明文 fbr_ 接入码')
    // C6 库里只存 sha256
    const row = db.prepare('SELECT code_hash FROM resident_code WHERE fish_id = ?').get(created.fish.id)
    assert(row && typeof row.code_hash === 'string', 'resident_code 应有该鱼的 code_hash')
    assert(/^[0-9a-f]{64}$/.test(row.code_hash), `code_hash 应是 64 位 hex sha256，实际=${row.code_hash}`)
    assert(row.code_hash !== plainCode, 'code_hash 不得等于明文码（不得存明文）')
    assert(!row.code_hash.startsWith('fbr_'), 'code_hash 不得以 fbr_ 开头（不得存明文）')
    assertEqual(row.code_hash, hashCode(plainCode), 'code_hash 应等于 sha256(明文码)')
    out(`    resident 无码 → ${noCode.status}（${noCodeBody.error}）✔`)
    out(`    resident 错码 → ${badCode.status}（RESIDENT_CODE）✔`)
    out(`    admin 无 token → ${noAdmin.status}（${noAdminBody.error}）✔`)
    out(`    admin 错 token → ${badAdmin.status}（UNAUTHORIZED）✔`)
    out(`    admin 正确 token 建鱼 → 200，返回明文码 ${maskCode(plainCode)}（脱敏）✔`)
    out(`    resident_code.code_hash = ${row.code_hash.slice(0, 16)}…（64 位 sha256，≠明文、=sha256(code)）✔ 库里无明文`)
    out('    ✅ [C] 通过')
    out('')
  } finally {
    await srv.close()
  }

  // ================= [D] 启动日志不泄漏明文接入码 =================
  out('[D] 启动日志不泄漏明文 fbr_ 码（真起子进程服务端，日志落盘后 grep）')
  const logDir = mkdtempSync(join(tmpdir(), 'fishbowl-hardening-log-'))
  const logFile = join(logDir, 'server.log')
  const dbFile = join(logDir, 'hardening.db')
  const port = await freePort()
  const fd = openSync(logFile, 'a')
  const childEnv = {
    ...process.env,
    NODE_ENV: 'production', // 打开 Fastify 日志
    HOST: '127.0.0.1',
    PORT: String(port),
    DB_PATH: dbFile,
    ADMIN_TOKEN: ADMIN_TOKEN,
    TICK_MS: '600000',
  }
  const entry = join(REPO_ROOT, 'packages/server/src/index.ts')
  const child = spawn(process.execPath, [entry], { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', fd, fd] })
  let childBase = `http://127.0.0.1:${port}`
  try {
    const up = await waitHealth(childBase)
    if (!up) fn('子进程服务端未在超时内就绪')
    const created = await createFishViaOwnerApi(childBase, ADMIN_TOKEN, { name: '日志泄漏检测鱼', balance: 10 })
    const plainCode = created.code
    assert(plainCode.startsWith('fbr_'), '子进程主人 API 应返回明文 fbr_ 接入码')
    await new Promise((r) => setTimeout(r, 400)) // 等日志 flush
    child.kill('SIGTERM')
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000) })
    closeSync(fd)

    const log = readFileSync(logFile, 'utf8')
    const logLines = log.split('\n').filter(Boolean)
    const codeHits = countOccurrences(log, plainCode)
    const fbrHits = (log.match(/fbr_[0-9a-fA-F]+/g) ?? []).length
    const ownerReq = logLines.filter((l) => l.includes('/api/owner/fish'))
    assert(logLines.length > 0, '启动日志应有内容（证明日志确实开着）')
    assert(/incoming request|server on|listening|fishbowl-own server/i.test(log), '启动日志应包含服务端/请求日志行')
    assert(ownerReq.length >= 1, '启动日志应记录到建鱼请求（证明请求确实过了日志，而码未泄漏）')
    if (codeHits !== 0) fn(`启动日志里出现了明文 fbr_ 码 ${codeHits} 次（泄漏！）`)
    if (fbrHits !== 0) fn(`启动日志里出现 fbr_ 片段 ${fbrHits} 次（泄漏！）`)
    out(`    子服务端 ${childBase}（NODE_ENV=production，日志 ${logLines.length} 行已落盘）`)
    out(`    建鱼返回明文码 ${maskCode(plainCode)}（脱敏）；grep 启动日志：`)
    out(`    日志含建鱼请求行   : ${ownerReq.length} 条（证明建鱼请求确实进了启动日志）✔`)
    out(`      样例（仅 method/url/主机，无请求体与头）: ${ownerReq[0].replace(/\s+/g, ' ').slice(0, 190)}`)
    out(`      明文码出现次数     : ${codeHits}（要求 0）✔`)
    out(`      fbr_ 片段出现次数  : ${fbrHits}（要求 0）✔`)
    out('    ✅ [D] 通过：日志不泄漏接入码')
    out('')
    try { rmSync(logDir, { recursive: true, force: true }) } catch { /* ignore */ }
  } catch (e) {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    try { closeSync(fd) } catch { /* ignore */ }
    try { rmSync(logDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw e
  }

  out('='.repeat(68))
  out('✅ 全部通过：不变量 1000/1000、并发无超支、鉴权 401 到位、日志与库均不泄漏明文码')
  out('='.repeat(68))

  if (outPath) {
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
    console.log(`\n（报告已写入 ${outPath}）`)
  }
  return allPass
}

main().catch((err) => {
  console.error('\n❌ hardening 失败：', err?.stack ?? err)
  if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  process.exitCode = 1
})
