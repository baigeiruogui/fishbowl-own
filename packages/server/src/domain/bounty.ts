// 悬赏领域：发布 / 接取 / 交差（赏金转移）。
// 简化托管模型：发布不立即扣款；接取时校验 poster 余额；交差时 tx 内
// postLedger(poster,-reward,'bounty') 与 postLedger(taker,+reward,'bounty')，赏金由海报转给接单人。
// 铁律：金额一律走 postLedger（整数鱼币）；余额不足时整体回滚，无副作用。
import { getFish, newId, postLedger, tx } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { asDomainError, assertPositiveInt, DomainError } from './errors.ts'

export type BountyState = 'open' | 'taken' | 'done' | 'expired'

export interface BountyView {
  id: string
  posterFishId: string | null
  title: string
  desc: string
  reward: number
  state: BountyState
  takerFishId: string | null
  createdAt: number
  claimedAt: number | null
}

interface BountyRow {
  id: string
  poster_fish_id: string | null
  title: string
  desc: string
  reward: number
  state: BountyState
  taker_fish_id: string | null
  created_at: number
  claimed_at: number | null
}

function toBountyView(r: BountyRow): BountyView {
  return {
    id: r.id,
    posterFishId: r.poster_fish_id,
    title: r.title,
    desc: r.desc,
    reward: r.reward,
    state: r.state,
    takerFishId: r.taker_fish_id,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
  }
}

/** 按 id 取悬赏。不存在返回 null。 */
export function getBounty(db: DB, bountyId: string): BountyView | null {
  const r = db.prepare('SELECT * FROM bounty WHERE id = ?').get(bountyId) as unknown as BountyRow | undefined
  return r ? toBountyView(r) : null
}

export interface CreateBountyInput {
  title: string
  desc?: string
  /** 赏金（整数鱼币，>=1） */
  reward: number
}

/** 发布悬赏（state=open）。reward 必须为正整数鱼币。发布本身不扣款（接取时校验、交差时转账）。 */
export function createBounty(
  db: DB,
  posterFishId: string,
  opts: CreateBountyInput,
  now: number = Date.now(),
): BountyView {
  const poster = getFish(db, posterFishId)
  if (!poster) throw new DomainError('NOT_FOUND', `fish not found: ${posterFishId}`)
  if (typeof opts?.title !== 'string' || opts.title.trim() === '') {
    throw new DomainError('BAD_REQUEST', 'bounty title is required')
  }
  const reward = assertPositiveInt(opts.reward, 'reward')
  const id = newId('bounty')
  db.prepare(
    'INSERT INTO bounty(id, poster_fish_id, title, desc, reward, state, taker_fish_id, created_at, claimed_at) VALUES(?,?,?,?,?,?,NULL,?,NULL)',
  ).run(id, posterFishId, opts.title.trim(), opts.desc ?? '', reward, 'open', now)
  return getBounty(db, id)!
}

/**
 * 接悬赏：open -> taken，记录 taker。
 * 校验：悬赏存在且 open / 接单人存在 / 非自接 / poster 当前余额足够支付赏金。
 * 异常：NOT_FOUND / CONFLICT（状态不对或已被抢）/ BAD_REQUEST（自接）/ INSUFFICIENT（海报余额不足）。
 */
export function takeBounty(db: DB, bountyId: string, fishId: string): BountyView {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM bounty WHERE id = ?').get(bountyId) as unknown as BountyRow | undefined
    if (!row) throw new DomainError('NOT_FOUND', `bounty not found: ${bountyId}`)
    if (row.state !== 'open') throw new DomainError('CONFLICT', `bounty ${bountyId} is ${row.state}, cannot take`)

    const taker = getFish(db, fishId)
    if (!taker) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
    if (row.poster_fish_id === fishId) {
      throw new DomainError('BAD_REQUEST', `fish cannot take its own bounty: ${bountyId}`)
    }
    if (row.poster_fish_id) {
      const poster = getFish(db, row.poster_fish_id)
      if (!poster) throw new DomainError('NOT_FOUND', `poster fish not found: ${row.poster_fish_id}`)
      if (poster.balance < row.reward) {
        throw new DomainError('INSUFFICIENT', `poster balance ${poster.balance} < reward ${row.reward}`, {
          balance: poster.balance,
        })
      }
    }

    const res = db
      .prepare(`UPDATE bounty SET state = 'taken', taker_fish_id = ? WHERE id = ? AND state = 'open'`)
      .run(fishId, bountyId)
    if (Number(res.changes) === 0) {
      throw new DomainError('CONFLICT', `bounty ${bountyId} was taken concurrently`)
    }
    return getBounty(db, bountyId)!
  })
}

/**
 * 交差领赏：state -> done，tx 内把赏金从 poster 转给 taker：
 *   postLedger(poster, -reward, 'bounty', bountyId) + postLedger(taker, +reward, 'bounty', bountyId)。
 * 先扣 poster 再给 taker：若 poster 余额不足则抛 INSUFFICIENT，整笔事务回滚（taker 不会白拿）。
 * 校验：悬赏存在且 taken / 必须是登记过的接单人。
 */
export function claimBounty(db: DB, bountyId: string, fishId: string, now: number = Date.now()): BountyView {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM bounty WHERE id = ?').get(bountyId) as unknown as BountyRow | undefined
    if (!row) throw new DomainError('NOT_FOUND', `bounty not found: ${bountyId}`)
    if (row.state !== 'taken') throw new DomainError('CONFLICT', `bounty ${bountyId} is ${row.state}, cannot claim`)
    if (row.taker_fish_id !== fishId) {
      throw new DomainError('CONFLICT', `only the taker can claim bounty ${bountyId}`, {
        detail: { takerFishId: row.taker_fish_id },
      })
    }
    const posterId = row.poster_fish_id
    if (!posterId) throw new DomainError('CONFLICT', `bounty ${bountyId} has no poster`)

    try {
      postLedger(db, posterId, -row.reward, 'bounty', bountyId) // 先扣海报（不足即失败）
      postLedger(db, fishId, row.reward, 'bounty', bountyId) // 再给接单人
    } catch (e) {
      throw asDomainError(e) // 保留 INSUFFICIENT / NOT_FOUND
    }

    const res = db
      .prepare(`UPDATE bounty SET state = 'done', claimed_at = ? WHERE id = ? AND state = 'taken'`)
      .run(now, bountyId)
    if (Number(res.changes) === 0) {
      throw new DomainError('CONFLICT', `bounty ${bountyId} changed concurrently`)
    }
    return getBounty(db, bountyId)!
  })
}

/** 悬赏列表；可按 state 过滤。默认按创建时间倒序。 */
export function listBounties(db: DB, state?: BountyState): BountyView[] {
  const rows = (
    state
      ? db.prepare('SELECT * FROM bounty WHERE state = ? ORDER BY created_at DESC, id DESC').all(state)
      : db.prepare('SELECT * FROM bounty ORDER BY created_at DESC, id DESC').all()
  ) as unknown as BountyRow[]
  return rows.map(toBountyView)
}
