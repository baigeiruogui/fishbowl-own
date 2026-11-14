// 法庭领域模块（纯新增，不接线）：立案 / 举证 / 陪审投票 / 判决 / （可选）赔付。
// 复用 db / tx / postLedger 与 court_case 表（案件全部字段存 data_json）。
// 状态机：filed → hearing(举证) → jury(陪审投票) → verdict(判决)。非法转换抛 DomainError（可捕获、不崩）。
import { createFish, getFish, newId, postLedger, tx } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import type { LedgerReason } from '@fishbowl/shared'
import { assertPositiveInt, DomainError } from './errors.ts'

// shared 的 LedgerReason 还没有 'court'（本模块不接线，先按值透传；DB 只存文本）
const COURT_REASON = 'court' as unknown as LedgerReason
const TREASURY_NAME = '镇财政'
const TREASURY_META = 'court_treasury'

export type CaseState = 'filed' | 'hearing' | 'jury' | 'verdict'
export type Verdict = 'guilty' | 'not_guilty'

export interface Evidence {
  by: string
  text: string
  ts: number
}

export interface Vote {
  jurorFishId: string
  guilty: boolean
  ts: number
}

export interface CourtCaseView {
  id: string
  plaintiff: string
  defendant: string
  kind: string
  desc: string
  state: CaseState
  evidence: Evidence[]
  votes: Vote[]
  verdict: Verdict | null
  compensation: number
  paid: boolean
  payoutNote: string | null
  createdAt: number
  updatedAt: number
}

interface CaseData extends CourtCaseView {}

interface CaseRow {
  id: string
  kind: string | null
  state: string
  data_json: string
  ts: number
}

export interface FileCaseInput {
  plaintiff: string
  defendant: string
  kind: string
  desc: string
  evidence?: (string | { by?: string; text: string })[]
}

function metaGet(db: DB, k: string): string | null {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined
  return r ? r.v : null
}

function metaSet(db: DB, k: string, v: string): void {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v)
}

