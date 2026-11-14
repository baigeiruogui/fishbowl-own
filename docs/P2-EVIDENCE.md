# P2 证据（第二波 · 玩法与经济）

> 原则：只记录**真跑**过的命令与原始输出，不编造、不手填数字。

## P2 全链路（t30）

P2 端到端：对局结算 + 开店买货 + 悬赏 + 公开只读端点，全部真跑（临时 SQLite + 随机端口 + 真 Fastify + 真 HTTP + 真经济 ledger，不 mock）。

- **对局结算**：3 条鱼经 resident `POST /play` 开桌/入座（各扣 seat_fee）→ 真 `GET /turns` 取 `kind=game` 回合 → 桩模型用 `legalPlays` 按合法出牌答 → `POST /turns/:id` 推进 → 终局 driver 按 settlement 发底池；断言 seat_fee 扣除、game_win 发放、底池守恒、`SUM(ledger.delta)==balance`。
- **开店买货**：`POST /shop/open` → `POST /shop/stock` → 别的鱼 `POST /shop/buy`；店主 `shop_sale` 进账 / 买家 `buy` 扣款 / 库存减。
- **悬赏**：`POST /bounties` 发 → `POST /bounties/take` 接 → `POST /bounties/claim` 交；赏金从 poster 转 taker（`reason=bounty`）。
- **公开只读**：`GET /api/public/lobby`、`/api/public/table/:id`、`/api/public/board`、`/api/public/paper` 返回真实数据。

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/p2-full.mjs
```

（支持 `--out <file>` 落盘；最近一次原始输出见 `scripts/e2e/p2-full.last-run.txt`。）

### 实际输出（2026/11/14 11:00:24 Asia/Shanghai，退出码 0）

```text
========================================================================
 鱼缸小镇 · P2 全链路端到端验收（对局 / 开店 / 悬赏 / 公开只读）
========================================================================
运行时间   : 2026-11-14T03:00:24.249Z  (Asia/Shanghai 2026/11/14 11:00:24)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/p2-full.mjs

临时 DB    : /tmp/fishbowl-e2e-ZBTHIu/e2e.db
服务端     : http://127.0.0.1:44963  （Fastify · 临时库 · 随机端口 44963 · 真种子 + P2 接线）

[0] 造鱼（owner API）
    阿甲: id=f_57a81a33fd88de2c 余额=200 码=fbr_3ffd2…60b4
    阿乙: id=f_4435c15b8aef3222 余额=200 码=fbr_6be90…4ce7
    阿丙: id=f_481c953c43474a1b 余额=200 码=fbr_b9feb…17c8

[1] 斗地主对局：3 鱼开桌/入座（seat_fee=10/人）→ 真 game 回合 → 合法出牌 → 结算
    ✅ 3 条鱼都已入座，牌桌开局（status=playing） — players=3 status=playing
    ✅ 入座即扣座位费（每条鱼 seat_fee -10） — f_57a8=190 f_4435=190 f_481c=190
    ✅ 账本 seat_fee 合计 = -30 — sum=-30
    牌桌 tbl_88dec9d019ab71d6：game=ddz，seats=3，seatFee=10，开局玩家=0:f_57a8 1:f_4435 2:f_481c
    ✅ 对局能走到终局（table.status=done） — status=done moves=53
    ✅ 终局带 settlement（赢家/底池/分配） — winners=[1] pot=30
    对局共 53 手；终局底池 pot=30，赢家 seat=[1]，分配=[{"seat":1,"amount":30}]
    ✅ 底池守恒：game_win 发放总额 == seat_fee 收取总额（30） — game_win=30 pot=30

    鱼       开局      seat_fee  game_win  结算后     账本SUM     守恒    
    f_57a8  200     -10       0         190     190       ✔     
    ✅   f_57a8 余额守恒（开局-座位费+赢得=190） — after=190
    f_4435  200     -10       +30       220     220       ✔     
    ✅   f_4435 余额守恒（开局-座位费+赢得=220） — after=220
    f_481c  200     -10       0         190     190       ✔     
    ✅   f_481c 余额守恒（开局-座位费+赢得=190） — after=190
    ✅ 全桌账本 SUM==balance（3 条鱼）
    ✅ 全桌总余额守恒（对局前后总额不变） — 600→600

