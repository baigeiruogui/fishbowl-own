// domain 层入口：经济领域（账本 / 打工 / 钓鱼卖钱 / 座位费 / 每日上限）。
// 所有金额变动都经由 postLedger（见 db/index.ts）；本层只做业务编排与校验。
export * from './errors.ts'
export * from './account.ts'
export * from './jobs.ts'
export * from './fishing.ts'
export * from './seat.ts'
