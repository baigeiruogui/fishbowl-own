// 启动种子（幂等）：表空才写。默认招工 / 市场价 / NPC 镇民 / 示例店 / 悬赏。
// boot 时调用一次；重复调用不会重复写（按各表是否为空判断）。
import { createFish, newId, type DB } from './db/index.ts'
import { ECONOMY } from '@fishbowl/shared'
import { createJobOffer } from './domain/jobs.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { genSceneSvg } from './domain/media.ts'

export interface SeedOptions {
  startBalance?: number
  npcBalance?: number
  now?: number
}

export interface SeedSummary {
  jobs: number
  npcs: number
  marketPrices: number
  shops: number
  bounties: number
  gallery: number
}

/** 招工 10 条（含 pay + durationMin）。 */
const DEFAULT_JOBS = [
  { title: '码头帮工', place: '码头', pay: 20, durationMin: 30, slots: 3, requirements: '有力气、不晕船' },
  { title: '咖啡店店员', place: '咖啡店', pay: 15, durationMin: 60, slots: 2, requirements: '会笑、记得住熟客' },
  { title: '书店理货', place: '书店', pay: 12, durationMin: 45, slots: 1, requirements: '细心、爱书' },
  { title: '面包房帮厨', place: '面包房', pay: 18, durationMin: 60, slots: 2, requirements: '不怕烫、手脚快' },
  { title: '花店送花', place: '花店', pay: 14, durationMin: 30, slots: 1, requirements: '认得路' },
  { title: '夜市摆摊', place: '夜市', pay: 25, durationMin: 90, slots: 2, requirements: '会吆喝' },
  { title: '邮差送信', place: '邮局', pay: 16, durationMin: 40, slots: 2, requirements: '认路、准时' },
  { title: '图书馆整理', place: '图书馆', pay: 13, durationMin: 60, slots: 1, requirements: '安静、有条理' },
  { title: '鱼市叫卖', place: '鱼市', pay: 22, durationMin: 45, slots: 2, requirements: '嗓门亮' },
  { title: '修船坞帮手', place: '船坞', pay: 28, durationMin: 120, slots: 1, requirements: '会点木工' },
]

const DEFAULT_NPCS = [
  { name: '阿浪', persona: '码头老水手，嗓门大，爱讲古。' },
  { name: '小满', persona: '花店姑娘，温柔，喜欢一切开花的。' },
  { name: '老陈', persona: '书店老板，慢吞吞，记性极好。' },
  { name: '豆豆', persona: '面包房学徒，毛毛躁躁但很甜。' },
  { name: '青梅', persona: '咖啡店常客，写小说，观察力强。' },
  { name: '铁柱', persona: '夜市摊主，憨厚，讲义气。' },
]

/** 市场价表 6 种鱼获（鱼币/条）。 */
const DEFAULT_MARKET: Record<string, number> = { 小鱼: 5, 鲫鱼: 8, 鲤鱼: 12, 鲈鱼: 20, 龙虾: 40, 珍珠: 60 }

/** 2 家示例店（第 i 家挂到第 i 条 NPC 名下）。 */
const DEFAULT_SHOPS: { name: string; kind: string; items: { name: string; price: number; stock: number; desc: string }[] }[] = [
  {
    name: '浪花杂货铺',
    kind: 'general',
    items: [
      { name: '小鱼干', price: 8, stock: 20, desc: '香脆可口，镇民都爱。' },
      { name: '贝壳风铃', price: 30, stock: 5, desc: '海风一吹叮当作响。' },
      { name: '手绘明信片', price: 12, stock: 10, desc: '画的是小镇码头。' },
    ],
  },
  {
    name: '海风咖啡小卖部',
    kind: 'food',
    items: [
      { name: '手冲咖啡', price: 15, stock: 15, desc: '青梅最爱的苦咖啡。' },
      { name: '贝壳小蛋糕', price: 10, stock: 12, desc: '豆豆亲手烤的。' },
    ],
  },
]

/** 悬赏 4 条。 */
const DEFAULT_BOUNTIES = [
  { title: '找回走失的小海龟', desc: '在码头附近走丢的，找到有赏。', reward: 50 },
  { title: '帮忙写今日小镇日报', desc: '把今天镇上的新鲜事写成一页纸。', reward: 30 },
  { title: '修补码头旧渔网', desc: '西头那几张破网该补了。', reward: 40 },
  { title: '给灯塔换新灯泡', desc: '夜里灯塔有点暗，需要搭把手。', reward: 35 },
]

/** 画铺 gallery 的 3 张占位画（种子生成 SVG）。 */
const DEFAULT_GALLERY = [
  { title: '码头落日', scene: '夕阳把码头染成橘色，海面金光闪闪' },
  { title: '小镇夜色', scene: '夜色下的小镇灯火星星点点' },
  { title: '海风咖啡馆', scene: '海风穿过咖啡馆的窗，桌上放着一杯热咖啡' },
]

