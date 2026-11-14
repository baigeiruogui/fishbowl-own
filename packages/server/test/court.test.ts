import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, createFish, getFish } from '../src/db/index.ts'
import {
  castVote,
  compensate,
  ensureTreasury,
  fileCase,
  getCase,
  openJury,
  renderVerdict,
  submitEvidence,
} from '../src/domain/court.ts'

function setup() {
  const db = openDb(':memory:')
  const plaintiff = createFish(db, { name: '原告鱼', balance: 100 })
  const defendant = createFish(db, { name: '被告鱼', balance: 100 })
  return { db, plaintiff, defendant }
}

function ledgerCourtSum(db: ReturnType<typeof openDb>): { sum: number; rows: number } {
  const r = db.prepare(`SELECT COALESCE(SUM(delta),0) AS s, COUNT(*) AS c FROM ledger WHERE reason = 'court'`).get() as { s: number; c: number }
  return { sum: Number(r.s), rows: Number(r.c) }
}

// 1
test('court: 立案 state=filed，字段与初始证据正确', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'theft', desc: '偷了我的鱼干', evidence: ['监控截图'] })
  assert.equal(c.state, 'filed')
  assert.equal(c.plaintiff, plaintiff.id)
  assert.equal(c.defendant, defendant.id)
  assert.equal(c.kind, 'theft')
  assert.equal(c.evidence.length, 1)
  assert.equal(c.evidence[0]!.text, '监控截图')
  assert.equal(c.votes.length, 0)
  assert.equal(c.verdict, null)
  assert.deepEqual(getCase(db, c.id)!.state, 'filed')
})

// 2
test('court: 举证 filed→hearing，多份举证保持 hearing', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'civil', desc: '纠纷' })
  assert.equal(c.state, 'filed')
  const c1 = submitEvidence(db, c.id, plaintiff.id, '第一份证据')
  assert.equal(c1.state, 'hearing')
  assert.equal(c1.evidence.length, 1)
  const c2 = submitEvidence(db, c.id, defendant.id, '被告的反证')
  assert.equal(c2.state, 'hearing')
  assert.equal(c2.evidence.length, 2)
})

// 3
test('court: 多数票有罪（2 guilty / 1 not）→ verdict=guilty', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'theft', desc: 'x' })
  submitEvidence(db, c.id, plaintiff.id, '证据')
  const j1 = createFish(db, { name: '陪审1', balance: 0 })
  const j2 = createFish(db, { name: '陪审2', balance: 0 })
  const j3 = createFish(db, { name: '陪审3', balance: 0 })
  castVote(db, c.id, j1.id, true)
  castVote(db, c.id, j2.id, true)
  const voted = castVote(db, c.id, j3.id, false)
  assert.equal(voted.state, 'jury')
  assert.equal(voted.votes.length, 3)
  const r = renderVerdict(db, c.id)
  assert.equal(r.case.verdict, 'guilty')
  assert.equal(r.case.state, 'verdict')
  assert.equal(r.paid, false) // 未要 damages
})

// 4
test('court: 多数票无罪（1 guilty / 2 not）→ verdict=not_guilty', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'civil', desc: 'x' })
  submitEvidence(db, c.id, plaintiff.id, '证据')
  const j1 = createFish(db, { name: 'j1', balance: 0 })
  const j2 = createFish(db, { name: 'j2', balance: 0 })
  const j3 = createFish(db, { name: 'j3', balance: 0 })
  castVote(db, c.id, j1.id, true)
  castVote(db, c.id, j2.id, false)
  castVote(db, c.id, j3.id, false)
  const r = renderVerdict(db, c.id)
  assert.equal(r.case.verdict, 'not_guilty')
})

// 5
test('court: 平票按无罪推定（1:1 → not_guilty）', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'civil', desc: 'x' })
  submitEvidence(db, c.id, plaintiff.id, '证据')
  const j1 = createFish(db, { name: 'a', balance: 0 })
  const j2 = createFish(db, { name: 'b', balance: 0 })
  castVote(db, c.id, j1.id, true)
  castVote(db, c.id, j2.id, false)
  assert.equal(renderVerdict(db, c.id).case.verdict, 'not_guilty')
})

// 6
test('court: 有罪赔付账本守恒（财政 -40 / 受害者 +40，court 合计 0）', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'theft', desc: 'x' })
  submitEvidence(db, c.id, plaintiff.id, '证据')
  const j1 = createFish(db, { name: 'j1', balance: 0 })
  const j2 = createFish(db, { name: 'j2', balance: 0 })
  const j3 = createFish(db, { name: 'j3', balance: 0 })
  castVote(db, c.id, j1.id, true)
  castVote(db, c.id, j2.id, true)
  castVote(db, c.id, j3.id, false)

  const r = renderVerdict(db, c.id, { damages: 40 })
  assert.equal(r.paid, true)
  assert.equal(r.amount, 40)
  assert.equal(r.case.paid, true)
  assert.equal(r.case.compensation, 40)
  assert.equal(getFish(db, plaintiff.id)!.balance, 140) // 受害者收款

  const treasury = getFish(db, ensureTreasury(db))! // 复用同一财政账户
  assert.equal(treasury.balance, 460)

  const court = ledgerCourtSum(db)
  assert.equal(court.rows, 2)
  assert.equal(court.sum, 0, 'court 账本收支相抵（守恒）')
})

