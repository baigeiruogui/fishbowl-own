// 钓鱼卖钱领域：码头产出鱼获进 catch 表 → 按市场价卖出 → postLedger(+amount, 'fish_sell')。
import { getFish, newId, postLedger } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import { asDomainError, assertPositiveInt, DomainError } from './errors.ts'
import { withSavepoint } from './tx.ts'

/** 市场基准价（鱼币/条）。未列出的鱼获按 DEFAULT_MARKET_PRICE 计价。 */
export const MARKET_PRICES: Record<string, number> = {
  小鱼: 5,
  鲫鱼: 8,
  鲤鱼: 12,
  草鱼: 15,
  鲈鱼: 20,
  黄鱼: 25,
  大青鱼: 30,
  龙虾: 40,
  螃蟹: 45,
  珍珠: 60,
}

export const DEFAULT_MARKET_PRICE = 5

/** 按物品名取市场价（整数鱼币）。 */
export function marketPrice(item: string): number {
  const p = MARKET_PRICES[item]
  return Number.isInteger(p) && p > 0 ? p : DEFAULT_MARKET_PRICE
}

interface CatchRow {
  id: string
  fish_id: string
  item: string
  qty: number
  ts: number
}

export interface CatchView {
  id: string
  fishId: string
  item: string
  qty: number
  ts: number
}

export interface Holding {
  item: string
  qty: number
  price: number
}

export interface MarketItem {
  item: string
  price: number
  /** 这条鱼手上持有的数量 */
  owned: number
}

function toCatchView(r: CatchRow): CatchView {
  return { id: r.id, fishId: r.fish_id, item: r.item, qty: r.qty, ts: r.ts }
}

/** 码头钓鱼产出：写入一条 catch 记录（item 鱼获名，qty 数量，正整数）。 */
export function addCatch(db: DB, fishId: string, item: string, qty: number = 1, now: number = Date.now()): CatchView {
  if (!item || typeof item !== 'string') throw new DomainError('BAD_REQUEST', 'item is required')
  const n = assertPositiveInt(qty, 'qty')
  const fish = getFish(db, fishId)
  if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)
  const id = newId('catch')
  db.prepare('INSERT INTO catch(id, fish_id, item, qty, ts) VALUES(?,?,?,?,?)').run(id, fishId, item, n, now)
  const row = db.prepare('SELECT * FROM catch WHERE id = ?').get(id) as unknown as CatchRow
  return toCatchView(row)
}

/** 一条鱼的全部鱼获（按物品聚合）。 */
export function listCatch(db: DB, fishId: string): Holding[] {
  const rows = db
    .prepare('SELECT item, SUM(qty) AS qty FROM catch WHERE fish_id = ? GROUP BY item HAVING SUM(qty) > 0 ORDER BY item')
    .all(fishId) as unknown as { item: string; qty: number }[]
  return rows.map((r) => ({ item: r.item, qty: Number(r.qty), price: marketPrice(r.item) }))
}

/** 市场行情：已知市场物品 + 她持有的物品，带市场价与持有量。 */
export function getMarket(db: DB, fishId: string): MarketItem[] {
  const held = new Map(listCatch(db, fishId).map((h) => [h.item, h.qty]))
  const items = new Set<string>(Object.keys(MARKET_PRICES))
  for (const k of held.keys()) items.add(k)
  return [...items]
    .map((item) => ({ item, price: marketPrice(item), owned: held.get(item) ?? 0 }))
    .sort((a, b) => a.price - b.price || a.item.localeCompare(b.item))
}

export interface SellRequest {
  /** 指定某一条 catch 记录（可部分卖该条记录的数量） */
  catchId?: string
  /** 或按物品卖（FIFO 消耗该鱼的所有同名鱼获） */
  item?: string
  /** 卖出数量；不填 = 该记录 / 该物品全部 */
  qty?: number
}

export interface SellResult {
  item: string
  qty: number
  price: number
  /** 本次卖出所得鱼币（= price * qty） */
  amount: number
  /** 卖出后余额 */
  balance: number
  /** 关联的 catch id（按物品散卖时为 null） */
  ref: string | null
}

/**
 * 卖鱼获换钱：从 catch 扣减对应数量，并 postLedger(+amount, 'fish_sell')。
 * 支持按 catchId 单条卖（可部分）或按 item 聚合卖（FIFO）。整段在一个事务内。
 */
export function sellCatch(db: DB, fishId: string, req: SellRequest): SellResult {
  return withSavepoint(db, () => {
    const fish = getFish(db, fishId)
    if (!fish) throw new DomainError('NOT_FOUND', `fish not found: ${fishId}`)

    if (req.catchId) {
      const row = db.prepare('SELECT * FROM catch WHERE id = ?').get(req.catchId) as unknown as CatchRow | undefined
      if (!row || row.fish_id !== fishId) throw new DomainError('NOT_FOUND', `catch not found: ${req.catchId}`)
      const qty = req.qty === undefined ? row.qty : assertPositiveInt(req.qty, 'qty')
      if (qty > row.qty) throw new DomainError('BAD_REQUEST', `qty ${qty} exceeds available ${row.qty}`)
      if (qty === row.qty) db.prepare('DELETE FROM catch WHERE id = ?').run(row.id)
      else db.prepare('UPDATE catch SET qty = qty - ? WHERE id = ?').run(qty, row.id)
      return settleSale(db, fishId, row.item, qty, row.id)
    }

    if (!req.item) throw new DomainError('BAD_REQUEST', 'either catchId or item is required')
    const rows = db
      .prepare('SELECT * FROM catch WHERE fish_id = ? AND item = ? AND qty > 0 ORDER BY ts ASC, id ASC')
      .all(fishId, req.item) as unknown as CatchRow[]
    const total = rows.reduce((s, r) => s + r.qty, 0)
    if (total <= 0) throw new DomainError('NOT_FOUND', `no catch of item ${req.item} for fish ${fishId}`)
    const qty = req.qty === undefined ? total : assertPositiveInt(req.qty, 'qty')
    if (qty > total) throw new DomainError('BAD_REQUEST', `qty ${qty} exceeds available ${total}`)

    // FIFO 扣减
    let left = qty
    const del = db.prepare('DELETE FROM catch WHERE id = ?')
    const upd = db.prepare('UPDATE catch SET qty = qty - ? WHERE id = ?')
    for (const r of rows) {
      if (left <= 0) break
      const take = Math.min(left, r.qty)
      if (take === r.qty) del.run(r.id)
      else upd.run(take, r.id)
      left -= take
    }
    return settleSale(db, fishId, req.item, qty, null)
  }, 'sell')
}

function settleSale(db: DB, fishId: string, item: string, qty: number, ref: string | null): SellResult {
  const price = marketPrice(item)
  const amount = price * qty
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DomainError('BAD_REQUEST', `invalid sale amount ${amount}`)
  }
  let balance: number
  try {
    balance = postLedger(db, fishId, amount, 'fish_sell', ref ?? item).balance
  } catch (e) {
    throw asDomainError(e)
  }
  return { item, qty, price, amount, balance, ref }
}

/** 一次性卖出该鱼所有鱼获：整体放在一个事务（保存点）里，任一失败全部回滚。 */
export function sellAllCatch(db: DB, fishId: string): SellResult[] {
  return withSavepoint(db, () => {
    const holdings = listCatch(db, fishId).filter((h) => h.qty > 0)
    const out: SellResult[] = []
    for (const h of holdings) {
      out.push(sellCatch(db, fishId, { item: h.item }))
    }
    return out
  }, 'sellAll')
}
