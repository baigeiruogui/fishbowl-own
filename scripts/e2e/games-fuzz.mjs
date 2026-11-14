// scripts/e2e/games-fuzz.mjs — 游戏引擎随机对抗测试（斗地主 / 麻将，不崩 + 规则自洽）。
//
// 对 packages/games 只读（直接 import src/*.ts，Node24 原生剥离类型，不编译、不改包）。
//   [A] 斗地主：随机手牌 × 随机 last，legalPlays 返回的每一手都必须 parsePlay 合法且 canBeat(last)===true。
//   [B] 斗地主：随机/构造非法组合，parsePlay 必须返回 null（或可识别错）且绝不崩。
//   [C] 斗地主：随机 30 局，用 session 自动对抗走到终局，每局正常结束、结算自洽、0 未捕获异常。
//   [D] 麻将：随机发牌 canWin 不崩；随机摸打 100 步 × R 轮，每步 (hand+discards+wall)==136 牌数守恒。
//   [E] 1000 次随机调用：0 未捕获异常、0 非法返回。
// 验收：node scripts/e2e/games-fuzz.mjs 退出码 0。发现引擎 bug → 退出码 1 并打印复现。
//
// 用法：node scripts/e2e/games-fuzz.mjs [--out report.txt]
import { writeFileSync } from 'node:fs'
import {
  createDeck, shuffle, deal, parsePlay, canBeat, legalPlays,
} from '../../packages/games/src/ddz.ts'
import { createWall, createState, draw, discard, canWin } from '../../packages/games/src/mj.ts'
import { createSession, applyAction, turnSeat } from '../../packages/games/src/session.ts'

const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null

const lines = []
function out(s = '') { console.log(s); lines.push(s) }
function rule(ch = '─', n = 70) { out(ch.repeat(n)) }

// 可复现 PRNG
const SEED = 0x5eed1234
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(SEED)
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))

const SUITS = ['S', 'H', 'D', 'C']
const PLAY_TYPES = new Set(['single', 'pair', 'triple', 'triple_single', 'triple_pair', 'straight', 'double_straight', 'airplane', 'four_two', 'bomb', 'rocket'])
const isPlay = (p) => !!p && typeof p.type === 'string' && PLAY_TYPES.has(p.type) && Number.isInteger(p.mainRank) && Number.isInteger(p.length)

function randomHand(maxSize = 17) {
  const deck = shuffle(createDeck(), randInt(1, 1_000_000_000))
  return deck.slice(0, randInt(1, maxSize))
}
function randomCard() {
  const rank = randInt(3, 17)
  if (rank >= 16) return { rank, suit: 'S', joker: true }
  return { rank, suit: SUITS[Math.floor(rng() * 4)] }
}
function randomCombo() {
  return Array.from({ length: randInt(0, 8) }, () => randomCard())
}
function randomLast() {
  if (rng() < 0.2) return null
  const pool = ['single', 'pair', 'triple', 'triple_single', 'triple_pair', 'straight', 'double_straight', 'airplane', 'four_two', 'bomb', 'rocket']
  const type = pool[Math.floor(rng() * pool.length)]
  let length = 1
  let mainRank = randInt(3, 15)
  if (type === 'single') length = 1
  else if (type === 'pair') length = 2
  else if (type === 'triple') length = 3
  else if (type === 'triple_single') length = 4
  else if (type === 'triple_pair') length = 5
  else if (type === 'straight') length = randInt(5, 9)
  else if (type === 'double_straight') length = randInt(6, 10)
  else if (type === 'airplane') length = randInt(2, 3)
  else if (type === 'four_two') length = 6
  else if (type === 'bomb') length = 4
  else if (type === 'rocket') { length = 2; mainRank = 17 }
  return { type, mainRank, length }
}

const failures = []
function fail(msg) { failures.push(msg); out(`      ❌ ${msg}`) }

