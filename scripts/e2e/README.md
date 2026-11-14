# scripts/e2e —— 端到端测试脚手架

真跑、不 mock 经济的 e2e 工具。脚本是 `.mjs`，直接 `import` 服务端 `packages/server/src/*.ts`
（Node 24 原生剥离 TS 类型，无需先编译）。

## 文件

| 文件 | 作用 |
|---|---|
| `lib.mjs` | 脚手架：`startTestServer()`（临时 DB + 随机端口）、`createFishViaOwnerApi()` / `createResidentFish()`、`residentApi()` HTTP 客户端、`ledgerRows()` / `sumByReason()`、断言与格式化 |
| `p1-server.mjs` | P1「服务端经济闭环」场景：回合 → 打工 → 钓鱼卖钱 → 座位费 → 账本对账 |
| `p1-server.last-run.txt` | 最近一次真跑输出（由 `--out` 生成，供 docs 引用） |
| `hardening.mjs` | 健壮性与安全回归：账本随机压测(N=1000) / 并发不透支 / 鉴权 401 / 密钥只存 sha256 / 启动日志不泄漏明文码 |
| `hardening.last-run.txt` | hardening 最近一次真跑输出（由 `--out` 生成，供 docs 引用） |
| `concurrency.mjs` | 多鱼并发长轮询压测：8 鱼并发不串台 + 同鱼双长轮询顶替；发现顶替缺陷时会退出码 1 |
| `concurrency.last-run.txt` | concurrency 最近一次真跑输出（由 `--out` 生成，供 docs 引用） |
| `games-fuzz.mjs` | 游戏引擎随机对抗（对 packages/games 只读）：斗地主 legalPlays/非法组合/30 局对抗 + 麻将 canWin/牌数守恒 + 1000 次随机调用 |
| `games-fuzz.last-run.txt` | games-fuzz 最近一次真跑输出（由 `--out` 生成，供 docs 引用） |
| `full-chain.mjs` | P1 全链路：真插件（fake-dsh-host）↔ 真服务端（agency 回合往返 + /town work/sell/status + 座位费）↔ web（首屏/静态 + /api/public/* 真实数据） |
| `full-chain.last-run.txt` | full-chain 最近一次真跑输出（由 `--out` 生成，供 docs 引用） |
| `p2-full.mjs` | P2 全链路：3 鱼斗地主对局结算（seat_fee/game_win/底池守恒）+ 开店买货 + 悬赏 + 公开只读 lobby/table/board/paper |
| `p2-full.last-run.txt` | p2-full 最近一次真跑输出（由 `--out` 生成，供 docs/P2-EVIDENCE.md 引用） |
| `p3-full.mjs` | P3 全链路：礼物（扣款+社交预算）/ 好友（双向·去重）/ 小手机（好友·长度·日上限）/ 法庭（有罪赔付守恒·无罪不赔）+ 公开只读 court/relations/phone |
| `p3-full.last-run.txt` | p3-full 最近一次真跑输出（由 `--out` 生成，供 docs/P3-EVIDENCE.md 引用） |
| `p35-full.mjs` | P3.5 全链路：媒体（拍照/点歌/画铺+SVG 文件）/ 夸夸 / 小游戏（rps·dice·lottery）/ 画铺 gallery + public 相册 |
| `p35-full.last-run.txt` | p35-full 最近一次真跑输出（由 `--out` 生成，供 docs/P35-EVIDENCE.md 引用） |
| `p4-full.mjs` | P4 全链路：多主人（注册/隔离/3条上限/pending→approve）+ 狼人杀·海龟汤（turns 驱动）+ 媒体（出 SVG/点歌仅记录） |
| `p4-full.last-run.txt` | p4-full 最近一次真跑输出（由 `--out` 生成，供 docs/P4-EVIDENCE.md 引用） |

## 用法

```bash
cd fishbowl-own

# 跑服务端经济闭环（打印真实证据报告，退出码 0 = 通过）
node scripts/e2e/p1-server.mjs

# 跑健壮性与安全回归（随机压测 / 并发不透支 / 鉴权与密钥）
node scripts/e2e/hardening.mjs

# 跑多鱼并发长轮询压测（不串台 / 顶替 / 时延）
node scripts/e2e/concurrency.mjs

# 跑游戏引擎随机对抗测试（斗地主 / 麻将）
node scripts/e2e/games-fuzz.mjs

# 跑 P1 全链路（真插件 ↔ 服务端 ↔ web）
node scripts/e2e/full-chain.mjs

# 跑 P2 全链路（对局结算 / 开店买货 / 悬赏 / 公开只读）
node scripts/e2e/p2-full.mjs

# 跑 P3 全链路（礼物 / 好友 / 小手机 / 法庭 / 公开只读）
node scripts/e2e/p3-full.mjs

# 跑 P3.5 全链路（媒体 / 夸夸 / 小游戏 / 画铺）
node scripts/e2e/p35-full.mjs

# 跑 P4 全链路（多主人 / 狼人杀·海龟汤 / 媒体）
node scripts/e2e/p4-full.mjs

# 另存一份报告（docs 引用用）
node scripts/e2e/p1-server.mjs --out scripts/e2e/p1-server.last-run.txt
node scripts/e2e/hardening.mjs --out scripts/e2e/hardening.last-run.txt
node scripts/e2e/concurrency.mjs --out scripts/e2e/concurrency.last-run.txt
node scripts/e2e/games-fuzz.mjs --out scripts/e2e/games-fuzz.last-run.txt
node scripts/e2e/full-chain.mjs --out scripts/e2e/full-chain.last-run.txt
node scripts/e2e/p2-full.mjs --out scripts/e2e/p2-full.last-run.txt
node scripts/e2e/p3-full.mjs --out scripts/e2e/p3-full.last-run.txt
node scripts/e2e/p35-full.mjs --out scripts/e2e/p35-full.last-run.txt
node scripts/e2e/p4-full.mjs --out scripts/e2e/p4-full.last-run.txt
```

## 约定

- **真跑**：起真 Fastify 服务端 + 真 SQLite + 真 HTTP（`fetch`），不 stub 经济与账本。
- **隔离**：临时库目录（`mkdtemp`）+ 随机端口；跑完自动关服务、删临时目录，不污染 `data/`。
- **断言失败即红**：任一断言不成立 → 抛错，进程以非 0 退出（CI 可用）。
- 后续 t5 的全链路垂直切片（插件 + web）可复用 `lib.mjs` 直接扩展。
