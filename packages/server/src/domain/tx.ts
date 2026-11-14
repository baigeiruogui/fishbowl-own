// 可嵌套的事务辅助：用 SAVEPOINT 实现（和 postLedger 同风格）。
// 与 db/index.ts 的 tx()（BEGIN IMMEDIATE）不同，withSavepoint 可在外层事务/保存点内嵌套调用，
// 不会抛 'cannot start a transaction within a transaction'。顶层调用也安全（SAVEPOINT 会自动提交）。
import type { DB } from '../db/index.ts'

let seq = 0

export function withSavepoint<T>(db: DB, fn: () => T, tag = 'sp'): T {
  const name = `${tag}_${++seq}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const r = fn()
    db.exec(`RELEASE ${name}`)
    return r
  } catch (e) {
    try {
      db.exec(`ROLLBACK TO ${name}`)
      db.exec(`RELEASE ${name}`)
    } catch {
      /* ignore */
    }
    throw e
  }
}
