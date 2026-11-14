// 打工领域：招工列表 / 接活 / 到期结算（发工资）/ 辞活。
// 赚钱路径：接活 → 到点 settleDueJobs 把 working 置 done 并 postLedger(+pay, 'job')。
import { ECONOMY } from '@fishbowl/shared'
import { getFish, newId, postLedger, tx } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { asDomainError, assertPositiveInt, DomainError } from './errors.ts'

export type ContractState = 'working' | 'done' | 'quit'

interface JobOfferRow {
  id: string
  title: string
  place: string | null
  pay: number
  duration_min: number
  slots: number
  requirements: string
  active: number
  created_at: number
}

interface JobContractRow {
  id: string
  fish_id: string
  offer_id: string
  started_at: number
  ends_at: number
  pay: number
  state: ContractState
  settled_at: number | null
}

export interface JobOfferView {
  id: string
  title: string
  place: string | null
  pay: number
  durationMin: number
  slots: number
  requirements: string
  active: boolean
  createdAt: number
  /** 已在岗（working）人数 */
  taken: number
  /** 余下名额 */
  available: number
}

export interface JobContractView {
  id: string
  fishId: string
  offerId: string
  startedAt: number
  endsAt: number
  pay: number
  state: ContractState
  settledAt: number | null
  /** 冗余招工标题，方便展示 */
  title?: string
}

function toOfferView(r: JobOfferRow, taken: number): JobOfferView {
  return {
    id: r.id,
    title: r.title,
    place: r.place,
    pay: r.pay,
    durationMin: r.duration_min,
    slots: r.slots,
    requirements: r.requirements,
    active: r.active === 1,
    createdAt: r.created_at,
    taken,
    available: Math.max(0, r.slots - taken),
  }
}

function toContractView(r: JobContractRow, title?: string): JobContractView {
  return {
    id: r.id,
    fishId: r.fish_id,
    offerId: r.offer_id,
    startedAt: r.started_at,
    endsAt: r.ends_at,
    pay: r.pay,
    state: r.state,
    settledAt: r.settled_at,
    title,
  }
}

