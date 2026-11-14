export interface Config {
  port: number
  host: string
  dbPath: string
  startBalance: number
  npcBalance: number
  tickMs: number
  adminToken: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? 'data/fishbowl.db',
    startBalance: Number(env.START_BALANCE ?? 100),
    npcBalance: Number(env.NPC_BALANCE ?? 500),
    tickMs: Number(env.TICK_MS ?? 5000),
    adminToken: env.ADMIN_TOKEN ?? '',
  }
}
