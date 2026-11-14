import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFish, getFish, openDb } from '../src/db/index.ts'
import { ledgerSum, verifyBalance } from '../src/domain/account.ts'
import {
  addItem,
  buyItem,
  createShop,
  getShop,
  listOpenShops,
  listShop,
  setItemPrice,
  setStock,
} from '../src/domain/shop.ts'

function ordersCount(db: ReturnType<typeof openDb>): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number }).c)
}

// -------- 1. 开店 → 上货 → 浏览 --------
test('开店→上货→浏览：店主店铺与在售商品可见', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主鱼', balance: 0 })

  const shop = createShop(db, owner.id, '小鱼铺', 'food')
  assert.equal(shop.ownerFishId, owner.id)
  assert.equal(shop.name, '小鱼铺')
  assert.equal(shop.kind, 'food')
  assert.equal(shop.open, true)
  assert.deepEqual(shop.items, [])

  const item = addItem(db, shop.id, { name: '海藻饼', price: 12, stock: 5, desc: '好吃' })
  assert.equal(item.price, 12)
  assert.equal(item.stock, 5)
  assert.equal(item.shopId, shop.id)

  const listed = listShop(db, owner.id)!
  assert.equal(listed.id, shop.id)
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].name, '海藻饼')

  const open = listOpenShops(db)
  assert.equal(open.length, 1)
  assert.equal(open[0].id, shop.id)
  assert.equal(open[0].items[0].id, item.id)

  assert.equal(getShop(db, shop.id)!.items[0].desc, '好吃')
  db.close()
})

// -------- 2. 购买：店主进账 / 买家扣款 / 库存减 / 写 orders --------
test('购买：买家扣款、店主进账、库存减少、orders 记录、账本 reason 正确', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 0 })
  const buyer = createFish(db, { name: '买家', balance: 100 })
  const shop = createShop(db, owner.id, '鱼干店')
  const item = addItem(db, shop.id, { name: '鱼干', price: 10, stock: 3 })

  const res = buyItem(db, buyer.id, item.id, 2)
  assert.equal(res.qty, 2)
  assert.equal(res.unitPrice, 10)
  assert.equal(res.total, 20)
  assert.equal(res.buyerBalance, 80)
  assert.equal(res.ownerBalance, 20)
  assert.equal(res.remainingStock, 1)

  assert.equal(getFish(db, buyer.id)!.balance, 80)
  assert.equal(getFish(db, owner.id)!.balance, 20)
  assert.equal(listShop(db, owner.id)!.items[0].stock, 1)

  // orders 落库
  assert.equal(ordersCount(db), 1)
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(res.orderId) as {
    buyer_fish_id: string
    shop_id: string
    item_id: string
    qty: number
    total: number
  }
  assert.equal(order.buyer_fish_id, buyer.id)
  assert.equal(order.shop_id, shop.id)
  assert.equal(order.item_id, item.id)
  assert.equal(order.qty, 2)
  assert.equal(order.total, 20)

  // 账本：买家 -20 reason=buy，店主 +20 reason=shop_sale，ref=orderId
  const buyRows = db
    .prepare(`SELECT delta, reason, ref FROM ledger WHERE fish_id = ? AND reason = 'buy'`)
    .all(buyer.id) as { delta: number; reason: string; ref: string }[]
  assert.equal(buyRows.length, 1)
  assert.equal(buyRows[0].delta, -20)
  assert.equal(buyRows[0].ref, res.orderId)

  const saleRows = db
    .prepare(`SELECT delta, reason, ref FROM ledger WHERE fish_id = ? AND reason = 'shop_sale'`)
    .all(owner.id) as { delta: number; reason: string; ref: string }[]
  assert.equal(saleRows.length, 1)
  assert.equal(saleRows[0].delta, 20)
  assert.equal(saleRows[0].ref, res.orderId)

  assert.equal(verifyBalance(db, buyer.id).ok, true)
  assert.equal(verifyBalance(db, owner.id).ok, true)
  db.close()
})

// -------- 3. 禁止自购 --------
test('禁止自购：店主买自己商品报错且无副作用', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '自营鱼', balance: 100 })
  const shop = createShop(db, owner.id, '自家店')
  const item = addItem(db, shop.id, { name: '自产鱼', price: 10, stock: 5 })
  const before = ledgerSum(db, owner.id)

  assert.throws(() => buyItem(db, owner.id, item.id, 1), (e: any) => e.code === 'BAD_REQUEST')

  assert.equal(getFish(db, owner.id)!.balance, 100)
  assert.equal(listShop(db, owner.id)!.items[0].stock, 5)
  assert.equal(ledgerSum(db, owner.id), before)
  assert.equal(ordersCount(db), 0)
  db.close()
})

// -------- 4. 库存不足：失败且无副作用 --------
test('库存不足：失败且账本 / 库存 / 余额全部无副作用', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 0 })
  const buyer = createFish(db, { name: '买家', balance: 100 })
  const shop = createShop(db, owner.id, '缺货店')
  const item = addItem(db, shop.id, { name: '限量鱼', price: 10, stock: 2 })

  const beforeBuyer = ledgerSum(db, buyer.id)
  const beforeOwner = ledgerSum(db, owner.id)

  assert.throws(() => buyItem(db, buyer.id, item.id, 3), (e: any) => e.code === 'CONFLICT')

  assert.equal(listShop(db, owner.id)!.items[0].stock, 2) // 库存未减
  assert.equal(getFish(db, buyer.id)!.balance, 100)
  assert.equal(getFish(db, owner.id)!.balance, 0)
  assert.equal(ledgerSum(db, buyer.id), beforeBuyer)
  assert.equal(ledgerSum(db, owner.id), beforeOwner)
  assert.equal(ordersCount(db), 0)
  db.close()
})

