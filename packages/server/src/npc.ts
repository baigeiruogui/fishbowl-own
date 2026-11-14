// 极简 NPC 镇民策略：制造经济对手盘（接活 / 买货 / 接悬赏）。零模型成本、确定性。
// 复杂策略等 packages/npc 就绪后再接；这里不强依赖它。
import { newId, postLedger, tx } from './db/index.ts'
import type { DB } from './db/index.ts'
import { takeJob } from './domain/jobs.ts'

export interface NpcTickResult {
  tookJob: number
  bought: number
  tookBounty: number
}

/** 一拍 NPC 行为。幂等性由业务自然约束（在岗就不再接活、库存/余额不足就不买）。 */
export function npcTick(db: DB, now: number = Date.now()): NpcTickResult {
  const out: NpcTickResult = { tookJob: 0, bought: 0, tookBounty: 0 }
  const npcs = db
    .prepare(`SELECT id, balance FROM fish WHERE kind = 'npc' AND status = 'active' ORDER BY created_at ASC`)
    .all() as unknown as { id: string; balance: number }[]
  if (npcs.length === 0) return out

  // 1) 空闲的 NPC 去接一份还缺人的活
  const offers = db
    .prepare(`SELECT * FROM job_offer WHERE active = 1 ORDER BY created_at ASC`)
    .all() as unknown as { id: string; slots: number }[]
  for (const npc of npcs) {
    const busy = db.prepare(`SELECT 1 FROM job_contract WHERE fish_id = ? AND state = 'working' LIMIT 1`).get(npc.id)
    if (busy) continue
    for (const offer of offers) {
      const taken = (db.prepare(`SELECT COUNT(*) AS c FROM job_contract WHERE offer_id = ? AND state = 'working'`).get(offer.id) as { c: number }).c
      if (Number(taken) >= Number(offer.slots)) continue
      try {
        takeJob(db, npc.id, offer.id, now)
        out.tookJob++
        break
      } catch {
        /* 抢不到就换下一个 */
      }
    }
  }

  // 2) 每拍最多一位 NPC 买一件店里的货（余额够才买）
  const items = db
    .prepare(`SELECT si.id, si.shop_id, si.name, si.price, si.stock FROM shop_item si JOIN shop s ON s.id = si.shop_id WHERE s.open = 1 AND si.stock > 0 ORDER BY si.price ASC`)
    .all() as unknown as { id: string; shop_id: string; name: string; price: number; stock: number }[]
  for (const npc of npcs) {
    const item = items.find((it) => Number(it.price) <= Math.max(0, Number(npc.balance) - 50) && Number(it.stock) > 0)
    if (!item) continue
    try {
      tx(db, () => {
        postLedger(db, npc.id, -Number(item.price), 'buy', item.id)
        db.prepare('UPDATE shop_item SET stock = stock - 1 WHERE id = ? AND stock > 0').run(item.id)
        db.prepare('INSERT INTO orders(id, buyer_fish_id, shop_id, item_id, qty, total, ts) VALUES(?,?,?,?,1,?,?)').run(
          newId('order'),
          npc.id,
          item.shop_id,
          item.id,
          Number(item.price),
          now,
        )
      })
      out.bought++
      break
    } catch {
      /* 余额不足等，跳过 */
    }
  }

  // 3) 每拍最多接一张还开着的悬赏
  const bounty = db.prepare(`SELECT id FROM bounty WHERE state = 'open' AND taker_fish_id IS NULL ORDER BY created_at ASC LIMIT 1`).get() as
    | { id: string }
    | undefined
  if (bounty) {
    const taker = npcs[0]
    if (taker) {
      db.prepare(`UPDATE bounty SET state = 'taken', taker_fish_id = ?, claimed_at = ? WHERE id = ? AND state = 'open'`).run(
        taker.id,
        now,
        bounty.id,
      )
      out.tookBounty++
    }
  }

  return out
}