function toView(d: CaseData): CourtCaseView {
  return {
    id: d.id,
    plaintiff: d.plaintiff,
    defendant: d.defendant,
    kind: d.kind,
    desc: d.desc,
    state: d.state,
    evidence: d.evidence ?? [],
    votes: d.votes ?? [],
    verdict: d.verdict ?? null,
    compensation: d.compensation ?? 0,
    paid: !!d.paid,
    payoutNote: d.payoutNote ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

function loadData(db: DB, caseId: string): CaseData {
  const row = db.prepare('SELECT * FROM court_case WHERE id = ?').get(caseId) as unknown as CaseRow | undefined
  if (!row) throw new DomainError('NOT_FOUND', `case not found: ${caseId}`)
  let data: CaseData
  try {
    data = JSON.parse(row.data_json) as CaseData
  } catch {
    throw new DomainError('CONFLICT', `case data corrupted: ${caseId}`)
  }
  // 以行上的 state/kind 为准（行是索引字段）
  data.state = row.state as CaseState
  if (row.kind) data.kind = row.kind
  return data
}

function saveData(db: DB, data: CaseData): void {
  db.prepare('UPDATE court_case SET kind = ?, state = ?, data_json = ?, ts = ? WHERE id = ?').run(
    data.kind,
    data.state,
    JSON.stringify(data),
    data.updatedAt,
    data.id,
  )
}

/** 取案件视图；不存在返回 null。 */
export function getCase(db: DB, caseId: string): CourtCaseView | null {
  try {
    return toView(loadData(db, caseId))
  } catch {
    return null
  }
}

/** 立案：state='filed'。plaintiff / defendant 必须是存在的鱼。 */
export function fileCase(db: DB, input: FileCaseInput, now: number = Date.now()): CourtCaseView {
  const plaintiff = String(input?.plaintiff ?? '')
  const defendant = String(input?.defendant ?? '')
  if (!plaintiff || !defendant) throw new DomainError('BAD_REQUEST', 'plaintiff 与 defendant 都必填')
  if (plaintiff === defendant) throw new DomainError('BAD_REQUEST', '不能起诉自己')
  if (!getFish(db, plaintiff)) throw new DomainError('NOT_FOUND', `plaintiff not found: ${plaintiff}`)
  if (!getFish(db, defendant)) throw new DomainError('NOT_FOUND', `defendant not found: ${defendant}`)
  const kind = typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : 'civil'
  const desc = typeof input.desc === 'string' ? input.desc : ''
  const evidence: Evidence[] = (input.evidence ?? []).map((e) => {
    if (typeof e === 'string') return { by: plaintiff, text: e, ts: now }
    return { by: e.by ?? plaintiff, text: String(e.text ?? ''), ts: now }
  })

  const id = newId('case')
  const data: CaseData = {
    id,
    plaintiff,
    defendant,
    kind,
    desc,
    state: 'filed',
    evidence,
    votes: [],
    verdict: null,
    compensation: 0,
    paid: false,
    payoutNote: null,
    createdAt: now,
    updatedAt: now,
  }
  db.prepare('INSERT INTO court_case(id, kind, state, data_json, ts) VALUES(?,?,?,?,?)').run(id, kind, 'filed', JSON.stringify(data), now)
  return toView(data)
}

/** 举证：filed → hearing（再次举证保持 hearing）。已进入陪审/判决则拒绝。 */
export function submitEvidence(db: DB, caseId: string, by: string, text: string, now: number = Date.now()): CourtCaseView {
  if (typeof text !== 'string' || !text.trim()) throw new DomainError('BAD_REQUEST', '举证内容不能为空')
  return tx(db, () => {
    const data = loadData(db, caseId)
    if (data.state !== 'filed' && data.state !== 'hearing') {
      throw new DomainError('CONFLICT', `案件当前状态 ${data.state} 不能举证`)
    }
    const who = String(by ?? '')
    if (!who || !getFish(db, who)) throw new DomainError('NOT_FOUND', `举证人不存在: ${who}`)
    data.evidence.push({ by: who, text: text.trim(), ts: now })
    if (data.state === 'filed') data.state = 'hearing'
    data.updatedAt = now
    saveData(db, data)
    return toView(data)
  })
}

/** 进入陪审：filed/hearing → jury（须已举证到 hearing）。 */
export function openJury(db: DB, caseId: string, now: number = Date.now()): CourtCaseView {
  return tx(db, () => {
    const data = loadData(db, caseId)
    if (data.state !== 'hearing') throw new DomainError('CONFLICT', `案件当前状态 ${data.state} 不能进入陪审（需先举证）`)
    data.state = 'jury'
    data.updatedAt = now
    saveData(db, data)
    return toView(data)
  })
}

/** 陪审投票：hearing → jury（首个投票自动进入陪审）；同一陪审鱼重复投票会覆盖。已判决拒绝。 */
export function castVote(db: DB, caseId: string, jurorFishId: string, guilty: boolean, now: number = Date.now()): CourtCaseView {
  if (typeof guilty !== 'boolean') throw new DomainError('BAD_REQUEST', 'guilty 必须是布尔值')
  return tx(db, () => {
    const data = loadData(db, caseId)
    if (data.state === 'verdict') throw new DomainError('CONFLICT', '案件已判决，不能再投票')
    if (data.state === 'filed') throw new DomainError('CONFLICT', '案件还在 filed，需先举证再进入陪审')
    if (!jurorFishId || !getFish(db, jurorFishId)) throw new DomainError('NOT_FOUND', `陪审员不存在: ${jurorFishId}`)

    const existing = data.votes.find((v) => v.jurorFishId === jurorFishId)
    if (existing) {
      existing.guilty = guilty
      existing.ts = now
    } else {
      data.votes.push({ jurorFishId, guilty, ts: now })
    }
    data.state = 'jury'
    data.updatedAt = now
    saveData(db, data)
    return toView(data)
  })
}

/** 确保存在「镇财政」系统鱼（kind=npc）；返回其 id（余额见 getFish）。 */
export function ensureTreasury(db: DB, initialBalance = 500, now: number = Date.now()): string {
  const existingId = metaGet(db, TREASURY_META)
  if (existingId && getFish(db, existingId)) return existingId
  const fish = createFish(db, { name: TREASURY_NAME, kind: 'npc', persona: '小镇财政账户', balance: initialBalance })
  metaSet(db, TREASURY_META, fish.id)
  return fish.id
}

export interface VerdictOptions {
  /** 有罪时的赔付金额（鱼币，正整数）。0/不填 = 只判决不赔付。 */
  damages?: number
  /** 指定财政账户鱼 id；缺省用/建「镇财政」系统鱼。 */
  treasuryFishId?: string
  now?: number
}

export interface VerdictResult {
  case: CourtCaseView
  paid: boolean
  amount: number
  note?: string
}

/**
 * 判决：jury 状态下按票数多数定有罪/无罪（平票按无罪推定）。
 * 若判有罪且给了 damages，则从镇财政 postLedger(-amount,'court') → 受害者(plaintiff) postLedger(+amount,'court')。
 * 财政余额不足时只记判决、不赔付，并在 payoutNote 注明。
 */
export function renderVerdict(db: DB, caseId: string, opts: VerdictOptions = {}): VerdictResult {
  const now = opts.now ?? Date.now()
  const damages = opts.damages && opts.damages > 0 ? assertPositiveInt(opts.damages, 'damages') : 0

  // 先按当前票数预判是否会赔付，必要时在事务外建财政账户（createFish 自带事务，不能嵌在外层 tx 里）
  const pre = loadData(db, caseId)
  if (pre.state !== 'jury') throw new DomainError('CONFLICT', `案件当前状态 ${pre.state} 不能判决（需进入 jury）`)
  if (pre.votes.length === 0) throw new DomainError('CONFLICT', '还没有陪审投票，不能判决')
  const preGuilty = pre.votes.filter((v) => v.guilty).length
  const preVerdict: Verdict = preGuilty > pre.votes.length - preGuilty ? 'guilty' : 'not_guilty'
  const willPay = preVerdict === 'guilty' && damages > 0
  const treasuryId = willPay ? opts.treasuryFishId ?? ensureTreasury(db, 500, now) : null

  return tx(db, () => {
    const data = loadData(db, caseId)
    if (data.state !== 'jury') throw new DomainError('CONFLICT', `案件当前状态 ${data.state} 不能判决（需进入 jury）`)
    if (data.votes.length === 0) throw new DomainError('CONFLICT', '还没有陪审投票，不能判决')
    const guiltyVotes = data.votes.filter((v) => v.guilty).length
    const notGuiltyVotes = data.votes.length - guiltyVotes
    const verdict: Verdict = guiltyVotes > notGuiltyVotes ? 'guilty' : 'not_guilty'
    data.verdict = verdict
    data.state = 'verdict'

    let paid = false
    let amount = 0
    let note: string | undefined
    if (verdict === 'guilty' && damages > 0) {
      amount = damages
      data.compensation = damages
      const treasury = treasuryId ? getFish(db, treasuryId) : null
      if (!treasury) {
        note = '没有镇财政账户，只记判决未赔付'
        data.payoutNote = note
      } else if (treasury.balance < amount) {
        note = `镇财政余额不足（有 ${treasury.balance}），只记判决未赔付`
        data.payoutNote = note
      } else {
        postLedger(db, treasury.id, -amount, COURT_REASON, caseId)
        postLedger(db, data.plaintiff, amount, COURT_REASON, caseId)
        paid = true
        data.paid = true
        data.payoutNote = null
      }
    } else if (verdict === 'guilty') {
      data.payoutNote = '未要求赔付'
    }
    data.updatedAt = now
    saveData(db, data)
    return { case: toView(data), paid, amount, note }
  })
}

/** 单独赔付：必须在已判有罪后进行（给受害者 plaintiff 打钱、财政扣钱）。 */
export function compensate(db: DB, caseId: string, amount: number, treasuryFishId?: string, now: number = Date.now()): VerdictResult {
  const amt = assertPositiveInt(amount, 'amount')
  const pre = loadData(db, caseId)
  if (pre.state !== 'verdict' || pre.verdict !== 'guilty') throw new DomainError('CONFLICT', '只有已判有罪的案件才能赔付')
  const treasuryId = treasuryFishId ?? ensureTreasury(db, 500, now)
  return tx(db, () => {
    const data = loadData(db, caseId)
    if (data.state !== 'verdict' || data.verdict !== 'guilty') throw new DomainError('CONFLICT', '只有已判有罪的案件才能赔付')
    if (data.paid) throw new DomainError('CONFLICT', '该案件已赔付过')
    const treasury = getFish(db, treasuryId)
    if (!treasury) throw new DomainError('NOT_FOUND', '财政账户不存在')
    if (treasury.balance < amt) {
      data.payoutNote = `镇财政余额不足（有 ${treasury.balance}），只记判决未赔付`
      data.updatedAt = now
      saveData(db, data)
      return { case: toView(data), paid: false, amount: amt, note: data.payoutNote }
    }
    postLedger(db, treasury.id, -amt, COURT_REASON, caseId)
    postLedger(db, data.plaintiff, amt, COURT_REASON, caseId)
    data.compensation = amt
    data.paid = true
    data.payoutNote = null
    data.updatedAt = now
    saveData(db, data)
    return { case: toView(data), paid: true, amount: amt }
  })
}
