// NPC 模拟步进：用 packages/npc 的 decide 为每条 NPC 鱼生成决策，并落到真实经济动作。
// 纯新增；不改 index.ts（由 server-dev 注册 tick）。所有捕获异常只记数不崩。
// 动作映射：
//   work  → takeJob（接活，到期由 engine tick 结算发工资）
//   play  → driver.seat（入座，扣座位费；坐满自动开局）
//   shop  → domain.shop.buyItem（买货，店主进账记 shop_sale）
//   bounty→ domain.bounty.takeBounty（接悬赏）
//   rest / none → 不产生经济动作
import { type DB } from '../db/index.ts'
import { decide, makeRng } from '../../../npc/src/index.ts'
import type { NpcBounty, NpcJob, NpcShop, NpcTable, NpcView, Personality, TimeOfDay } from '../../../npc/src/index.ts'
import { takeJob } from '../domain/jobs.ts'
import { takeBounty } from '../domain/bounty.ts'
import { buyItem } from '../domain/shop.ts'
import type { GameTable } from '../games/store.ts'

/** npcStep 需要的驱动能力（GameDriver 天然满足）。 */
export interface NpcDriver {
  listTables(): GameTable[]
  seat(tableId: string, fishId: string): { ok: boolean; error?: string }
}

export interface NpcStepOptions {
  /** 确定性随机源；不填则按 now 派生一个。 */
  rng?: () => number
  now?: number
  /** 覆盖指定 NPC 的性格（测试用），键=fishId。 */
  personalities?: Record<string, Personality>
}

export interface NpcStepResult {
  /** 参与决策的 NPC 数量 */
  steps: number
  rest: number
  work: number
  play: number
  shop: number
  bounty: number
  none: number
  /** 决策/执行过程中被吞掉的异常数 */
  errors: number
  actions: { fishId: string; kind: string; ref?: string }[]
}

const PERSONALITIES: Personality[] = ['lively', 'lazy', 'greedy', 'kind']

function personalityOf(fishId: string): Personality {
  let h = 0
  for (const ch of fishId) h = (h + ch.charCodeAt(0)) % 997
  return PERSONALITIES[h % PERSONALITIES.length]!
}

function timeOfDayOf(nowMs: number): TimeOfDay {
  const h = new Date(nowMs).getHours()
  if (h < 5) return 'night'
  if (h < 11) return 'morning'
  if (h < 17) return 'afternoon'
  if (h < 22) return 'evening'
  return 'night'
}

/** 读世界快照里 NPC 可见的牌桌 / 招工 / 店铺 / 悬赏。 */
function buildWorld(db: DB, driver: NpcDriver) {
  const tables: NpcTable[] = driver
    .listTables()
    .filter((t) => t.status === 'waiting' && t.players.length < t.seats)
    .map((t) => ({ id: t.id, game: t.game, seats: t.seats, needed: t.seats - t.players.length, seatFee: t.seatFee }))

  const jobs: NpcJob[] = (
    db
      .prepare(
        `SELECT o.id AS id, o.pay AS pay, o.duration_min AS duration_min, o.slots AS slots,
                (SELECT COUNT(*) FROM job_contract c WHERE c.offer_id = o.id AND c.state = 'working') AS taken
         FROM job_offer o WHERE o.active = 1 ORDER BY o.pay DESC`,
      )
      .all() as unknown as { id: string; pay: number; duration_min: number; slots: number; taken: number }[]
  )
    .filter((o) => Number(o.taken) < Number(o.slots))
    .map((o) => ({ id: o.id, pay: Number(o.pay), durationMin: Number(o.duration_min) }))

  const shopRows = db
    .prepare(
      `SELECT s.id AS shop_id, si.id AS item_id, si.price AS price, si.stock AS stock
       FROM shop s JOIN shop_item si ON si.shop_id = s.id
       WHERE s.open = 1 AND si.stock > 0 ORDER BY si.price ASC`,
    )
    .all() as unknown as { shop_id: string; item_id: string; price: number; stock: number }[]
  const shopMap = new Map<string, NpcShop>()
  for (const r of shopRows) {
    const shop = shopMap.get(r.shop_id) ?? { id: r.shop_id, items: [] as NpcShop['items'] }
    shop.items.push({ id: r.item_id, price: Number(r.price), stock: Number(r.stock) })
    shopMap.set(r.shop_id, shop)
  }
  const shops: NpcShop[] = [...shopMap.values()]

  const bounties: NpcBounty[] = (
    db.prepare(`SELECT id, reward FROM bounty WHERE state = 'open' ORDER BY reward DESC`).all() as unknown as {
      id: string
      reward: number
    }[]
  ).map((b) => ({ id: b.id, reward: Number(b.reward) }))

  return { tables, jobs, shops, bounties }
}

/**
 * 一拍 NPC 决策 + 执行。空世界（无 NPC / 无任何可做之事）不抛异常。
 * 每个 NPC 最多执行一个动作；单条执行失败只计入 errors，不影响其它 NPC。
 */
export function npcStep(db: DB, driver: NpcDriver, opts: NpcStepOptions = {}): NpcStepResult {
  const now = opts.now ?? Date.now()
  const rng = opts.rng ?? makeRng((now % 2147483647) || 1)
  const res: NpcStepResult = { steps: 0, rest: 0, work: 0, play: 0, shop: 0, bounty: 0, none: 0, errors: 0, actions: [] }

  const npcs = db
    .prepare(`SELECT id, balance FROM fish WHERE kind = 'npc' AND status = 'active' ORDER BY created_at ASC`)
    .all() as unknown as { id: string; balance: number }[]
  if (npcs.length === 0) return res

  const world = buildWorld(db, driver)
  const timeOfDay = timeOfDayOf(now)

  for (const npc of npcs) {
    res.steps++
    const view: NpcView = {
      selfId: npc.id,
      coins: Number(npc.balance),
      personality: opts.personalities?.[npc.id] ?? personalityOf(npc.id),
      tables: world.tables,
      jobs: world.jobs,
      shops: world.shops,
      bounties: world.bounties,
      timeOfDay,
    }

    let action
    try {
      action = decide(view, rng)
    } catch {
      res.errors++
      res.none++
      continue
    }

    try {
      switch (action.kind) {
        case 'rest':
          res.rest++
          break
        case 'work':
          takeJob(db, npc.id, action.jobId, now)
          res.work++
          res.actions.push({ fishId: npc.id, kind: 'work', ref: action.jobId })
          break
        case 'play': {
          const r = driver.seat(action.tableId, npc.id)
          if (r.ok) {
            res.play++
            res.actions.push({ fishId: npc.id, kind: 'play', ref: action.tableId })
          } else {
            res.errors++
            res.none++
          }
          break
        }
        case 'shop':
          buyItem(db, npc.id, action.itemId, 1, now)
          res.shop++
          res.actions.push({ fishId: npc.id, kind: 'shop', ref: action.itemId })
          break
        case 'bounty':
          takeBounty(db, action.bountyId, npc.id)
          res.bounty++
          res.actions.push({ fishId: npc.id, kind: 'bounty', ref: action.bountyId })
          break
        default:
          res.none++
          break
      }
    } catch {
      // 余额不足 / 无库存 / 名额已满 / 已是店主等：吞掉，不崩
      res.errors++
    }
  }

  return res
}