/** 创建招工（供种子 / 测试 / 后续 admin 用）。pay 为整数鱼币，至少 MIN_JOB_PAY。 */
export function createJobOffer(
  db: DB,
  opts: {
    title: string
    pay: number
    place?: string | null
    durationMin?: number
    slots?: number
    requirements?: string
    active?: boolean
    now?: number
  },
): JobOfferView {
  const pay = assertPositiveInt(opts.pay, 'pay')
  if (pay < ECONOMY.MIN_JOB_PAY) {
    throw new DomainError('BAD_REQUEST', `pay must be >= ${ECONOMY.MIN_JOB_PAY}`)
  }
  const durationMin = opts.durationMin ?? 60
  assertPositiveInt(durationMin, 'durationMin')
  const slots = opts.slots ?? 1
  assertPositiveInt(slots, 'slots')
  if (!opts.title || typeof opts.title !== 'string') {
    throw new DomainError('BAD_REQUEST', 'title is required')
  }
  const id = newId('job')
  const now = opts.now ?? Date.now()
  db.prepare(
    'INSERT INTO job_offer(id, title, place, pay, duration_min, slots, requirements, active, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(id, opts.title, opts.place ?? null, pay, durationMin, slots, opts.requirements ?? '', opts.active === false ? 0 : 1, now)
  const row = db.prepare('SELECT * FROM job_offer WHERE id = ?').get(id) as unknown as JobOfferRow
  return toOfferView(row, 0)
}

function takenCount(db: DB, offerId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM job_contract WHERE offer_id = ? AND state = 'working'`)
    .get(offerId) as { c: number }
  return Number(row.c)
}

/** 招工列表（可含已下架；默认只列 active）。带在岗人数与余下名额。 */
export function listJobOffers(db: DB, opts: { includeInactive?: boolean } = {}): JobOfferView[] {
  const sql = opts.includeInactive
    ? 'SELECT * FROM job_offer ORDER BY created_at DESC'
    : 'SELECT * FROM job_offer WHERE active = 1 ORDER BY created_at DESC'
  const rows = db.prepare(sql).all() as unknown as JobOfferRow[]
  return rows.map((r) => toOfferView(r, takenCount(db, r.id)))
}

export function getJobOffer(db: DB, offerId: string): JobOfferView | null {
  const row = db.prepare('SELECT * FROM job_offer WHERE id = ?').get(offerId) as unknown as JobOfferRow | undefined
  return row ? toOfferView(row, takenCount(db, offerId)) : null
}

export function getContract(db: DB, contractId: string): JobContractView | null {
  const row = db.prepare('SELECT * FROM job_contract WHERE id = ?').get(contractId) as unknown as JobContractRow | undefined
  if (!row) return null
  const offer = db.prepare('SELECT title FROM job_offer WHERE id = ?').get(row.offer_id) as { title: string } | undefined
  return toContractView(row, offer?.title)
}

/** 一条鱼手上的劳动合同（默认全部，可按状态过滤）。 */
export function listFishContracts(db: DB, fishId: string, state?: ContractState): JobContractView[] {
  const rows = state
    ? (db.prepare('SELECT * FROM job_contract WHERE fish_id = ? AND state = ? ORDER BY started_at DESC').all(fishId, state) as unknown as JobContractRow[])
    : (db.prepare('SELECT * FROM job_contract WHERE fish_id = ? ORDER BY started_at DESC').all(fishId) as unknown as JobContractRow[])
  const titleStmt = db.prepare('SELECT title FROM job_offer WHERE id = ?')
  return rows.map((r) => {
    const offer = titleStmt.get(r.offer_id) as { title: string } | undefined
    return toContractView(r, offer?.title)
  })
}

/**
 * 接活：校验招工有效 / 有名额 / 这条鱼没有在岗的活，然后建 working 合同。
 * ends_at = now + durationMin 分钟（招工时长决定何时结算发工资）。
 * 返回合同视图。异常：NOT_FOUND / NO_SLOTS / ALREADY_WORKING / BAD_REQUEST。
 */
export function takeJob(db: DB, fishId: string, offerId: string, now: number = Date.now()): JobContractView {
  return tx(db, () => {
    const fish = getFish(db, fishId)
    if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)

    const offer = db.prepare('SELECT * FROM job_offer WHERE id = ?').get(offerId) as unknown as JobOfferRow | undefined
    if (!offer || offer.active !== 1) throw new DomainError('NOT_FOUND', `job offer not found or inactive: ${offerId}`)

    const working = db
      .prepare(`SELECT id FROM job_contract WHERE fish_id = ? AND state = 'working' LIMIT 1`)
      .get(fishId) as { id: string } | undefined
    if (working) {
      throw new DomainError('ALREADY_WORKING', `fish ${fishId} is already working on contract ${working.id}`, {
        detail: { contractId: working.id },
      })
    }

    const taken = takenCount(db, offer.id)
    if (taken >= offer.slots) {
      throw new DomainError('NO_SLOTS', `job offer ${offer.id} is full (${taken}/${offer.slots})`)
    }

    const id = newId('jc')
    const endsAt = now + offer.duration_min * 60_000
    db.prepare(
      'INSERT INTO job_contract(id, fish_id, offer_id, started_at, ends_at, pay, state, settled_at) VALUES(?,?,?,?,?,?,?,NULL)',
    ).run(id, fishId, offer.id, now, endsAt, offer.pay, 'working')
    const row = db.prepare('SELECT * FROM job_contract WHERE id = ?').get(id) as unknown as JobContractRow
    return toContractView(row, offer.title)
  })
}

export interface SettledJob {
  contractId: string
  fishId: string
  offerId: string
  pay: number
  balance: number
}

/**
 * 到期结算：把所有 ends_at <= now 且 state=working 的合同置为 done，并 postLedger(+pay, 'job')。
 * 幂等：只处理 working，重复调用不会重复发钱。返回本轮结算明细。
 */
export function settleDueJobs(db: DB, now: number = Date.now()): SettledJob[] {
  const due = db
    .prepare(`SELECT * FROM job_contract WHERE state = 'working' AND ends_at <= ? ORDER BY ends_at ASC`)
    .all(now) as unknown as JobContractRow[]
  if (due.length === 0) return []

  return tx(db, () => {
    const settled: SettledJob[] = []
    const markDone = db.prepare(`UPDATE job_contract SET state = 'done', settled_at = ? WHERE id = ? AND state = 'working'`)
    for (const c of due) {
      const res = markDone.run(now, c.id)
      if (Number(res.changes) === 0) continue // 并发下已被处理
      let balance: number
      try {
        balance = postLedger(db, c.fish_id, c.pay, 'job', c.id).balance
      } catch (e) {
        throw asDomainError(e)
      }
      settled.push({ contractId: c.id, fishId: c.fish_id, offerId: c.offer_id, pay: c.pay, balance })
    }
    return settled
  })
}

/** 辞活：把手上的 working 合同置为 quit（不发工资）。返回合同视图。 */
export function quitJob(db: DB, fishId: string, contractId: string, now: number = Date.now()): JobContractView {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM job_contract WHERE id = ?').get(contractId) as unknown as JobContractRow | undefined
    if (!row) throw new DomainError('NOT_FOUND', `contract not found: ${contractId}`)
    if (row.fish_id !== fishId) throw new DomainError('NOT_FOUND', `contract ${contractId} does not belong to ${fishId}`)
    if (row.state !== 'working') {
      throw new DomainError('CONTRACT_CLOSED', `contract ${contractId} is ${row.state}, cannot quit`)
    }
    db.prepare(`UPDATE job_contract SET state = 'quit', settled_at = ? WHERE id = ?`).run(now, contractId)
    const updated = db.prepare('SELECT * FROM job_contract WHERE id = ?').get(contractId) as unknown as JobContractRow
    const offer = db.prepare('SELECT title FROM job_offer WHERE id = ?').get(row.offer_id) as { title: string } | undefined
    return toContractView(updated, offer?.title)
  })
}