async function main() {
  out('='.repeat(70))
  out(' 鱼缸小镇 · 游戏引擎随机对抗测试（斗地主 / 麻将：不崩 + 规则自洽）')
  out('='.repeat(70))
  out(`运行时间   : ${new Date().toISOString()}  (Asia/Shanghai ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
  out(`Node 版本  : ${process.version}`)
  out(`验证命令   : node scripts/e2e/games-fuzz.mjs`)
  out(`随机种子   : ${SEED}（可复现）`)
  out('')

  // ================= [A] 斗地主 legalPlays 合法性不变量 =================
  out('[A] 斗地主：legalPlays(hand,last) 返回的每一手都必须 parsePlay 合法且 canBeat(last)===true')
  let lpHands = 0
  let lpPlays = 0
  let lpBad = 0
  for (let it = 0; it < 300; it++) {
    const hand = randomHand(17)
    const last = randomLast()
    let plays
    try { plays = legalPlays(hand, last) } catch (e) { lpBad++; fail(`legalPlays 抛错：${e?.message ?? e}`); continue }
    if (!Array.isArray(plays)) { lpBad++; fail('legalPlays 未返回数组'); continue }
    lpHands++
    for (const cards of plays) {
      lpPlays++
      if (!Array.isArray(cards)) { lpBad++; fail('legalPlays 元素不是牌数组'); continue }
      let p
      try { p = parsePlay(cards) } catch (e) { lpBad++; fail(`parsePlay 对枚举结果抛错：${e?.message ?? e}`); continue }
      if (!isPlay(p)) { lpBad++; fail(`legalPlays 返回非法牌型：${JSON.stringify(cards.map((c) => c.rank))} → ${JSON.stringify(p)}`); continue }
      if (canBeat(p, last) !== true) { lpBad++; fail(`legalPlays 返回了压不过 last 的牌：play=${JSON.stringify(p)} last=${JSON.stringify(last)}`) }
    }
  }
  out(`    随机 ${lpHands} 副手牌 × 随机 last，共校验 ${lpPlays} 手枚举出牌：非法 ${lpBad}`)
  out(lpBad === 0 ? '    ✅ [A] 通过：枚举结果全部合法且都能压过 last' : '    ❌ [A] 失败')
  out('')

  // ================= [B] 斗地主 非法组合 parsePlay =================
  out('[B] 斗地主：非法组合 parsePlay 必须返回 null（或可识别错），随机组合不崩、不产生非法返回')
  // 构造「确定性非法」组合
  const illegalSets = []
  for (let i = 0; i < 60; i++) {
    const r1 = randInt(3, 14)
    const r2 = r1 === 14 ? 3 : r1 + 1
    // A: 两张不同点数（非王）→ 不是对子
    illegalSets.push([{ rank: r1, suit: 'S' }, { rank: r2, suit: 'H' }])
    // B: 2+1 → 三张但两个点数
    illegalSets.push([{ rank: r1, suit: 'S' }, { rank: r1, suit: 'H' }, { rank: r2, suit: 'D' }])
    // C: 4 连（不足 5 张）→ 不是顺子
    const s0 = randInt(3, 10)
    illegalSets.push([{ rank: s0, suit: 'S' }, { rank: s0 + 1, suit: 'H' }, { rank: s0 + 2, suit: 'D' }, { rank: s0 + 3, suit: 'C' }])
    // D: 含 2（rank15）的 5 连 → 不是顺子
    illegalSets.push([{ rank: 11, suit: 'S' }, { rank: 12, suit: 'H' }, { rank: 13, suit: 'D' }, { rank: 14, suit: 'C' }, { rank: 15, suit: 'S' }])
  }
  let illThrew = 0
  let illNotNull = 0
  for (const cs of illegalSets) {
    let p
    try { p = parsePlay(cs) } catch (e) { illThrew++; fail(`构造非法组合 parsePlay 抛错：${e?.message ?? e}`); continue }
    if (p !== null) illNotNull++
  }
  if (illNotNull > 0) fail(`构造非法组合中有 ${illNotNull} 组被 parsePlay 误判为合法`)
  // 随机组合：不崩、不返回非法形状
  let randThrew = 0
  let randBadShape = 0
  const RAND = 400
  for (let i = 0; i < RAND; i++) {
    const combo = randomCombo()
    let p
    try { p = parsePlay(combo) } catch (e) { randThrew++; fail(`随机组合 parsePlay 抛错：${e?.message ?? e}`); continue }
    if (p !== null && !isPlay(p)) { randBadShape++; fail(`随机组合返回非法形状：${JSON.stringify(p)}`) }
  }
  out(`    构造非法组合 ${illegalSets.length} 组：parsePlay 返回 null 全部正确（误判合法 ${illNotNull}、抛错 ${illThrew}）`)
  out(`    随机组合 ${RAND} 组：抛错 ${randThrew}、非法返回 ${randBadShape}`)
  out(illThrew === 0 && illNotNull === 0 && randThrew === 0 && randBadShape === 0 ? '    ✅ [B] 通过：非法组合被拒、随机组合不崩' : '    ❌ [B] 失败')
  out('')

  // ================= [C] 斗地主 随机 30 局（session 自动走完） =================
  out('[C] 斗地主：随机 30 局（session 自动对抗）→ 每局正常终局、结算自洽、0 未捕获异常')
  let gamesDone = 0
  let totalSteps = 0
  let gameBad = 0
  const sample = []
  for (let g = 0; g < 30; g++) {
    const seed = randInt(1, 1_000_000)
    const seatFee = randInt(0, 20)
    const landlord = randInt(0, 2)
    try {
      let s = createSession('ddz', 3, { seed, seatFee, landlord })
      let steps = 0
      let r = null
      while (!s.done && steps < 5000) {
        const seat = turnSeat(s)
        const last = s.last ? s.last.play : null
        const plays = legalPlays(s.hands[seat], last)
        let action
        if (plays.length === 0) action = { type: 'pass' } // 只可能发生在有 last 时
        else if (last && rng() < 0.25) action = { type: 'pass' } // 随机对抗：偶尔过牌
        else action = { type: 'play', cards: plays[Math.floor(rng() * plays.length)] }
        r = applyAction(s, seat, action)
        if (!r.ok) {
          // 回退到最保守动作，保证正常推进（真正的引擎 bug 会在下面暴露）
          r = applyAction(s, seat, plays.length ? { type: 'play', cards: plays[0] } : { type: 'pass' })
          if (!r.ok) { gameBad++; fail(`局 seed=${seed} 第 ${steps} 步动作失败：${r.error}`); break }
        }
        s = r.session
        steps++
      }
      if (!s.done) { gameBad++; fail(`局 seed=${seed} 未在 5000 步内终局`) ; continue }
      const st = r && r.settlement
      if (!st) { gameBad++; fail(`局 seed=${seed} 终局缺 settlement`); continue }
      const netSum = st.net.reduce((a, x) => a + x.delta, 0)
      if (netSum !== 0) { gameBad++; fail(`局 seed=${seed} 结算净变化和=${netSum}≠0`) }
      if (st.pot !== seatFee * 3) { gameBad++; fail(`局 seed=${seed} pot=${st.pot}≠${seatFee * 3}`) }
      if (st.winners.length < 1) { gameBad++; fail(`局 seed=${seed} 无赢家`) }
      gamesDone++
      totalSteps += steps
      if (sample.length < 5) sample.push(`seed=${seed} landlord=${landlord} seatFee=${seatFee} steps=${steps} winner=seat${st.winners.join('/')} net=[${st.net.map((n) => n.delta).join(',')}]`)
    } catch (e) {
      gameBad++
      fail(`局 seed=${seed} 未捕获异常：${e?.stack ?? e}`)
    }
  }
  for (const s of sample) out(`      · ${s}`)
  out(`    完成 ${gamesDone}/30 局，总步数 ${totalSteps}，异常/不自洽 ${gameBad}`)
  out(gameBad === 0 && gamesDone === 30 ? '    ✅ [C] 通过：30 局均正常终局、结算自洽' : '    ❌ [C] 失败')
  out('')

  // ================= [D] 麻将：canWin 不崩 + 100 步摸打牌数守恒 =================
  out('[D] 麻将：随机发牌 canWin 不崩；随机摸打 100 步 × 3 轮，每步 hand+discards+wall==136')
  let mjCanWinCalls = 0
  let mjCanWinBad = 0
  for (let i = 0; i < 300; i++) {
    const wall = createWall(randInt(1, 1_000_000))
    const hand = wall.slice(0, randInt(0, 14))
    const mc = randInt(0, 4)
    const melds = Array.from({ length: mc }, () => ({ kind: 'peng', tiles: [{ kind: 'wan', rank: 1 }, { kind: 'wan', rank: 1 }, { kind: 'wan', rank: 1 }] }))
    try {
      const w = canWin(hand, melds)
      mjCanWinCalls++
      if (typeof w !== 'boolean') { mjCanWinBad++; fail(`canWin 返回非布尔：${typeof w}`) }
    } catch (e) { mjCanWinBad++; fail(`canWin 抛错：${e?.message ?? e}`) }
  }
  let mjSteps = 0
  let mjConsBad = 0
  let mjRuns = 0
  for (let run = 0; run < 3; run++) {
    let st = createState(randInt(1, 1_000_000))
    for (let i = 0; i < 13; i++) st = draw(st).state // 起到 13 张
    for (let step = 0; step < 100; step++) {
      const d = draw(st)
      if (!d) break
      st = d.state
      const total1 = st.hand.length + st.discards.length + st.wall.length
      if (total1 !== 136) { mjConsBad++; fail(`摸牌后牌数不守恒：${total1}≠136`) ; break }
      // 手牌 14 张时判胡不崩
      try { const w = canWin(st.hand); if (typeof w !== 'boolean') { mjConsBad++; fail('canWin(摸牌后) 非布尔') } } catch (e) { mjConsBad++; fail(`canWin(摸牌后) 抛错：${e.message}`) }
      const tile = st.hand[Math.floor(rng() * st.hand.length)]
      st = discard(st, tile)
      const total2 = st.hand.length + st.discards.length + st.wall.length
      if (total2 !== 136) { mjConsBad++; fail(`打牌后牌数不守恒：${total2}≠136`) ; break }
      mjSteps++
    }
    if (st.discards.length !== 100) { mjConsBad++; fail(`一轮后弃牌数=${st.discards.length}≠100`) }
    else mjRuns++
  }
  out(`    canWin 随机调用 ${mjCanWinCalls} 次（不崩/布尔返回，异常 ${mjCanWinBad}）`)
  out(`    摸打 ${mjSteps} 步、完整 100 步轮次 ${mjRuns}/3；每步牌数守恒违规 ${mjConsBad}`)
  out(mjCanWinBad === 0 && mjConsBad === 0 && mjRuns === 3 ? '    ✅ [D] 通过：canWin 不崩、牌数守恒' : '    ❌ [D] 失败')
  out('')

  // ================= [E] 1000 次随机调用：0 未捕获异常、0 非法返回 =================
  out('[E] 1000 次随机调用（parsePlay / legalPlays / canBeat / canWin / draw / applyAction）：0 未捕获异常、0 非法返回')
  let calls = 0
  let uncaught = 0
  let illegalRet = 0
  const failSamples = []
  function noteIllegal(msg) { illegalRet++; if (failSamples.length < 6) failSamples.push(msg) }
  while (calls < 1000) {
    calls++
    const op = randInt(0, 5)
    try {
      if (op === 0) {
        const hand = randomHand(17)
        const last = randomLast()
        const plays = legalPlays(hand, last)
        if (!Array.isArray(plays)) noteIllegal('legalPlays 非数组')
        else for (const cs of plays) { const p = parsePlay(cs); if (!isPlay(p)) noteIllegal('legalPlays 含非法牌'); else if (canBeat(p, last) !== true) noteIllegal('legalPlays 含压不过 last 的牌') }
      } else if (op === 1) {
        const p = parsePlay(randomCombo())
        if (p !== null && !isPlay(p)) noteIllegal('parsePlay 非法形状')
      } else if (op === 2) {
        const w = canBeat(randomLast(), randomLast())
        if (typeof w !== 'boolean') noteIllegal('canBeat 非布尔')
      } else if (op === 3) {
        const w = canWin(randomHand(14), randInt(0, 3) === 0 ? [] : [{ kind: 'peng', tiles: [] }])
        if (typeof w !== 'boolean') noteIllegal('canWin 非布尔')
      } else if (op === 4) {
        const d = draw(createState(randInt(1, 1_000_000)))
        if (d !== null && !(d && d.state && Array.isArray(d.state.hand) && Array.isArray(d.state.wall))) noteIllegal('draw 非法形状')
      } else {
        const game = rng() < 0.5 ? 'ddz' : 'mj'
        const s = createSession(game, game === 'ddz' ? 3 : 4, { seed: randInt(1, 1_000_000) })
        const seat = turnSeat(s)
        let action
        if (game === 'ddz') action = rng() < 0.5 ? { type: 'pass' } : { type: 'play', cards: [s.hands[seat][0]] }
        else action = rng() < 0.5 ? { type: 'draw' } : { type: 'discard', tile: s.hands[seat][0] }
        const r = applyAction(s, seat, action)
        if (typeof r.ok !== 'boolean' || !r.session) noteIllegal('applyAction 返回非法形状')
      }
    } catch (e) {
      uncaught++
      if (failSamples.length < 6) failSamples.push(`op${op} 抛错：${e?.message ?? e}`)
    }
  }
  if (uncaught > 0) fail(`1000 次随机调用出现 ${uncaught} 次未捕获异常`)
  if (illegalRet > 0) fail(`1000 次随机调用出现 ${illegalRet} 次非法返回`)
  for (const s of failSamples) out(`      · 失败样例：${s}`)
  out(`    调用 ${calls} 次：未捕获异常 ${uncaught}、非法返回 ${illegalRet}`)
  out(uncaught === 0 && illegalRet === 0 ? '    ✅ [E] 通过：0 未捕获异常、0 非法返回' : '    ❌ [E] 失败')
  out('')

  // ================= 汇总 =================
  rule('=')
  if (failures.length === 0) {
    out('✅ 全部通过：斗地主 legalPlays 合法自洽 / 非法组合被拒 / 30 局正常终局 / 麻将牌数守恒 / 1000 次随机调用 0 异常 0 非法')
  } else {
    out(`❌ 发现 ${failures.length} 项失败：`)
    for (const f of failures.slice(0, 30)) out(`   - ${f}`)
    out('   结论：游戏引擎存在 bug，需按上述复现修复后重跑。')
  }
  rule('=')

  if (outPath) {
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
    console.log(`\n（报告已写入 ${outPath}）`)
  }
  if (failures.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n❌ games-fuzz 运行失败：', err?.stack ?? err)
  if (outPath) { try { writeFileSync(outPath, lines.join('\n') + '\n', 'utf8') } catch { /* ignore */ } }
  process.exitCode = 1
})
