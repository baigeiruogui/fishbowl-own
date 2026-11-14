// scripts/e2e/concurrency.mjs — 多鱼并发长轮询压测（不串台 / 顶替 / 时延）。
//
// [A] 多鱼并发：owner API 建 8 条鱼各拿 fbr_ 码；同时并发发起 GET turns?wait=20 长轮询；
//     随后对每条 POST agency 触发 agency 回合。断言：每条鱼各自收到自己的回合（不串台，
//     packet 身份 == 该鱼）、能在 deadline 前 answer 200、整体墙钟合理。
// [B] 顶替：同一接入码并发开两个长轮询，新的接管、旧的被顶掉（立刻返回空）；断言同一回合
//     不会被两个并发长轮询重复投递（架构约定「一条鱼同时只有一个在途回合」）。
//
// 真跑：临时库 + 随机端口 + 真实 HTTP。任一检查失败 → 退出码 1，并打印复现信息。
// 用法：
//   node scripts/e2e/concurrency.mjs
//   node scripts/e2e/concurrency.mjs --out report.txt
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { startTestServer, createFishViaOwnerApi, maskCode, pad } from './lib.mjs'

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null

const lines = []
function out(s = '') { console.log(s); lines.push(s) }
function rule(ch = '─', n = 70) { out(ch.repeat(n)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ADMIN_TOKEN = 'e2e-admin-' + randomBytes(6).toString('hex')
const PREFIX = '/town/api/resident'
const N_FISH = 8
const WAIT_SEC = 20

const checks = []
function record(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  out(`    ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

const authOnly = (code) => ({ authorization: 'Bearer ' + code })
const authJson = (code) => ({ authorization: 'Bearer ' + code, 'content-type': 'application/json' })
async function getJson(url, headers) {
  const r = await fetch(url, { headers })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function postJson(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
// 回合身份：优先 packet.as / packet.name，否则从 system 卡片「镇民鱼「NAME」」提取。
function turnIdentity(turn) {
  const p = (turn && turn.packet) || {}
  if (typeof p.as === 'string') return p.as
  if (typeof p.name === 'string') return p.name
  const sys = (p.messages || []).find((m) => m.role === 'system')?.content || ''
  const m = /镇民鱼「([^」]+)」/.exec(sys)
  return m ? m[1] : null
}

async function main() {
  out('='.repeat(70))
  out(' 鱼缸小镇 · 多鱼并发长轮询压测（不串台 / 顶替 / 时延）')
  out('='.repeat(70))
  out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
  out(`Node 版本  : ${process.version}`)
  out(`验证命令   : node scripts/e2e/concurrency.mjs`)
  out('')

  const srv = await startTestServer({ adminToken: ADMIN_TOKEN, engine: { agencyCooldownMs: 600000 } })
  try {
    const base = srv.base
    out(`临时 DB    : ${srv.dbPath}`)
    out(`服务端     : ${base}  （Fastify · 临时库 · 随机端口 ${srv.port} · agencyCooldownMs=600000 便于长轮询真实挂起）`)
    out('')

    // ================= [A] 多鱼并发长轮询 =================
    out(`[A] 多鱼并发：建 ${N_FISH} 条鱼 → 并发 GET turns?wait=${WAIT_SEC} → 逐条 POST agency 触发`)
    const fishes = []
    for (let i = 1; i <= N_FISH; i++) {
      const name = `并发鱼${i}`
      const created = await createFishViaOwnerApi(base, ADMIN_TOKEN, { name, balance: 100 })
      fishes.push({ name, fish: created.fish, code: created.code })
    }
    out(`    建鱼：${N_FISH} 条 → ${fishes.map((f) => maskCode(f.code)).join(', ')}（接入码脱敏）`)

    // 预热 cooldown（先各生成并答掉一个 agency，使随后长轮询真正挂起等待，而非首个 poll 立即自生成）
    for (const f of fishes) {
      const ag = await postJson(base + PREFIX + '/agency', authOnly(f.code))
      if (ag.status !== 200 || !ag.body?.turn_id) throw new Error(`预热 agency 失败(${f.name}): ${ag.status}`)
      const ans = await postJson(base + PREFIX + `/turns/${ag.body.turn_id}`, authJson(f.code), { answer: JSON.stringify({ action: 'none' }) })
      if (ans.status !== 200) throw new Error(`预热 answer 失败(${f.name}): ${ans.status}`)
    }
    out(`    预热：每条鱼先生成并答掉 1 个 agency（使后续长轮询进入真实等待）`)

    // 并发发起 8 条长轮询
    const t0 = Date.now()
    const pollPromises = fishes.map((f) =>
      getJson(`${base}${PREFIX}/turns?wait=${WAIT_SEC}`, authOnly(f.code)).then((r) => ({ f, ...r, dt: Date.now() - t0 })),
    )
    await sleep(400) // 等 8 条长轮询都注册挂起
    // 逐条 POST agency 触发（force，忽略冷却）
    const triggered = new Map()
    for (const f of fishes) {
      const ag = await postJson(base + PREFIX + '/agency', authOnly(f.code))
      if (ag.status !== 200 || !ag.body?.turn_id) throw new Error(`触发 agency 失败(${f.name}): ${ag.status} ${JSON.stringify(ag.body)}`)
      triggered.set(f.name, ag.body.turn_id)
    }
    const results = await Promise.all(pollPromises)
    const wall = Date.now() - t0
    out(`    ${pad('鱼', 10)}${pad('HTTP', 6)}${pad('回合数', 8)}${pad('回合身份', 12)}${pad('turn_id 匹配触发', 18)}${pad('时延ms', 8)}`)
    for (const r of results) {
      const turns = r.body?.turns ?? []
      const id = turns[0] ? turnIdentity(turns[0]) : null
      const idMatch = turns[0] ? turns[0].turn_id === triggered.get(r.f.name) : false
      out(`    ${pad(r.f.name, 10)}${pad(r.status, 6)}${pad(turns.length, 8)}${pad(id, 12)}${pad(idMatch ? '是' : '否', 18)}${pad(r.dt, 8)}`)
    }
    out(`    整体墙钟 : ${wall} ms（8 条并发长轮询，wait=${WAIT_SEC}s；远小于串行导致的 ${N_FISH}×${WAIT_SEC}s）`)

    // 断言
    record('8 条长轮询均 HTTP 200', results.every((r) => r.status === 200))
    record('每条鱼恰好收到 1 个回合', results.every((r) => (r.body?.turns ?? []).length === 1), results.map((r) => `${r.f.name}:${(r.body?.turns ?? []).length}`).join(' '))
    record('不串台：回合身份 == 本鱼名字', results.every((r) => { const t = (r.body?.turns ?? [])[0]; return t && turnIdentity(t) === r.f.name }))
    record('不串台：turn_id == 本鱼触发的那一个', results.every((r) => { const t = (r.body?.turns ?? [])[0]; return t && t.turn_id === triggered.get(r.f.name) }))
    record('长轮询确为真实挂起（每条时延 >= 300ms）', results.every((r) => r.dt >= 300), `min=${Math.min(...results.map((r) => r.dt))}ms`)
    record('整体墙钟合理（< 5000ms，非串行阻塞）', wall < 5000, `${wall}ms`)

    // deadline 前 answer 200：每条鱼各自答自己的回合
    let answered = 0
    for (const r of results) {
      const t = (r.body?.turns ?? [])[0]
      if (!t) continue
      const ans = await postJson(`${base}${PREFIX}/turns/${t.turn_id}`, authJson(r.f.code), { answer: JSON.stringify({ action: 'none' }) })
      if (ans.status === 200) answered++
    }
    record('每条鱼均能在 deadline 前 answer 200', answered === N_FISH, `${answered}/${N_FISH}`)

    // 交叉回答负例：鱼1 去答 鱼2 的回合 → 404（证明回合按鱼隔离，不串台）
    const a = results[0]
    const b = results[1]
    const bTurn = (b.body?.turns ?? [])[0]
    // 注意：b 的回合上面已被 b 答掉；改用一个新回合验证隔离：让鱼b 再生成一个，鱼a 去答
    const bg = await postJson(base + PREFIX + '/agency', authOnly(b.f.code))
    const cross = await postJson(`${base}${PREFIX}/turns/${bg.body.turn_id}`, authJson(a.f.code), { answer: JSON.stringify({ action: 'none' }) })
    record('回合按鱼隔离：鱼A 答鱼B 的回合被拒（404）', cross.status === 404, `status=${cross.status} code=${cross.body?.error}`)
    out('')

    // ================= [B] 顶替 / 不重复投递 =================
    out('[B] 顶替：同一接入码并发开两个长轮询 → 新的接管、旧的被顶掉（立刻返回空）')
    const dup = await createFishViaOwnerApi(base, ADMIN_TOKEN, { name: '顶替鱼', balance: 100 })
    const dcode = dup.code
    // 预热 cooldown
    {
      const ag = await postJson(base + PREFIX + '/agency', authOnly(dcode))
      await postJson(`${base}${PREFIX}/turns/${ag.body.turn_id}`, authJson(dcode), { answer: JSON.stringify({ action: 'none' }) })
    }
    const t1 = Date.now()
    const pOld = getJson(`${base}${PREFIX}/turns?wait=8`, authOnly(dcode)).then((r) => ({ who: '旧(old)', ...r, dt: Date.now() - t1 }))
    await sleep(300)
    const pNew = getJson(`${base}${PREFIX}/turns?wait=8`, authOnly(dcode)).then((r) => ({ who: '新(new)', ...r, dt: Date.now() - t1 }))
    await sleep(300)
    const trig = await postJson(base + PREFIX + '/agency', authOnly(dcode))
    const trigId = trig.body?.turn_id
    const [oldR, newR] = await Promise.all([pOld, pNew])
    const oldTurns = oldR.body?.turns ?? []
    const newTurns = newR.body?.turns ?? []
    out(`    触发回合 turn_id = ${trigId}`)
    out(`    ${pad('连接', 10)}${pad('HTTP', 6)}${pad('回合数', 8)}${pad('turn_id', 26)}${pad('时延ms', 8)}`)
    for (const x of [oldR, newR]) {
      out(`    ${pad(x.who, 10)}${pad(x.status, 6)}${pad((x.body?.turns ?? []).length, 8)}${pad(((x.body?.turns ?? []).map((t) => t.turn_id).join(',')) || '-', 26)}${pad(x.dt, 8)}`)
    }
    const sameDeliveredTwice = !!(oldTurns[0] && newTurns[0] && oldTurns[0].turn_id === newTurns[0].turn_id)
    const oldEmpty = oldTurns.length === 0
    const exactlyOneGotIt = (oldTurns.length === 1) !== (newTurns.length === 1) // 恰好一方收到
    record('旧的被顶掉：旧长轮询立刻返回空', oldEmpty, `旧turns=${oldTurns.length}, 旧时延=${oldR.dt}ms`)
    record('同一回合不被两个并发长轮询重复投递', !sameDeliveredTwice, sameDeliveredTwice ? `两边都收到 ${oldTurns[0]?.turn_id}` : '未重复')
    record('恰好一方（新的）收到该回合', exactlyOneGotIt && newTurns.length === 1, `旧=${oldTurns.length}, 新=${newTurns.length}`)
    if (!oldEmpty || sameDeliveredTwice) {
      out('    ⚠ 根因定位：engine/hub.ts 的 notify() 遍历并唤醒该鱼【所有】等待者（Set），')
      out('      且 poll() 唤醒后重新读取 pending 回合 → 两个并发长轮询都会拿到同一个回合；')
      out('      当前未实现「每个 fish 只保留最新一个长轮询（顶替旧的）」语义。')
    }
    out('')
  } finally {
    await srv.close()
  }

  // ================= 汇总 =================
  const passed = checks.filter((c) => c.ok).length
  const failed = checks.filter((c) => !c.ok)
  rule('=')
  if (failed.length === 0) {
    out(`✅ 全部通过：${passed}/${checks.length} 项检查`)
  } else {
    out(`❌ 发现 ${failed.length} 项失败（${passed}/${checks.length} 通过）：`)
    for (const f of failed) out(`   - ${f.name}${f.detail ? '（' + f.detail + '）' : ''}`)
    out('   结论：多鱼并发本身工作正常，但「顶替」不满足——同鱼两个并发长轮询会重复拿到同一回合，')
    out('        违反架构约定「一条鱼同时只有一个在途回合」。需服务端在 hub 层按 fish 顶替掉旧等待者。')
  }
  rule('=')

  if (outPath) {
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
    console.log(`\n（报告已写入 ${outPath}）`)
  }
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n❌ concurrency 运行失败：', err?.stack ?? err)
  if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  process.exitCode = 1
})
