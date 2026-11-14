// 日报生成：从当天 ledger / orders / bounty / game_session 汇总生成小镇日报行，写 paper 表。
// 纯新增、无外部依赖；幂等：当天已有日报行则不再重复写入（返回相同 items，written=0）。
import type { DB } from '../db/index.ts'
import { startOfLocalDay } from '../domain/account.ts'

export interface PaperItem {
  id: string
  ts: number
  kind: string
  title: string
  summary: string
  fishId?: string
}

export interface DailyPaperResult {
  date: string
  items: PaperItem[]
  /** 本次实际写入 paper 表的行数（幂等，重复调用为 0） */
  written: number
}

function ymd(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

interface FishDeltaRow {
  fish_id: string
  name: string
  s: number
}

/**
 * 生成当日日报。统计口径：
 *  - games：今天开过的对局数（game_session.created_at 在当天）
 *  - money：今天净赚最多 / 净亏最多的鱼（ledger.delta 汇总，排除 init）
 *  - shop：今天店铺成交单数与成交额（orders.total）
 *  - bounty：今天完成的悬赏数（bounty.claimed_at 在当天）
 * 返回 items（即使数据为空也会给出 0 值行），并写入 paper 表（headline/body）。
 */
export function generateDailyPaper(db: DB, now: number = Date.now()): DailyPaperResult {
  const dayStart = startOfLocalDay(now)

  // 1) 今天开过的对局
  const gamesRow = db
    .prepare('SELECT COUNT(*) AS c FROM game_session WHERE created_at >= ?')
    .get(dayStart) as { c: number }
  const games = Number(gamesRow.c)

  // 2) 谁赚谁赔（当天 ledger 净额，排除 init）
  const deltaRows = db
    .prepare(
      `SELECT l.fish_id AS fish_id, f.name AS name, COALESCE(SUM(l.delta), 0) AS s
       FROM ledger l JOIN fish f ON f.id = l.fish_id
       WHERE l.ts >= ? AND l.reason <> 'init'
       GROUP BY l.fish_id ORDER BY s DESC`,
    )
    .all(dayStart) as unknown as FishDeltaRow[]
  const gainer = deltaRows.find((r) => Number(r.s) > 0)
  const loser = [...deltaRows].reverse().find((r) => Number(r.s) < 0)

  // 3) 店铺成交
  const orderRow = db
    .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS s FROM orders WHERE ts >= ?')
    .get(dayStart) as { c: number; s: number }
  const orders = Number(orderRow.c)
  const revenue = Number(orderRow.s)

  // 4) 悬赏完成
  const bountyRow = db
    .prepare(`SELECT COUNT(*) AS c FROM bounty WHERE state = 'done' AND claimed_at IS NOT NULL AND claimed_at >= ?`)
    .get(dayStart) as { c: number }
  const bounties = Number(bountyRow.c)

  const items: PaperItem[] = [
    {
      id: 'gen_games',
      ts: now,
      kind: 'games',
      title: `今日共 ${games} 局对局`,
      summary: games > 0 ? `小镇牌桌上又热闹了一天，共开了 ${games} 局。` : '今天还没有人开桌。',
    },
    {
      id: 'gen_money',
      ts: now,
      kind: 'money',
      title: gainer ? `今日最大赢家：${gainer.name} +${Number(gainer.s)}` : '今日没人赚钱',
      summary: loser ? `最大输家：${loser.name} ${Number(loser.s)}` : '今天大家都保住了钱包。',
      fishId: gainer?.fish_id,
    },
    {
      id: 'gen_shop',
      ts: now,
      kind: 'shop',
      title: `店铺成交 ${orders} 单`,
      summary: `今日店铺总计成交 ${revenue} 鱼币。`,
    },
    {
      id: 'gen_bounty',
      ts: now,
      kind: 'bounty',
      title: `悬赏完成 ${bounties} 个`,
      summary: bounties > 0 ? `有 ${bounties} 个悬赏被顺利交接。` : '今天的悬赏还挂在墙上等勇者。',
    },
  ]

  // 幂等：当天已有日报行则跳过写入
  const existing = db.prepare('SELECT COUNT(*) AS c FROM paper WHERE ts >= ?').get(dayStart) as { c: number }
  let written = 0
  if (Number(existing.c) === 0) {
    const ins = db.prepare('INSERT INTO paper(ts, headline, body) VALUES(?,?,?)')
    for (const it of items) {
      ins.run(it.ts, it.title, it.summary)
      written++
    }
  }

  return { date: ymd(now), items, written }
}
