# P2 作战计划（第二波：多鱼在线 + 核心玩法）

> 前置：P1 收口（经济闭环 + resident API + 插件 + web + e2e）。P2 起要把小镇从「一条鱼自己赚钱花」变成「有牌桌、有店、有悬赏、有镇民的多鱼小镇」。

## 已有可复用资产（P1 产出）
- `packages/games`：斗地主 `parsePlay/canBeat/legalPlays`、麻将 `canWin/createState`（纯引擎，23 测试）。
- `packages/npc`：`decide(view,rng)` 脚本化镇民大脑（18 测试）。
- `packages/shared`：类型 + 发言审核 `checkLine`（15 测试）。
- `packages/server`：db(postLedger 不变量) / domain(打工/钓鱼/座位费) / api(resident) / engine(回合 hub)。
- `packages/plugin`：DSH 插件（连自建服务端）。
- `packages/web`：Vite 面板。

## 关键前置动作（captain 在波次开始先做）
1. `pnpm install` 正式链接 `@fishbowl/games`、`@fishbowl/npc`（清掉 npc 手工软链）。
2. 在 server/package.json 加 workspace 依赖 `@fishbowl/games`、`@fishbowl/npc`、`@fishbowl/shared`。
3. 把 `api/resident.ts` 拆出按功能的路由文件（`routes/shop.ts`、`routes/bounty.ts`、`routes/games.ts`），index 统一注册 —— 便于多人并行不冲突。

## 任务（按可并行度拆分）
| id | 任务 | 负责 | 依赖 | 交付 |
|---|---|---|---|---|
| P2-A | 对局编排：venue/table/session/seat + 斗地主发牌/回合/裁判(Games)/底池结算(game_win)/座位费 | server-dev | P1 | 牌桌能开、能打、能结算 |
| P2-B | 大厅/开桌/入座/观战/串门 domain+API | server-dev | P1 | lobby 真实数据、串门对话回合 |
| P2-C | 开店卖货：shop/item/order、买家扣款+店主入账(shop_sale)、店库存 | server-dev2 | 前置3 | 开店→上货→被买→收钱 |
| P2-D | 悬赏板：bounty 发布/接取/交差/托管赏金发放(bounty) | server-dev2 | 前置3 | 悬赏闭环 |
| P2-E | NPC 镇民接入 sim tick（用 @fishbowl/npc）+ 日报生成 paper | server-dev | P2-A..D | 镇上有人气、有日报 |
| P2-F | 插件 P2 工具：`/town tables\|play\|visit\|shop\|bounty\|lobby` | plugin-dev | P2-A..D API | 她能用这些玩法 |
| P2-G | web P2 页：大厅/牌桌直播/积分榜/日报/鱼档案 | web-dev | P2-A..D | 面板完整 |
| P2-H | P2 端到端 + 证据（两鱼对打、开店买货、悬赏、日报） | qa | P2-A..G | docs/P2-EVIDENCE.md |
| P2-I | 评审 | reviewer | P2-H | findings |

## 并行策略
- 服务端拆 `server-dev`（A/B/E）+ 新增 `server-dev2`（C/D）两人并行，靠拆分 route 文件避免写冲突。
- 插件、web 在 API 稳定后并行。
- 每完成一组即验收，qa 最后总联调。

## 验收（P2 整体）
两条以上鱼能同桌打一局斗地主/麻将并结算积分与鱼币；能开店被别的鱼买走并进账；能发/接/交悬赏；NPC 会自己上桌/买货/接活；日报能生成；插件与 web 都能操作这些玩法；全部有真实证据。
