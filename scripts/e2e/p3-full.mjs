// scripts/e2e/p3-full.mjs — P3 全链路端到端验收：礼物 / 好友 / 小手机 / 法庭 + 公开只读端点。
//
// 真跑（临时 DB + 随机端口 + 真 Fastify + 真 HTTP + 真经济 ledger），不 mock：
//   1) 送礼物：sender 扣款（reason=gift）、受「社交预算/日上限」约束（超限拒绝）；receiver 收到礼物事件（按 t31 设计，礼物为消费，不进现金）。
//   2) 加好友：makeFriend 双向可见、幂等去重。
//   3) 小手机：好友间发消息成功、非好友拒绝、超 60 字拒绝、日上限（20 条）拒绝。
//   4) 法庭：立案→举证→陪审投票→判决；有罪从镇财政赔付给原告（court 账本合计 0 守恒），无罪不赔。
//   5) 公开只读：GET /api/public/{court,relations,phone} 真实数据。
//   全程断账本不变量 SUM(ledger.delta)==fish.balance。
//
// 验收：node scripts/e2e/p3-full.mjs 退出码 0。真跑，不编。
// 用法：node scripts/e2e/p3-full.mjs [--out report.txt]
import { writeFileSync } from 'node:fs'
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

const START = 300
const GIFT_PRICE = 10
const PHONE_MAX = 60
const PHONE_DAILY = 20
const DAMAGES = 40

