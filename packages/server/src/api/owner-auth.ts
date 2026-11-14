// 多主人账号：owner_credential(owner_id, token_hash) + 注册/解析辅助。
// 明文 ownerToken 只在注册时回一次，库里只存 sha256。
import { randomBytes } from 'node:crypto'
import { newId, type DB } from '../db/index.ts'
import { hashCode } from './auth.ts'

export interface OwnerIdentity {
  ownerId: string
  name: string
}

/** 幂等确保 owner / owner_credential 表存在（兼容旧库，不依赖 schema 迁移）。 */
export function ensureOwnerTables(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS owner(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT, created_at INTEGER NOT NULL);`)
  db.exec(`CREATE TABLE IF NOT EXISTS owner_credential(
    owner_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);`)
  // 旧库迁移：补 revoked_at 列
  const cols = db.prepare('PRAGMA table_info(owner_credential)').all() as unknown as { name: string }[]
  if (!cols.some((c) => c.name === 'revoked_at')) {
    db.exec('ALTER TABLE owner_credential ADD COLUMN revoked_at INTEGER')
  }
}

export function newOwnerToken(): string {
  return 'own_' + randomBytes(16).toString('hex')
}

export interface RegisterOwnerResult {
  ownerId: string
  ownerToken: string
  name: string
}

/** 注册主人账号：写 owner 行 + owner_credential（只存 sha256），返回明文 token（仅此一次）。 */
export function registerOwner(db: DB, input: { name?: string } = {}, now: number = Date.now()): RegisterOwnerResult {
  ensureOwnerTables(db)
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '主人'
  const ownerId = newId('owner')
  const token = newOwnerToken()
  db.prepare('INSERT INTO owner(id, name, contact, created_at) VALUES(?,?,?,?)').run(ownerId, name, null, now)
  db.prepare('INSERT INTO owner_credential(owner_id, token_hash, created_at) VALUES(?,?,?)').run(ownerId, hashCode(token), now)
  return { ownerId, ownerToken: token, name }
}

function bearer(req: { headers?: Record<string, unknown> }): string | null {
  const auth = req.headers?.authorization
  if (typeof auth !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  return m ? m[1].trim() : null
}

/** 从 Authorization Bearer 的 ownerToken 解析主人；无效返回 null。 */
export function resolveOwnerToken(db: DB, req: { headers?: Record<string, unknown> }): OwnerIdentity | null {
  const token = bearer(req)
  if (!token || !token.startsWith('own_')) return null
  ensureOwnerTables(db)
  const row = db
    .prepare('SELECT o.id AS id, o.name AS name FROM owner_credential c JOIN owner o ON o.id = c.owner_id WHERE c.token_hash = ? AND c.revoked_at IS NULL')
    .get(hashCode(token)) as { id: string; name: string } | undefined
  return row ? { ownerId: row.id, name: row.name } : null
}

/** 轮换 ownerToken：生成新 token，覆盖哈希并清除撤销标记（旧 token 立即失效）。返回新明文 token。 */
export function rotateOwnerToken(db: DB, ownerId: string, now: number = Date.now()): string {
  ensureOwnerTables(db)
  const token = newOwnerToken()
  const r = db
    .prepare('UPDATE owner_credential SET token_hash = ?, revoked_at = NULL, created_at = ? WHERE owner_id = ?')
    .run(hashCode(token), now, ownerId)
  if (Number(r.changes) === 0) throw new Error(`owner credential not found: ${ownerId}`)
  return token
}

/** 撤销 ownerToken：置 revoked_at（该主人所有 token 立即失效）。 */
export function revokeOwnerToken(db: DB, ownerId: string, now: number = Date.now()): void {
  ensureOwnerTables(db)
  db.prepare('UPDATE owner_credential SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL').run(now, ownerId)
}

/** 某主人当前拥有的鱼数。 */
export function countOwnerFish(db: DB, ownerId: string): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM fish WHERE owner_id = ?').get(ownerId) as { c: number }
  return Number(r.c)
}
