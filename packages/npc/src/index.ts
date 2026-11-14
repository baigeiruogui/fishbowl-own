// @fishbowl/npc —— 脚本化 NPC 镇民决策大脑的统一出口。

export type {
  Personality,
  TimeOfDay,
  NpcTable,
  NpcJob,
  NpcShopItem,
  NpcShop,
  NpcBounty,
  NpcView,
  NpcAction,
} from './types.ts'

export { decide, makeRng } from './brain.ts'
