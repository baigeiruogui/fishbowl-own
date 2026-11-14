// 开店领域：开店 / 上货 / 改价改库存 / 浏览 / 购买。
// 铁律：所有金额变动走 postLedger（整数鱼币）；买商品在 tx 内校验库存与余额，
// 买家 -total('buy') + 店主 +total('shop_sale') + 扣库存 + 写 orders；不足则整体回滚。
import { getFish, newId, postLedger, tx } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { asDomainError, assertIntAmount, assertPositiveInt, DomainError } from './errors.ts'

export interface ShopItemView {
  id: string
  shopId: string
  name: string
  price: number
  stock: number
  desc: string
}

export interface ShopView {
  id: string
  ownerFishId: string
  name: string
  kind: string | null
  open: boolean
  createdAt: number
  /** 在售商品（含缺货的，stock 可能为 0） */
  items: ShopItemView[]
}

export interface BuyResult {
  orderId: string
  shopId: string
  itemId: string
  buyerFishId: string
  ownerFishId: string
  qty: number
  unitPrice: number
  /** 成交总额（= unitPrice * qty，整数鱼币） */
  total: number
  /** 买家付款后余额 */
  buyerBalance: number
  /** 店主收款后余额 */
  ownerBalance: number
  /** 剩余库存 */
  remainingStock: number
}

interface ShopRow {
  id: string
  owner_fish_id: string
  name: string
  kind: string | null
  open: number
  created_at: number
}

interface ItemRow {
  id: string
  shop_id: string
  name: string
  price: number
  stock: number
  desc: string
}

function toItemView(r: ItemRow): ShopItemView {
  return { id: r.id, shopId: r.shop_id, name: r.name, price: r.price, stock: r.stock, desc: r.desc }
}

function itemRows(db: DB, shopId: string): ItemRow[] {
  return db
    .prepare('SELECT * FROM shop_item WHERE shop_id = ? ORDER BY price ASC, id ASC')
    .all(shopId) as unknown as ItemRow[]
}

function toShopView(r: ShopRow, items: ShopItemView[]): ShopView {
  return {
    id: r.id,
    ownerFishId: r.owner_fish_id,
    name: r.name,
    kind: r.kind,
    open: r.open === 1,
    createdAt: r.created_at,
    items,
  }
}

/** 按 shopId 取店铺详情（含商品）。不存在返回 null。 */
export function getShop(db: DB, shopId: string): ShopView | null {
  const r = db.prepare('SELECT * FROM shop WHERE id = ?').get(shopId) as unknown as ShopRow | undefined
  if (!r) return null
  return toShopView(r, itemRows(db, r.id).map(toItemView))
}

/** 开店：一条鱼开一家店（默认营业中）。kind 可选（如 food / fish / misc）。 */
export function createShop(db: DB, fishId: string, name: string, kind: string | null = null): ShopView {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DomainError('BAD_REQUEST', 'shop name is required')
  }
  const fish = getFish(db, fishId)
  if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
  const id = newId('shop')
  const now = Date.now()
  db.prepare('INSERT INTO shop(id, owner_fish_id, name, kind, open, created_at) VALUES(?,?,?,?,1,?)').run(
    id,
    fishId,
    name.trim(),
    kind ?? null,
    now,
  )
  return getShop(db, id)!
}

/** 一条鱼自己开的店（取最早创建的那家）；没有返回 null。 */
export function listShop(db: DB, fishId: string): ShopView | null {
  const r = db
    .prepare('SELECT * FROM shop WHERE owner_fish_id = ? ORDER BY created_at ASC, id ASC LIMIT 1')
    .get(fishId) as unknown as ShopRow | undefined
  if (!r) return null
  return toShopView(r, itemRows(db, r.id).map(toItemView))
}

/** 所有营业中（open=1）的店铺（含商品），供逛街 / 公开列表用。 */
export function listOpenShops(db: DB): ShopView[] {
  const rows = db
    .prepare('SELECT * FROM shop WHERE open = 1 ORDER BY created_at ASC, id ASC')
    .all() as unknown as ShopRow[]
  return rows.map((r) => toShopView(r, itemRows(db, r.id).map(toItemView)))
}

export interface AddItemInput {
  name: string
  /** 单价（整数鱼币，>=1） */
  price: number
  /** 初始库存（非负整数，默认 0） */
  stock?: number
  desc?: string
}

/** 上货：往店里加一件商品。price 必须为正整数鱼币；stock 为非负整数。 */
export function addItem(db: DB, shopId: string, opts: AddItemInput): ShopItemView {
  const shop = db.prepare('SELECT id FROM shop WHERE id = ?').get(shopId) as { id: string } | undefined
  if (!shop) throw new DomainError('NOT_FOUND', `shop not found: ${shopId}`)
  if (typeof opts?.name !== 'string' || opts.name.trim() === '') {
    throw new DomainError('BAD_REQUEST', 'item name is required')
  }
  const price = assertPositiveInt(opts.price, 'price')
  const stock = opts.stock === undefined ? 0 : assertIntAmount(opts.stock, 'stock')
  const id = newId('item')
  db.prepare('INSERT INTO shop_item(id, shop_id, name, price, stock, desc) VALUES(?,?,?,?,?,?)').run(
    id,
    shopId,
    opts.name.trim(),
    price,
    stock,
    opts.desc ?? '',
  )
  return toItemView(db.prepare('SELECT * FROM shop_item WHERE id = ?').get(id) as unknown as ItemRow)
}

