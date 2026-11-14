import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, createFish, postLedger, getFish } from '../src/db/index.ts'

test('新鱼有启动资金，且账本求和等于余额', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '小圆子', balance: 100 })
  assert.equal(fish.balance, 100)
  const sum = (db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE fish_id=?').get(fish.id) as { s: number }).s
  assert.equal(sum, 100)
  db.close()
})

test('花钱不能透支', () => {
  const db = openDb(':memory:')
  const fish = createFish(db, { name: '阿鲸', balance: 10 })
  assert.throws(() => postLedger(db, fish.id, -20, 'seat_fee', 't1'))
  assert.equal(getFish(db, fish.id)!.balance, 10)
  const r = postLedger(db, fish.id, -7, 'seat_fee', 't2')
  assert.equal(r.balance, 3)
  db.close()
})