function tableEmpty(db: DB, table: string): boolean {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return Number(r.c) === 0
}

function metaGet(db: DB, k: string): string | null {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined
  return r ? r.v : null
}

/** 幂等种子：返回本次实际写入的数量（重复调用，第二次全为 0）。 */
export function seedTown(db: DB, opts: SeedOptions = {}): SeedSummary {
  const startBalance = opts.startBalance ?? ECONOMY.START_BALANCE
  const npcBalance = opts.npcBalance ?? ECONOMY.NPC_BALANCE
  const now = opts.now ?? Date.now()
  const out: SeedSummary = { jobs: 0, npcs: 0, marketPrices: 0, shops: 0, bounties: 0, gallery: 0 }

  // 1) NPC 镇民（先建，后面示例店用它当店主）
  if (!db.prepare(`SELECT 1 FROM fish WHERE kind = 'npc' LIMIT 1`).get()) {
    for (const n of DEFAULT_NPCS) {
      createFish(db, { name: n.name, kind: 'npc', persona: n.persona, balance: npcBalance })
      out.npcs++
    }
  }

  // 2) 招工（10 条）
  if (tableEmpty(db, 'job_offer')) {
    for (const j of DEFAULT_JOBS) {
      createJobOffer(db, { ...j, now })
      out.jobs++
    }
  }

  // 3) 市场价表（6 种鱼获，存 meta）
  if (!metaGet(db, 'market_prices')) {
    db.prepare('INSERT INTO meta(k, v) VALUES(?, ?)').run('market_prices', JSON.stringify(DEFAULT_MARKET))
    out.marketPrices = Object.keys(DEFAULT_MARKET).length
  }

  // 4) 2 家示例店 + 商品（店主依次取 NPC，没有则回落到任意一条鱼）
  if (tableEmpty(db, 'shop')) {
    const npcIds = (db.prepare(`SELECT id FROM fish WHERE kind = 'npc' ORDER BY created_at ASC`).all() as unknown as { id: string }[]).map(
      (r) => r.id,
    )
    const fallback = (db.prepare('SELECT id FROM fish LIMIT 1').get() as { id: string } | undefined)?.id ?? null
    for (let i = 0; i < DEFAULT_SHOPS.length; i++) {
      const def = DEFAULT_SHOPS[i]!
      const ownerId = npcIds[i % Math.max(1, npcIds.length)] ?? fallback
      if (!ownerId) break
      const shopId = newId('shop')
      db.prepare('INSERT INTO shop(id, owner_fish_id, name, kind, open, created_at) VALUES(?,?,?,?,1,?)').run(
        shopId,
        ownerId,
        def.name,
        def.kind,
        now,
      )
      for (const it of def.items) {
        db.prepare('INSERT INTO shop_item(id, shop_id, name, price, stock, desc) VALUES(?,?,?,?,?,?)').run(
          newId('item'),
          shopId,
          it.name,
          it.price,
          it.stock,
          it.desc,
        )
      }
      out.shops++
    }
  }

  // 5) 悬赏（4 条）
  if (tableEmpty(db, 'bounty')) {
    const poster = db.prepare(`SELECT id FROM fish WHERE kind = 'npc' LIMIT 1`).get() as { id: string } | undefined
    for (const b of DEFAULT_BOUNTIES) {
      db.prepare('INSERT INTO bounty(id, poster_fish_id, title, desc, reward, state, taker_fish_id, created_at, claimed_at) VALUES(?,?,?,?,?,?,NULL,?,NULL)').run(
        newId('bounty'),
        poster?.id ?? null,
        b.title,
        b.desc,
        b.reward,
        'open',
        now,
      )
      out.bounties++
    }
  }

  // 6) 画铺 gallery：2-3 张占位 SVG（写 gallery 表 + meta 标记，幂等）
  if (!metaGet(db, 'gallery_seeded')) {
    db.exec('CREATE TABLE IF NOT EXISTS gallery(id TEXT PRIMARY KEY, title TEXT, scene TEXT, path TEXT, created_at INTEGER)')
    const dir = resolve(process.env.ALBUM_DIR || 'data/album', 'gallery')
    mkdirSync(dir, { recursive: true })
    for (const g of DEFAULT_GALLERY) {
      const id = newId('gallery')
      const file = join(dir, id + '.svg')
      writeFileSync(file, genSceneSvg({ scene: g.scene, title: g.title, fishName: '画铺', ts: now }), 'utf8')
      db.prepare('INSERT INTO gallery(id, title, scene, path, created_at) VALUES(?,?,?,?,?)').run(id, g.title, g.scene, file, now)
      out.gallery++
    }
    db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('gallery_seeded', '1')
  }

  return out
}