/** 改价：price 必须为正整数鱼币。 */
export function setItemPrice(db: DB, itemId: string, price: number): ShopItemView {
  const p = assertPositiveInt(price, 'price')
  const r = db.prepare('SELECT id FROM shop_item WHERE id = ?').get(itemId) as { id: string } | undefined
  if (!r) throw new DomainError('NOT_FOUND', `item not found: ${itemId}`)
  db.prepare('UPDATE shop_item SET price = ? WHERE id = ?').run(p, itemId)
  return toItemView(db.prepare('SELECT * FROM shop_item WHERE id = ?').get(itemId) as unknown as ItemRow)
}

/** 改库存：stock 必须为非负整数。 */
export function setStock(db: DB, itemId: string, stock: number): ShopItemView {
  const s = assertIntAmount(stock, 'stock')
  const r = db.prepare('SELECT id FROM shop_item WHERE id = ?').get(itemId) as { id: string } | undefined
  if (!r) throw new DomainError('NOT_FOUND', `item not found: ${itemId}`)
  db.prepare('UPDATE shop_item SET stock = ? WHERE id = ?').run(s, itemId)
  return toItemView(db.prepare('SELECT * FROM shop_item WHERE id = ?').get(itemId) as unknown as ItemRow)
}

interface BuyItemRow extends ItemRow {
  owner_fish_id: string
  shop_open: number
}

/**
 * 购买商品：tx 内校验（店在营业 / 非自购 / 库存充足 / 余额充足），
 * 买家 postLedger(-total,'buy')、店主 postLedger(+total,'shop_sale')、扣库存、写 orders。
 * 任何校验失败（含余额不足）都抛 DomainError 且事务整体回滚，无副作用。
 */
export function buyItem(db: DB, buyerFishId: string, itemId: string, qty: number = 1, now: number = Date.now()): BuyResult {
  const n = assertPositiveInt(qty, 'qty')
  return tx(db, () => {
    const buyer = getFish(db, buyerFishId)
    if (!buyer) throw new DomainError('NOT_FOUND', `fish not found: ${buyerFishId}`)

    const row = db
      .prepare(
        `SELECT i.id AS id, i.shop_id AS shop_id, i.name AS name, i.price AS price, i.stock AS stock,
                i.desc AS desc, s.owner_fish_id AS owner_fish_id, s.open AS shop_open
         FROM shop_item i JOIN shop s ON s.id = i.shop_id WHERE i.id = ?`,
      )
      .get(itemId) as unknown as BuyItemRow | undefined
    if (!row) throw new DomainError('NOT_FOUND', `item not found: ${itemId}`)
    if (row.shop_open !== 1) throw new DomainError('CONFLICT', `shop ${row.shop_id} is closed`)
    if (row.owner_fish_id === buyerFishId) {
      throw new DomainError('BAD_REQUEST', `owner cannot buy own item: ${itemId}`)
    }
    if (row.stock < n) {
      throw new DomainError('CONFLICT', `insufficient stock for item ${itemId}: want ${n}, have ${row.stock}`, {
        detail: { itemId, want: n, stock: row.stock },
      })
    }

    const unitPrice = row.price
    const total = unitPrice * n
    if (!Number.isInteger(total) || total <= 0) {
      throw new DomainError('BAD_REQUEST', `invalid order total ${total}`)
    }

    // 原子扣库存（并发保护）；若已被并发买空则冲突。事务回滚会还原。
    const dec = db
      .prepare('UPDATE shop_item SET stock = stock - ? WHERE id = ? AND stock >= ?')
      .run(n, itemId, n)
    if (Number(dec.changes) === 0) {
      throw new DomainError('CONFLICT', `insufficient stock for item ${itemId}`)
    }

    const orderId = newId('order')
    let buyerBalance: number
    let ownerBalance: number
    try {
      buyerBalance = postLedger(db, buyerFishId, -total, 'buy', orderId).balance
      ownerBalance = postLedger(db, row.owner_fish_id, total, 'shop_sale', orderId).balance
    } catch (e) {
      throw asDomainError(e) // 保留 INSUFFICIENT / NOT_FOUND
    }

    db.prepare(
      'INSERT INTO orders(id, buyer_fish_id, shop_id, item_id, qty, total, ts) VALUES(?,?,?,?,?,?,?)',
    ).run(orderId, buyerFishId, row.shop_id, itemId, n, total, now)

    return {
      orderId,
      shopId: row.shop_id,
      itemId,
      buyerFishId,
      ownerFishId: row.owner_fish_id,
      qty: n,
      unitPrice,
      total,
      buyerBalance,
      ownerBalance,
      remainingStock: row.stock - n,
    }
  })
}