// 7
test('court: 财政余额不足 → 只记判决不赔付并注明', () => {
  const { db, plaintiff, defendant } = setup()
  const poorTreasury = createFish(db, { name: '穷财政', balance: 5 })
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'theft', desc: 'x' })
  submitEvidence(db, c.id, plaintiff.id, '证据')
  const j1 = createFish(db, { name: 'j1', balance: 0 })
  castVote(db, c.id, j1.id, true)

  const r = renderVerdict(db, c.id, { damages: 50, treasuryFishId: poorTreasury.id })
  assert.equal(r.case.verdict, 'guilty')
  assert.equal(r.paid, false)
  assert.match(r.note ?? r.case.payoutNote ?? '', /余额不足/)
  assert.equal(getFish(db, plaintiff.id)!.balance, 100, '受害者未收到钱')
  assert.equal(ledgerCourtSum(db).rows, 0, '没有产生 court 账本流水')
})

// 8
test('court: 非法状态转换被拒绝（不崩，抛可捕获 DomainError）', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'civil', desc: 'x' })

  const code = (fn: () => void): string => {
    try {
      fn()
    } catch (e) {
      return (e as { code?: string }).code ?? 'NO_CODE'
    }
    return 'NO_THROW'
  }

  // filed 不能直接判决 / 投票 / 进入陪审
  assert.equal(code(() => renderVerdict(db, c.id)), 'CONFLICT')
  assert.equal(code(() => castVote(db, c.id, createFish(db, { name: 'jj', balance: 0 }).id, true)), 'CONFLICT')
  assert.equal(code(() => openJury(db, c.id)), 'CONFLICT')
  // filed 状态不能赔付
  const filed = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'civil', desc: 'y' })
  assert.equal(code(() => compensate(db, filed.id, 10)), 'CONFLICT')

  // 走完流程后：再举证/再投票都被拒
  submitEvidence(db, c.id, plaintiff.id, 'e')
  const j1 = createFish(db, { name: 'j1', balance: 0 })
  castVote(db, c.id, j1.id, true)
  renderVerdict(db, c.id)
  assert.equal(code(() => submitEvidence(db, c.id, plaintiff.id, 'late')), 'CONFLICT')
  assert.equal(code(() => castVote(db, c.id, j1.id, false)), 'CONFLICT')
})

// 9
test('court: 立案校验（不存在的鱼 → NOT_FOUND；起诉自己 → BAD_REQUEST）', () => {
  const { db, plaintiff } = setup()
  const code = (fn: () => void): string => {
    try {
      fn()
    } catch (e) {
      return (e as { code?: string }).code ?? 'NO_CODE'
    }
    return 'NO_THROW'
  }
  assert.equal(code(() => fileCase(db, { plaintiff: 'f_nope', defendant: plaintiff.id, kind: 'x', desc: '' })), 'NOT_FOUND')
  assert.equal(code(() => fileCase(db, { plaintiff: plaintiff.id, defendant: plaintiff.id, kind: 'x', desc: '' })), 'BAD_REQUEST')
})

// 10
test('court: 同一陪审鱼重复投票覆盖，不重复计票；getCase 不存在返回 null', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'civil', desc: 'x' })
  submitEvidence(db, c.id, plaintiff.id, 'e')
  const j1 = createFish(db, { name: 'j1', balance: 0 })
  castVote(db, c.id, j1.id, true)
  const changed = castVote(db, c.id, j1.id, false)
  assert.equal(changed.votes.length, 1, '重复投票应覆盖而不是累加')
  assert.equal(changed.votes[0]!.guilty, false)
  assert.equal(getCase(db, 'case_nope'), null)
  assert.equal(getCase(db, c.id)!.id, c.id)
})

// 11
test('court: openJury 显式进入陪审后投票，有罪且未要求赔付时 paid=false 且注明', () => {
  const { db, plaintiff, defendant } = setup()
  const c = fileCase(db, { plaintiff: plaintiff.id, defendant: defendant.id, kind: 'theft', desc: 'x' })
  submitEvidence(db, c.id, plaintiff.id, 'e')
  const jury = openJury(db, c.id)
  assert.equal(jury.state, 'jury')
  const j1 = createFish(db, { name: 'j1', balance: 0 })
  castVote(db, c.id, j1.id, true)
  const r = renderVerdict(db, c.id)
  assert.equal(r.case.verdict, 'guilty')
  assert.equal(r.paid, false)
  assert.equal(r.case.payoutNote, '未要求赔付')
})