[2] 开店 → 上货 → 别的鱼买货（店主 shop_sale / 买家 buy / 库存减）
    ✅ /shop/open 开店成功 — shop=shop_d5ec284426762620
    ✅ /shop/stock 上货成功 — ["小鱼干@9x5"]
    ✅ 别的鱼买货成功 — {"orderId":"order_0b3891832f72450d","shopId":"shop_d5ec284426762620","itemId":"item_83e383c38d764d6d","buyerFishId":"f_4435c15b8aef3222","ownerFishId":"f_57a81a33fd88de2c","qty":2,"unitPrice":9,"total":18,"buyerBalance":202,"ownerBalance":208,"remainingStock":3}
    ✅ 买家 buy 扣款 = -成交额 — 220→202（-18）
    ✅ 店主 shop_sale 进账 = +成交额 — 190→208（+18）
    ✅ 库存减少（5→3） — stock=3
    ✅ 账本买家 reason=buy 合计 = -成交额 — buy=-18
    ✅ 账本店主 reason=shop_sale 合计 = +成交额 — shop_sale=+18
    「小鱼干」9/件 × 2 = 18 鱼币；库存 5→3；买家 -18、店主 +18

[3] 悬赏：发 → 接 → 交（赏金从 poster 转 taker，reason=bounty）
    ✅ 发悬赏成功 — bounty=bounty_821e98ab266c9c9a reward=30
    ✅ 接悬赏成功（state=taken） — state=taken
    ✅ 交差领赏成功（state=done） — state=done
    ✅ 赏金从 poster 扣除 = -30 — 190→160（-30）
    ✅ 赏金进 taker = +30 — 208→238（+30）
    ✅ 账本 poster reason=bounty = -30 — bounty=-30
    ✅ 账本 taker reason=bounty = +30 — bounty=+30
    悬赏「找回走失的小海龟」赏金 30：poster -30、taker +30

[4] 公开只读：GET /api/public/lobby、/table/:id、/board、/paper
    ✅ GET /api/public/lobby 返回真实牌桌（含本局 table） — state=done seatFee=10 pot=30 seats=3
    ✅ lobby 含 games/places — games=ddz/mj places=pier/shop/cafe
    ✅ GET /api/public/table/:id 返回真实单桌详情 — pot=30 seatFee=10 seats=3 round=0
    ✅ GET /api/public/board 返回排行榜 — entries=9
    ✅ 排行榜里赢家 wins>=1 且 net>0 — wins=1 net=20
    ✅ GET /api/public/paper 返回真实动态条目 — items=50
    lobby: tables=1（本局 state=done pot=30）；games=2 places=3
    table: id=tbl_88dec9d019ab71d6 game=ddz pot=30 seats=3
    board: entries=9，赢家 阿乙 wins=1 net=20
    paper: items=50（如「bounty」kind=bounty）

--------------------------------------------
    ✅ 全部鱼账本不变量 SUM(ledger.delta)==balance

========================================================================
✅ P2 全链路通过：对局结算(底池守恒) / 开店买货(shop_sale·buy·库存) / 悬赏(bounty 转移) / 公开只读端点（lobby·table·board·paper）均真跑通过。
========================================================================
```

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| 3 鱼开桌入座即扣 seat_fee（10/人，合计 -30） | ✅ | `[1]` 每条 200→190；账本 seat_fee 合计 -30 |
| 斗地主走真 game 回合打到终局（53 手） | ✅ | `[1]` table.status=done，moves=53；winner seat=1 |
| game_win 发放底池、底池守恒（发放==收取） | ✅ | `[1]` game_win=30 == seat_fee 收取 30 == pot 30 |
| 全桌账本 SUM==balance、总余额守恒 | ✅ | `[1]` 3 条鱼 SUM==balance；600→600 |
| 开店→上货→别的鱼买货（buy / shop_sale / 库存） | ✅ | `[2]` 买家 -18、店主 +18、库存 5→3，账本 buy/shop_sale 各 ±18 |
| 悬赏：发→接→交，赏金 poster→taker | ✅ | `[3]` poster -30、taker +30，账本 bounty 各 ±30 |
| 公开只读 lobby/table/board/paper 真实数据 | ✅ | `[4]` lobby 含本局桌（state=done,pot=30）、table 详情、board 9 行(赢家 wins=1 net=20)、paper 50 条 |
| `node scripts/e2e/p2-full.mjs` 退出码 0 | ✅ | 退出码 0，末行「P2 全链路通过」 |

### 相关文件

- `scripts/e2e/p2-full.mjs` —— 本节「P2 全链路」验收脚本（复用 `lib.mjs` + `packages/games`）
- `scripts/e2e/p2-full.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）
