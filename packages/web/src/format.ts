import type { LedgerReason } from './types.ts'

export interface ReasonMeta {
  label: string
  icon: string
  /** 该 reason 默认属于赚钱还是花钱；admin/未知按 delta 符号判定。 */
  kind: 'earn' | 'spend'
}

const REASON_META: Record<string, ReasonMeta> = {
  init: { label: '启动资金', icon: '🌱', kind: 'earn' },
  job: { label: '打工工资', icon: '💼', kind: 'earn' },
  shop_sale: { label: '店铺收入', icon: '🏪', kind: 'earn' },
  bounty: { label: '悬赏赏金', icon: '🎯', kind: 'earn' },
  game_win: { label: '游戏赢钱', icon: '🃏', kind: 'earn' },
  fish_sell: { label: '卖鱼获', icon: '🐟', kind: 'earn' },
  refund: { label: '退款', icon: '↩️', kind: 'earn' },
  seat_fee: { label: '座位费', icon: '🪑', kind: 'spend' },
  gift: { label: '送礼', icon: '🎁', kind: 'spend' },
  social: { label: '社交消费', icon: '💬', kind: 'spend' },
  buy: { label: '购物', icon: '🛒', kind: 'spend' },
  admin: { label: '管理调整', icon: '🛠️', kind: 'earn' },
}

/** 取 reason 的展示元信息；未知 reason 按 delta 正负还原「赚/花」。 */
export function reasonMeta(reason: LedgerReason | string, delta = 0): ReasonMeta {
  const meta = REASON_META[reason]
  if (meta) return meta
  return delta < 0
    ? { label: String(reason), icon: '💸', kind: 'spend' }
    : { label: String(reason), icon: '💰', kind: 'earn' }
}

/** 正数加 + 号，用于 delta 展示。 */
export function fmtDelta(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`
}

export function fmtCoins(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n)
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；更早显示日期。 */
export function relTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return formatDate(ts)
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 绝对时间：MM-DD HH:mm（跨年补 YYYY-）。 */
export function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`
}

export function fmtDateTime(ts: number): string {
  return formatDate(ts)
}

/** 本地自然日 0 点，与 server account.startOfLocalDay 对齐。 */
export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** avatar 可能是 emoji 文本，也可能是图片 URL / 站内路径。
 *  安全约束：只允许同源 URL（含相对路径 /xxx）作为 <img> 源，禁止任意外链图片。 */
export function isImageAvatar(avatar: string): boolean {
  const v = avatar.trim()
  if (!v) return false
  if (v.startsWith('/')) return true
  try {
    const u = new URL(v)
    return u.origin === window.location.origin
  } catch {
    return false
  }
}

/** 相册/画铺图片源：允许 data:image/*、相对路径、同源 URL；禁止任意外链。 */
export function isSafeImageSrc(src: string | undefined | null): src is string {
  if (!src) return false
  const v = src.trim()
  if (!v) return false
  if (/^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(v)) return true
  if (v.startsWith('/')) return true
  try {
    const u = new URL(v)
    return u.origin === window.location.origin
  } catch {
    return false
  }
}
