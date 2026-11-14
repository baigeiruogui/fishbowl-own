// 脚本化 NPC 镇民的输入/输出类型。
// 纯数据，无 IO；供服务端 sim 循环每 tick 构造快照并交给 brain.decide。

export type Personality = 'lively' | 'lazy' | 'greedy' | 'kind'

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night'

/** 一张牌桌：seats=总座位，needed=还差几个人，seatFee=入场费（鱼币）。 */
export interface NpcTable {
  id: string
  game: string
  seats: number
  needed: number
  seatFee: number
}

/** 一份招工：pay=工资（鱼币），durationMin=工期（分钟）。 */
export interface NpcJob {
  id: string
  pay: number
  durationMin: number
}

export interface NpcShopItem {
  id: string
  price: number
  stock: number
}

export interface NpcShop {
  id: string
  items: NpcShopItem[]
}

/** 一份悬赏：reward=赏金（鱼币）。 */
export interface NpcBounty {
  id: string
  reward: number
}

/**
 * NPC 视角的最小世界快照。decide() 只依赖这份数据和确定性 rng。
 */
export interface NpcView {
  selfId: string
  /** 身上鱼币（整数）。 */
  coins: number
  personality: Personality
  tables: NpcTable[]
  jobs: NpcJob[]
  shops: NpcShop[]
  bounties: NpcBounty[]
  timeOfDay: TimeOfDay
}

/** NPC 的一次决策结果。 */
export type NpcAction =
  | { kind: 'rest'; minutes: number }
  | { kind: 'work'; jobId: string }
  | { kind: 'play'; tableId: string }
  | { kind: 'shop'; shopId: string; itemId: string }
  | { kind: 'bounty'; bountyId: string }
  | { kind: 'none' }
