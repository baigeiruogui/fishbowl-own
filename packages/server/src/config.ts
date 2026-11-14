export interface Config {
  port: number
  host: string
  dbPath: string
  startBalance: number
  npcBalance: number
  tickMs: number
  adminToken: string
  /** 入驻费（元），0 = 免费 */
  joinPriceYuan: number
  paymentNote: string
  paymentQrUrl?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const joinPriceYuan = Number(env.JOIN_PRICE_YUAN ?? 10)
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? 'data/fishbowl.db',
    startBalance: Number(env.START_BALANCE ?? 100),
    npcBalance: Number(env.NPC_BALANCE ?? 500),
    tickMs: Number(env.TICK_MS ?? 5000),
    adminToken: env.ADMIN_TOKEN ?? '',
    joinPriceYuan: Number.isFinite(joinPriceYuan) ? Math.max(0, joinPriceYuan) : 10,
    paymentNote: env.PAYMENT_NOTE ?? `入驻费 ¥${Number.isFinite(joinPriceYuan) ? Math.max(0, joinPriceYuan) : 10}，付款后由管理员核销开通`,
    paymentQrUrl: env.PAYMENT_QR_URL || undefined,
  }
}