// -------- 5. 余额不足：失败且库存回滚 --------
test('余额不足：失败且已扣的库存回滚、账本无副作用', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 0 })
  const buyer = createFish(db, { name: '穷买家', balance: 5 })
  const shop = createShop(db, owner.id, '贵店')
  const item = addItem(db, shop.id, { name: '贵鱼', price: 10, stock: 3 })

  const beforeBuyer = ledgerSum(db, buyer.id)
  const beforeOwner = ledgerSum(db, owner.id)

  assert.throws(() => buyItem(db, buyer.id, item.id, 1), (e: any) => e.code === 'INSUFFICIENT')

  assert.equal(listShop(db, owner.id)!.items[0].stock, 3) // 库存回滚
  assert.equal(getFish(db, buyer.id)!.balance, 5)
  assert.equal(getFish(db, owner.id)!.balance, 0)
  assert.equal(ledgerSum(db, buyer.id), beforeBuyer)
  assert.equal(ledgerSum(db, owner.id), beforeOwner)
  assert.equal(ordersCount(db), 0)
  assert.equal(verifyBalance(db, buyer.id).ok, true)
  db.close()
})

// -------- 6. 改价 --------
test('改价：有效改价生效，非法价格 / 不存在商品被拒', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 0 })
  const shop = createShop(db, owner.id, '改价店')
  const item = addItem(db, shop.id, { name: '鱼丸', price: 10, stock: 1 })

  const updated = setItemPrice(db, item.id, 25)
  assert.equal(updated.price, 25)
  assert.equal(listShop(db, owner.id)!.items[0].price, 25)

  assert.throws(() => setItemPrice(db, item.id, 0), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => setItemPrice(db, item.id, -5), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => setItemPrice(db, item.id, 1.5), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => setItemPrice(db, 'item_nope', 5), (e: any) => e.code === 'NOT_FOUND')
  db.close()
})

// -------- 7. 改库存 --------
test('改库存：有效改库存生效，负数 / 小数 / 不存在商品被拒', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 0 })
  const shop = createShop(db, owner.id, '补货店')
  const item = addItem(db, shop.id, { name: '鱼丸', price: 10, stock: 1 })

  assert.equal(setStock(db, item.id, 0).stock, 0)
  assert.equal(setStock(db, item.id, 50).stock, 50)

  assert.throws(() => setStock(db, item.id, -1), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => setStock(db, item.id, 2.5), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => setStock(db, 'item_nope', 1), (e: any) => e.code === 'NOT_FOUND')
  db.close()
})

// -------- 8. 关店：不进 open 列表、购买被拒 --------
test('关店后：不在营业列表，购买被拒且无副作用', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 0 })
  const buyer = createFish(db, { name: '买家', balance: 100 })
  const shop = createShop(db, owner.id, '打烊店')
  const item = addItem(db, shop.id, { name: '鱼丸', price: 10, stock: 5 })

  assert.equal(listOpenShops(db).length, 1)
  db.prepare('UPDATE shop SET open = 0 WHERE id = ?').run(shop.id)
  assert.equal(listOpenShops(db).length, 0)

  const before = ledgerSum(db, buyer.id)
  assert.throws(() => buyItem(db, buyer.id, item.id, 1), (e: any) => e.code === 'CONFLICT')
  assert.equal(getFish(db, buyer.id)!.balance, 100)
  assert.equal(listShop(db, owner.id)!.items[0].stock, 5)
  assert.equal(ledgerSum(db, buyer.id), before)
  db.close()
})

// -------- 9. 开店 / 上货参数校验 --------
test('开店/上货参数校验：鱼不存在、空名、非法价格被拒', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 0 })
  const shop = createShop(db, owner.id, '校验店')

  assert.throws(() => createShop(db, 'f_nope', '幽灵店'), (e: any) => e.code === 'NOT_FOUND')
  assert.throws(() => createShop(db, owner.id, '   '), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => addItem(db, 'shop_nope', { name: 'x', price: 1 }), (e: any) => e.code === 'NOT_FOUND')
  assert.throws(() => addItem(db, shop.id, { name: '', price: 1 }), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => addItem(db, shop.id, { name: 'x', price: 0 }), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => addItem(db, shop.id, { name: 'x', price: -3 }), (e: any) => e.code === 'BAD_REQUEST')
  db.close()
})

// -------- 10. 购买数量参数校验 + 一条鱼没有店时 listShop 为 null --------
test('购买数量非法被拒；未开店的鱼 listShop 返回 null', () => {
  const db = openDb(':memory:')
  const owner = createFish(db, { name: '店主', balance: 0 })
  const buyer = createFish(db, { name: '买家', balance: 100 })
  const shop = createShop(db, owner.id, '数量店')
  const item = addItem(db, shop.id, { name: '鱼丸', price: 10, stock: 5 })

  assert.equal(listShop(db, buyer.id), null)

  assert.throws(() => buyItem(db, buyer.id, item.id, 0), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => buyItem(db, buyer.id, item.id, -1), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => buyItem(db, buyer.id, item.id, 1.5), (e: any) => e.code === 'BAD_REQUEST')
  assert.throws(() => buyItem(db, buyer.id, 'item_nope', 1), (e: any) => e.code === 'NOT_FOUND')

  assert.equal(listShop(db, owner.id)!.items[0].stock, 5)
  assert.equal(getFish(db, buyer.id)!.balance, 100)
  db.close()
})