const failures = []
function fail(msg) { failures.push(msg); out(`      ❌ ${msg}`) }
function check(name, ok, detail = '') { out(`    ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(name + (detail ? '（' + detail + '）' : '')) }
function bal(db, id) { return db.prepare('SELECT balance FROM fish WHERE id = ?').get(id).balance }

async function run() {
  const adminToken = 'p3-admin-' + Math.floor(Math.random() * 1e9)
  const srv = await startTestServer({ adminToken })
  const base = srv.base
  const db = srv.db
  let okExit = true
  try {
    out('='.repeat(72))
    out(' 鱼缸小镇 · P3 全链路端到端验收（礼物 / 好友 / 小手机 / 法庭 / 公开只读）')
    out('='.repeat(72))
    out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
    out(`Node 版本  : ${process.version}`)
    out(`验证命令   : node scripts/e2e/p3-full.mjs`)
    out('')
    out(`临时 DB    : ${srv.dbPath}`)
    out(`服务端     : ${base}  （Fastify · 临时库 · 随机端口 ${srv.port} · 真种子 + P3 接线）`)
    out('')

    // ---- 造鱼 ----
    out('[0] 造鱼（owner API）')
    const mk = async (name) => { const c = await createFishViaOwnerApi(base, adminToken, { name, balance: START }); return { id: c.fish.id, code: c.code, api: residentApi(base, c.code) } }
    const A = await mk('阿甲') // 送礼物 sender / 法庭原告 A / 发消息方
    const B = await mk('阿乙') // 收礼人 / 被告 / 好友
    const C = await mk('阿丙') // 陪审员 / 非好友（对 A）
    const D = await mk('阿丁') // 陪审员
    for (const [n, f] of [['阿甲', A], ['阿乙', B], ['阿丙', C], ['阿丁', D]]) out(`    ${n}: id=${f.id} 余额=${bal(db, f.id)} 码=${maskCode(f.code)}`)
    out('')

    // ================= [1] 送礼物 =================
    out(`[1] 送礼物（gift ${GIFT_PRICE} 鱼币）：sender 扣款 + 社交预算/日上限；receiver 收礼物事件`)
    const social0 = await (await A.api.get('/social')).body
    check('GET /social 返回预算/已用/剩余', social0.ok && Number.isFinite(social0.budget) && social0.used === 0 && social0.remaining === social0.budget, `budget=${social0.budget} used=${social0.used} remaining=${social0.remaining}`)
    const beforeA = bal(db, A.id)
    const beforeB = bal(db, B.id)
    const g = await A.api.post('/social/gift', { to: B.id, item: '贝壳', price: GIFT_PRICE, words: '给你' })
    check('送礼成功', g.status === 200 && g.body.ok, g.status === 200 ? JSON.stringify(g.body.gift) : JSON.stringify(g.body))
    check('sender 被扣款 = -' + GIFT_PRICE, bal(db, A.id) === beforeA - GIFT_PRICE, `${beforeA}→${bal(db, A.id)}（${money(bal(db, A.id) - beforeA)}）`)
    const aGift = sumByReason(ledgerRows(db, A.id)).get('gift') ?? 0
    check('sender 账本 reason=gift 合计 = -' + GIFT_PRICE, aGift === -GIFT_PRICE, `gift=${money(aGift)}`)
    const social1 = await (await A.api.get('/social')).body
    check('社交已用 +' + GIFT_PRICE + '、剩余 -' + GIFT_PRICE, social1.used === GIFT_PRICE && social1.remaining === social1.budget - GIFT_PRICE, `used=${social1.used} remaining=${social1.remaining}`)
    // receiver 收到礼物事件（说明：t31 把礼物设计为消费，receiver 不进现金，只记事件）
    const recvEvent = db.prepare(`SELECT data_json FROM event WHERE fish_id = ? AND kind = 'gift' ORDER BY id DESC LIMIT 1`).get(B.id)
    let recvData = {}; try { recvData = JSON.parse(recvEvent?.data_json || '{}') } catch { /* ignore */ }
    check('receiver 收到礼物事件（from=sender, item, price）', !!recvEvent && recvData.from === A.id && recvData.item === '贝壳' && Number(recvData.price) === GIFT_PRICE, `event=${JSON.stringify(recvData)}`)
    out(`    说明：按 t31 设计「礼物=消费」——sender 扣 ${GIFT_PRICE} 鱼币、receiver 收礼物事件（不进现金，收礼人余额 ${beforeB}→${bal(db, B.id)} 不变）。`)
    // 超社交预算/日上限拒绝
    const overPrice = social1.remaining + 1
    const over = await A.api.post('/social/gift', { to: B.id, item: '大礼', price: overPrice })
    check('超社交预算被拒（DAY_CAP）', over.status === 409 && over.body?.code === 'DAY_CAP', `status=${over.status} code=${over.body?.code}`)
    check('被拒的礼物无副作用（sender 余额/礼物账本不变）', bal(db, A.id) === beforeA - GIFT_PRICE && (sumByReason(ledgerRows(db, A.id)).get('gift') ?? 0) === -GIFT_PRICE)
    out(`    社交预算 budget=${social1.budget}，已用 ${social1.used}，剩余 ${social1.remaining}；再送 ${overPrice} → 拒绝(${over.status} ${over.body?.code})`)
    out('')

    // ================= [2] 加好友 =================
    out('[2] 加好友：makeFriend 双向可见、幂等去重')
    const fr1 = await A.api.post('/relations/friend', { fish: B.id })
    check('阿甲 加 阿乙 为好友（created=true）', fr1.status === 200 && fr1.body.ok && fr1.body.friend?.created === true, fr1.status === 200 ? JSON.stringify(fr1.body.friend) : JSON.stringify(fr1.body))
    const fr2 = await A.api.post('/relations/friend', { fish: B.id })
    check('重复加好友幂等（created=false）', fr2.status === 200 && fr2.body.friend?.created === false, JSON.stringify(fr2.body.friend))
    const relA = await (await A.api.get('/relations')).body
    const relB = await (await B.api.get('/relations')).body
    check('好友双向可见（A 看到 B、B 看到 A）', relA.relations.some((r) => r.fishId === B.id) && relB.relations.some((r) => r.fishId === A.id), `A好友=${relA.relations.map((r) => r.name).join('/')} B好友=${relB.relations.map((r) => r.name).join('/')}`)
    out(`    阿甲 friends=${relA.relations.map((r) => r.name).join('、')}；阿乙 friends=${relB.relations.map((r) => r.name).join('、')}`)
    out('')

    // ================= [3] 小手机 =================
    out('[3] 小手机：好友互发成功 / 非好友拒绝 / 超 60 字拒绝 / 日上限(20)拒绝')
    const nf = await C.api.post('/phone', { to: A.id, text: '在吗' })
    check('非好友发消息被拒（BAD_REQUEST）', nf.status === 400 && nf.body?.code === 'BAD_REQUEST', `status=${nf.status} code=${nf.body?.code}`)
    const m1 = await A.api.post('/phone', { to: B.id, text: '今晚码头钓鱼吗？' })
    check('好友间发消息成功', m1.status === 200 && m1.body.ok && m1.body.message?.fromFishId === A.id && m1.body.message?.toFishId === B.id, JSON.stringify(m1.body.message))
    const inboxB = await (await B.api.get('/phone')).body
    check('收件人 GET /phone 能看到该消息', inboxB.messages?.some((m) => m.text === '今晚码头钓鱼吗？' && m.fromFishId === A.id), `messages=${inboxB.messages?.length}`)
    const long = 'x'.repeat(PHONE_MAX + 1)
    const tooLong = await A.api.post('/phone', { to: B.id, text: long })
    check('超 ' + PHONE_MAX + ' 字被拒（BAD_REQUEST）', tooLong.status === 400 && tooLong.body?.code === 'BAD_REQUEST', `status=${tooLong.status} code=${tooLong.body?.code} chars=${PHONE_MAX + 1}`)
    // 日上限：A 今日已发 1 条，补到 20 条，再发第 21 条应 DAY_CAP
    let sent = 1
    let sendErr = null
    for (; sent < PHONE_DAILY; sent++) {
      const r = await A.api.post('/phone', { to: B.id, text: '第' + (sent + 1) + '条' })
      if (r.status !== 200) { sendErr = r; break }
    }
    check('可发满 ' + PHONE_DAILY + ' 条/天', sent === PHONE_DAILY && !sendErr, `sent=${sent}${sendErr ? ' err=' + JSON.stringify(sendErr.body) : ''}`)
    const over21 = await A.api.post('/phone', { to: B.id, text: '第21条' })
    check('第 ' + (PHONE_DAILY + 1) + ' 条超日上限被拒（DAY_CAP）', over21.status === 409 && over21.body?.code === 'DAY_CAP', `status=${over21.status} code=${over21.body?.code}`)
    out(`    好友消息成功；非好友 400；超长 400；发满 ${PHONE_DAILY} 条后第 ${PHONE_DAILY + 1} 条 → ${over21.status} ${over21.body?.code}`)
    out('')

    // ================= [4] 法庭 =================
    out('[4] 法庭：立案→举证→陪审投票→判决（有罪从镇财政赔付，court 账本守恒；无罪不赔）')
    // 案一：有罪赔付
    const beforePlA = bal(db, A.id)
    const filed = await A.api.post('/court/file', { defendant: B.id, kind: 'civil', desc: '阿乙借贝壳不还', evidence: ['借条照片'] })
    check('立案成功（state=filed）', filed.status === 200 && filed.body.ok && filed.body.case?.state === 'filed', filed.status === 200 ? `case=${filed.body.case.id} state=${filed.body.case.state}` : JSON.stringify(filed.body))
    const caseId = filed.body.case.id
    const ev = await A.api.post('/court/evidence', { case_id: caseId, text: '补充：转账截图' })
    check('举证成功（filed→hearing）', ev.status === 200 && ev.body.case?.state === 'hearing', `state=${ev.body?.case?.state}`)
    const v1 = await C.api.post('/court/vote', { case_id: caseId, guilty: true })
    check('陪审投票1（有罪，hearing→jury）', v1.status === 200 && v1.body.case?.state === 'jury' && v1.body.case?.votes?.length === 1, `state=${v1.body?.case?.state} votes=${v1.body?.case?.votes?.length}`)
    const v2 = await D.api.post('/court/vote', { case_id: caseId, guilty: true })
    check('陪审投票2（有罪，共2票）', v2.status === 200 && v2.body.case?.votes?.length === 2, `votes=${v2.body?.case?.votes?.length}`)
    const vd = await A.api.post('/court/verdict', { case_id: caseId, damages: DAMAGES })
    const vres = vd.body?.result
    check('判决有罪并赔付（guilty, paid=true）', vd.status === 200 && vres?.case?.verdict === 'guilty' && vres?.paid === true && vres?.amount === DAMAGES, `verdict=${vres?.case?.verdict} paid=${vres?.paid} amount=${vres?.amount}`)
    const afterPlA = bal(db, A.id)
    check('原告获得赔付 = +' + DAMAGES, afterPlA - beforePlA === DAMAGES, `${beforePlA}→${afterPlA}（${money(afterPlA - beforePlA)}）`)
    const courtSum = db.prepare(`SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE reason='court'`).get().s
    const treasuryId = (db.prepare(`SELECT v FROM meta WHERE k='court_treasury'`).get() || {}).v
    const treasBal = treasuryId ? bal(db, treasuryId) : null
    check('court 账本合计 = 0（财政-赔付 与 原告+赔付 守恒）', Number(courtSum) === 0, `courtSum=${courtSum}`)
    const plCourt = sumByReason(ledgerRows(db, A.id)).get('court') ?? 0
    check('原告账本 reason=court = +' + DAMAGES, plCourt === DAMAGES, `court=${money(plCourt)}`)
    out(`    案 ${caseId}：filed→hearing→jury(2票有罪)→verdict(guilty)；原告 阿甲 ${beforePlA}→${afterPlA}（+${DAMAGES}），镇财政余额 ${treasBal}，court 合计=${courtSum}`)

    // 案二：无罪不赔
    const filed2 = await A.api.post('/court/file', { defendant: D.id, kind: 'civil', desc: '一场误会' })
    const case2 = filed2.body.case.id
    await A.api.post('/court/evidence', { case_id: case2, text: '情况说明' })
    await C.api.post('/court/vote', { case_id: case2, guilty: false })
    await D.api.post('/court/vote', { case_id: case2, guilty: false })
    const beforePl2 = bal(db, A.id)
    const vd2 = await A.api.post('/court/verdict', { case_id: case2, damages: DAMAGES })
    const vres2 = vd2.body?.result
    check('判决无罪不赔（not_guilty, paid=false）', vd2.status === 200 && vres2?.case?.verdict === 'not_guilty' && vres2?.paid === false, `verdict=${vres2?.case?.verdict} paid=${vres2?.paid}`)
    check('无罪不改变原告余额', bal(db, A.id) === beforePl2, `${beforePl2}→${bal(db, A.id)}`)
    out(`    案 ${case2}：2 票无罪 → verdict=not_guilty，paid=false（不赔）`)
    out('')

    // ================= [5] 公开只读端点 =================
    out('[5] 公开只读：GET /api/public/{court,relations,phone}')
    const pubCourt = await (await fetch(base + '/api/public/court')).json()
    const pc = pubCourt.cases || []
    check('GET /api/public/court 返回真实案件列表', pubCourt.ok === true && pc.length >= 2 && pc.every((c) => c.id && 'state' in c && 'plaintiff' in c && 'verdict' in c), `cases=${pc.length}`)
    const pubRel = await (await fetch(base + '/api/public/relations')).json()
    const rels = pubRel.relations || []
    const pair = rels.find((r) => (r.a?.id === A.id && r.b?.id === B.id) || (r.a?.id === B.id && r.b?.id === A.id))
    check('GET /api/public/relations 返回真实好友对（含 阿甲-阿乙）', pubRel.ok === true && !!pair, pair ? `${pair.a.name}-${pair.b.name}` : `relations=${rels.length}`)
    const pubPhone = await (await fetch(base + '/api/public/phone')).json()
    check('GET /api/public/phone 隐私占位（public=false）', pubPhone.ok === true && pubPhone.public === false && Array.isArray(pubPhone.messages), `public=${pubPhone.public} messages=${pubPhone.messages?.length} note=${pubPhone.note}`)
    out(`    court: cases=${pc.length}（含 guilty/not_guilty）；relations: ${rels.length} 对，含 ${pair?.a?.name}-${pair?.b?.name}`)
    out(`    phone: public=${pubPhone.public}，messages=${pubPhone.messages?.length}，「${pubPhone.note}」`)
    out('')

    // ================= 账本不变量 =================
    const allFish = [A, B, C, D]
    if (treasuryId) allFish.push({ id: treasuryId })
    let ledgerAllOk = true
    for (const f of allFish) { const vb = verifyBalance(db, f.id); if (!vb.ok) ledgerAllOk = false }
    check('全部鱼（含镇财政）账本不变量 SUM(ledger.delta)==balance', ledgerAllOk)
    out('')

    rule('=')
    const pass = failures.length === 0
    if (pass) out('✅ P3 全链路通过：礼物(sender 扣款+预算/日上限) / 好友(双向·去重) / 小手机(好友·长度·日上限) / 法庭(有罪赔付守恒·无罪不赔) / 公开只读端点 均真跑通过。')
    else { out(`❌ P3 全链路发现 ${failures.length} 项问题：`); for (const f of failures.slice(0, 40)) out('   - ' + f) }
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
  console.error('\n❌ p3-full 运行失败：', err?.stack ?? err)
  if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  process.exit(1)
})
