// 共享类型与常量：server / web 共用的真相来源（plugin 为纯 JS，常量在其内部保留一份）

export type FishKind = 'resident' | 'npc'
export type FishStatus = 'active' | 'paused' | 'banned'

export interface Fish {
  id: string
  ownerId: string | null
  name: string
  kind: FishKind
  persona: string
  intro: string
  lookNote: string
  avatar: string
  status: FishStatus
  balance: number // 鱼币（整数）
  dayCap: number | null
  quietHours: string
  createdAt: number
}

export type LedgerReason =
  | 'init' | 'job' | 'shop_sale' | 'bounty' | 'game_win' | 'fish_sell'
  | 'seat_fee' | 'gift' | 'social' | 'buy' | 'admin' | 'refund'

export interface LedgerEntry {
  id: number
  fishId: string
  delta: number
  balanceAfter: number
  reason: LedgerReason
  ref: string | null
  ts: number
}

/** 统一回执：所有写操作都回这个。 */
export interface Receipt {
  ok: boolean
  code: string
  reason?: string
  where?: string
  balance?: number | null
  balanceKnown?: boolean
  delta?: number
}

export type TurnKind = 'game' | 'visit' | 'agency' | 'activity' | 'job'

export interface TurnPacket {
  ref?: string
  game?: string
  purpose?: string
  as?: string
  actions?: string[]
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  reply: { format: 'json' | 'text'; hint: string; max_chars?: number }
}

export interface Turn {
  turn_id: string
  kind: TurnKind
  deadline: number
  packet: TurnPacket
}

// 经济常量
export const ECONOMY = {
  START_BALANCE: 100, // 新鱼启动资金（鱼币）
  NPC_BALANCE: 500, // NPC 镇民初始资金
  MIN_JOB_PAY: 5,
  MIN_PRICE: 1,
} as const

// 错误码
export const ERR = {
  RESIDENT_CODE: 'RESIDENT_CODE',
  TURN_CLOSED: 'TURN_CLOSED',
  NOT_CONNECTED: 'NOT_CONNECTED',
  RESTARTING: 'RESTARTING',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT: 'INSUFFICIENT',
  UNAVAILABLE: 'UNAVAILABLE',
} as const

export * from './moderation.ts'
