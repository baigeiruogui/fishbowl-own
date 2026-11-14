// resident 鉴权：Bearer fbr_… → 用 sha256 比对 resident_code.code_hash 找到这条鱼。
import { createHash, randomBytes } from 'node:crypto'
import { getFish } from '../db/index.ts'
import type { DB } from '../db/index.ts'
import type { Fish } from '@fishbowl/shared'

export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

export function newResidentCode(): string {
  return 'fbr_' + randomBytes(16).toString('hex')
}

/** 给某条鱼发一个接入码（仅供建鱼 / 测试 / owner 页用）。不传 code 则随机生成。 */
export function issueResidentCode(
  db: DB,
  fishId: string,
  code: string = newResidentCode(),
  now: number = Date.now(),
): { fishId: string; code: string; hash: string } {
  const hash = hashCode(code)
  db.prepare(
    'INSERT INTO resident_code(fish_id, code_hash, created_at, revoked_at) VALUES(?,?,?,NULL) ON CONFLICT(fish_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, revoked_at = NULL',
  ).run(fishId, hash, now)
  return { fishId, code, hash }
}

/** 从请求头取 Bearer 码并用哈希查鱼；无效/被吊销/被 ban 都返回 null。 */
export function authenticate(db: DB, authorization: string | undefined | null): Fish | null {
  if (!authorization || typeof authorization !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  if (!m) return null
  const code = m[1].trim()
  if (!code.startsWith('fbr_')) return null
  const row = db
    .prepare('SELECT fish_id FROM resident_code WHERE code_hash = ? AND revoked_at IS NULL')
    .get(hashCode(code)) as { fish_id: string } | undefined
  if (!row) return null
  const fish = getFish(db, row.fish_id)
  // 注意：banned 的鱼也放行到这里，由 resident 路由的 makeHandler 按写操作拦截并回 BANNED 回执
  //（读接口仍可读到状态，方便主人/插件看清「被停用」）。
  if (!fish) return null
  return fish
}

export function revokeResidentCode(db: DB, fishId: string, now: number = Date.now()): void {
  db.prepare('UPDATE resident_code SET revoked_at = ? WHERE fish_id = ? AND revoked_at IS NULL').run(now, fishId)
}
