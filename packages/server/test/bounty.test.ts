import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, getFish, openDb, postLedger } from '../src/db/index.ts'
import { ledgerSum, verifyBalance } from '../src/domain/account.ts'
import {
  claimBounty,
  createBounty,
  getBounty,
  listBounties,
  takeBounty,
} from '../src/domain/bounty.ts'

function bountyLedgerCount(db: ReturnType<typeof openDb>): number {
  return Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM ledger WHERE reason = 'bounty'`).get() as { c: number }).c,
  )
}

// -------- 1. 发布悬赏（不扣款） --------
test('发布悬赏：state=open、可见、发布本身不扣款', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 100 })

  const b = createBounty(db, poster.id, { title: '找珍珠', desc: '帮我找一颗珍珠', reward: 30 })
  assert.equal(b.state, 'open')
  assert.equal(b.reward, 30)
  assert.equal(b.posterFishId, poster.id)
  assert.equal(b.takerFishId, null)
  assert.equal(b.claimedAt, null)

  assert.equal(listBounties(db).length, 1)
  assert.equal(listBounties(db, 'open').length, 1)

  // 简化托管：发布不扣款，余额不变
  assert.equal(getFish(db, poster.id)!.balance, 100)
  assert.equal(bountyLedgerCount(db), 0)
  db.close()
})

// -------- 2. 接悬赏 open -> taken --------
test('接悬赏：open→taken，记录接单人', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 100 })
  const taker = createFish(db, { name: '接单鱼', balance: 0 })
  const b = createBounty(db, poster.id, { title: '送货', reward: 20 })

  const taken = takeBounty(db, b.id, taker.id)
  assert.equal(taken.state, 'taken')
  assert.equal(taken.takerFishId, taker.id)
  assert.equal(listBounties(db, 'taken').length, 1)
  assert.equal(listBounties(db, 'open').length, 0)
  db.close()
})

// -------- 3. 交差：赏金转移 poster -> taker --------
test('交差：state=done，赏金从海报转给接单人，账本 reason=bounty', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 100 })
  const taker = createFish(db, { name: '接单鱼', balance: 0 })
  const b = createBounty(db, poster.id, { title: '抓鱼', reward: 30 })
  takeBounty(db, b.id, taker.id)

  const done = claimBounty(db, b.id, taker.id, 1_700_000_000_000)
  assert.equal(done.state, 'done')
  assert.equal(done.claimedAt, 1_700_000_000_000)

  assert.equal(getFish(db, poster.id)!.balance, 70)
  assert.equal(getFish(db, taker.id)!.balance, 30)

  const rows = db
    .prepare(`SELECT fish_id, delta, ref FROM ledger WHERE reason = 'bounty' ORDER BY id ASC`)
    .all() as { fish_id: string; delta: number; ref: string }[]
  assert.equal(rows.length, 2)
  const posterRow = rows.find((r) => r.fish_id === poster.id)!
  const takerRow = rows.find((r) => r.fish_id === taker.id)!
  assert.equal(posterRow.delta, -30)
  assert.equal(takerRow.delta, 30)
  assert.equal(posterRow.ref, b.id)
  assert.equal(takerRow.ref, b.id)

  assert.equal(verifyBalance(db, poster.id).ok, true)
  assert.equal(verifyBalance(db, taker.id).ok, true)
  db.close()
})

// -------- 4. 不能接自己发的悬赏 --------
test('接自己的悬赏被拒且状态不变', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 100 })
  const b = createBounty(db, poster.id, { title: '自娱自乐', reward: 10 })

  assert.throws(() => takeBounty(db, b.id, poster.id), (e: any) => e.code === 'BAD_REQUEST')
  assert.equal(getBounty(db, b.id)!.state, 'open')
  assert.equal(getBounty(db, b.id)!.takerFishId, null)
  db.close()
})

// -------- 5. 已被接的不能再接 --------
test('已被接的悬赏再被第三人接会被拒（CONFLICT）', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 100 })
  const t1 = createFish(db, { name: '接单1', balance: 0 })
  const t2 = createFish(db, { name: '接单2', balance: 0 })
  const b = createBounty(db, poster.id, { title: '抢先', reward: 10 })
  takeBounty(db, b.id, t1.id)

  assert.throws(() => takeBounty(db, b.id, t2.id), (e: any) => e.code === 'CONFLICT')
  assert.equal(getBounty(db, b.id)!.takerFishId, t1.id)
  db.close()
})

// -------- 6. 非接单人不能交差；open 状态不能直接交差 --------
test('非接单人交差被拒；open 状态不能直接 claim', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 100 })
  const t1 = createFish(db, { name: '接单1', balance: 0 })
  const t2 = createFish(db, { name: '路人', balance: 0 })
  const b = createBounty(db, poster.id, { title: '抓鱼', reward: 10 })

  // open 状态直接 claim -> CONFLICT
  assert.throws(() => claimBounty(db, b.id, t1.id), (e: any) => e.code === 'CONFLICT')

  takeBounty(db, b.id, t1.id)
  // 路人不能 claim
  assert.throws(() => claimBounty(db, b.id, t2.id), (e: any) => e.code === 'CONFLICT')
  assert.equal(getBounty(db, b.id)!.state, 'taken')
  assert.equal(bountyLedgerCount(db), 0)
  db.close()
})

// -------- 7. 交差时海报余额不足：失败且无副作用 --------
test('交差时海报余额不足：抛 INSUFFICIENT，账本无赏金记录、状态仍 taken', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 30 })
  const taker = createFish(db, { name: '接单鱼', balance: 0 })
  const b = createBounty(db, poster.id, { title: '抓鱼', reward: 30 })
  takeBounty(db, b.id, taker.id) // 接取时海报余额够

  // 接单后海报把钱花光
  postLedger(db, poster.id, -30, 'admin', 'drain')
  assert.equal(getFish(db, poster.id)!.balance, 0)
  const beforePoster = ledgerSum(db, poster.id)
  const beforeTaker = ledgerSum(db, taker.id)

  assert.throws(() => claimBounty(db, b.id, taker.id), (e: any) => e.code === 'INSUFFICIENT')

  assert.equal(getBounty(db, b.id)!.state, 'taken')
  assert.equal(getFish(db, taker.id)!.balance, 0) // 接单人没白拿
  assert.equal(ledgerSum(db, poster.id), beforePoster)
  assert.equal(ledgerSum(db, taker.id), beforeTaker)
  assert.equal(bountyLedgerCount(db), 0)
  assert.equal(verifyBalance(db, poster.id).ok, true)
  assert.equal(verifyBalance(db, taker.id).ok, true)
  db.close()
})

// -------- 8. listBounties 按状态过滤 --------
test('listBounties 按状态过滤', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 100 })
  const taker = createFish(db, { name: '接单鱼', balance: 0 })
  const b1 = createBounty(db, poster.id, { title: '悬赏1', reward: 10 })
  const b2 = createBounty(db, poster.id, { title: '悬赏2', reward: 15 })
  takeBounty(db, b2.id, taker.id)

  assert.deepEqual(
    listBounties(db, 'open').map((b) => b.id),
    [b1.id],
  )
  assert.deepEqual(
    listBounties(db, 'taken').map((b) => b.id),
    [b2.id],
  )
  assert.equal(listBounties(db).length, 2)
  assert.equal(listBounties(db, 'done').length, 0)
  db.close()
})

// -------- 9. 接取时海报余额不足：拒绝 --------
test('接取时海报余额不足：抛 INSUFFICIENT，悬赏仍 open', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '穷海报', balance: 5 })
  const taker = createFish(db, { name: '接单鱼', balance: 0 })
  const b = createBounty(db, poster.id, { title: '大赏', reward: 30 })

  assert.throws(() => takeBounty(db, b.id, taker.id), (e: any) => e.code === 'INSUFFICIENT')
  assert.equal(getBounty(db, b.id)!.state, 'open')
  assert.equal(getBounty(db, b.id)!.takerFishId, null)
  db.close()
})

// -------- 10. 发布参数校验 --------
test('发布悬赏参数校验：海报不存在 / 空标题 / 非法赏金被拒', () => {
  const db = openDb(':memory:')
  const poster = createFish(db, { name: '悬赏主', balance: 100 })

  assert.throws(() => createBounty(db, 'f_nope', { title: 'x', reward: 10 }), (e: any) => e.code === 'NOT_FOUND')
  assert.throws(() => createBounty(db, poster.id, { title: '   ', reward: 10 }), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => createBounty(db, poster.id, { title: 'x', reward: 0 }), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => createBounty(db, poster.id, { title: 'x', reward: -5 }), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => createBounty(db, poster.id, { title: 'x', reward: 1.5 }), (e: any) => e.code === 'BAD_REQUEST')
  assert.equal(listBounties(db).length, 0)
  db.close()
})
