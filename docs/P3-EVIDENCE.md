# P3 证据（第三波 · 社交 / 法庭）

> 原则：只记录**真跑**过的命令与原始输出，不编造、不手填数字。

## P3 全链路（t39）

P3 端到端：礼物 / 好友 / 小手机 / 法庭 + 公开只读端点，全部真跑（临时 SQLite + 随机端口 + 真 Fastify + 真 HTTP + 真经济 ledger，不 mock）。

- **送礼物**：`POST /social/gift` —— sender 扣款（`reason=gift`），受「每日社交预算」约束（超限 `DAY_CAP` 拒绝）；receiver 收到礼物事件（按 t31 设计「礼物=消费」，不进现金）。
- **加好友**：`POST /relations/friend` —— 双向可见、幂等去重（重复 `created=false`）。
- **小手机**：`POST /phone` 仅好友可发、单条 ≤60 字、每天 ≤20 条（超限 `DAY_CAP`）；`GET /phone` 收件人可见。
- **法庭**：`POST /court/file → /court/evidence → /court/vote → /court/verdict` —— 有罪从「镇财政」赔付给原告（`reason=court`，`court` 账本合计 0 守恒）、无罪不赔。
- **公开只读**：`GET /api/public/court`、`/relations`、`/phone`（隐私占位 `public:false`）返回真实数据。
- 全程断言账本不变量 `SUM(ledger.delta)==fish.balance`（含镇财政）。

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/p3-full.mjs
```

（支持 `--out <file>` 落盘；最近一次原始输出见 `scripts/e2e/p3-full.last-run.txt`。）

### 实际输出（2026/11/14 11:16:23 Asia/Shanghai，退出码 0）

```text
========================================================================
 鱼缸小镇 · P3 全链路端到端验收（礼物 / 好友 / 小手机 / 法庭 / 公开只读）
========================================================================
运行时间   : 2026-11-14T03:16:23.453Z  (Asia/Shanghai 2026/11/14 11:16:23)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/p3-full.mjs

临时 DB    : /tmp/fishbowl-e2e-PSfVHA/e2e.db
服务端     : http://127.0.0.1:35565  （Fastify · 临时库 · 随机端口 35565 · 真种子 + P3 接线）

[0] 造鱼（owner API）
    阿甲: id=f_d2d117de5e6aadf1 余额=300 码=fbr_73da8…3b9d
    阿乙: id=f_92bbe028672cb5ee 余额=300 码=fbr_5e648…92c4
    阿丙: id=f_224fb7b186e5395e 余额=300 码=fbr_0d236…1907
    阿丁: id=f_11b97093d82da021 余额=300 码=fbr_475b6…5104

[1] 送礼物（gift 10 鱼币）：sender 扣款 + 社交预算/日上限；receiver 收礼物事件
    ✅ GET /social 返回预算/已用/剩余 — budget=50 used=0 remaining=50
    ✅ 送礼成功 — {"ref":"gift_6d44c93a132a31c1","fromFishId":"f_d2d117de5e6aadf1","toFishId":"f_92bbe028672cb5ee","item":"贝壳","price":10,"balance":290,"usedToday":10,"budget":50}
    ✅ sender 被扣款 = -10 — 300→290（-10）
    ✅ sender 账本 reason=gift 合计 = -10 — gift=-10
    ✅ 社交已用 +10、剩余 -10 — used=10 remaining=40
    ✅ receiver 收到礼物事件（from=sender, item, price） — event={"from":"f_d2d117de5e6aadf1","item":"贝壳","price":10,"ref":"gift_6d44c93a132a31c1","words":"给你"}
    说明：按 t31 设计「礼物=消费」——sender 扣 10 鱼币、receiver 收礼物事件（不进现金，收礼人余额 300→300 不变）。
    ✅ 超社交预算被拒（DAY_CAP） — status=409 code=DAY_CAP
    ✅ 被拒的礼物无副作用（sender 余额/礼物账本不变）
    社交预算 budget=50，已用 10，剩余 40；再送 41 → 拒绝(409 DAY_CAP)

[2] 加好友：makeFriend 双向可见、幂等去重
    ✅ 阿甲 加 阿乙 为好友（created=true） — {"a":"f_92bbe028672cb5ee","b":"f_d2d117de5e6aadf1","created":true,"since":1794626183557}
    ✅ 重复加好友幂等（created=false） — {"a":"f_92bbe028672cb5ee","b":"f_d2d117de5e6aadf1","created":false,"since":1794626183557}
    ✅ 好友双向可见（A 看到 B、B 看到 A） — A好友=阿乙 B好友=阿甲
    阿甲 friends=阿乙；阿乙 friends=阿甲

[3] 小手机：好友互发成功 / 非好友拒绝 / 超 60 字拒绝 / 日上限(20)拒绝
    ✅ 非好友发消息被拒（BAD_REQUEST） — status=400 code=BAD_REQUEST
    ✅ 好友间发消息成功 — {"id":1,"fromFishId":"f_d2d117de5e6aadf1","toFishId":"f_92bbe028672cb5ee","text":"今晚码头钓鱼吗？","ts":1794626183568,"readAt":null}
    ✅ 收件人 GET /phone 能看到该消息 — messages=1
    ✅ 超 60 字被拒（BAD_REQUEST） — status=400 code=BAD_REQUEST chars=61
    ✅ 可发满 20 条/天 — sent=20
    ✅ 第 21 条超日上限被拒（DAY_CAP） — status=409 code=DAY_CAP
    好友消息成功；非好友 400；超长 400；发满 20 条后第 21 条 → 409 DAY_CAP

[4] 法庭：立案→举证→陪审投票→判决（有罪从镇财政赔付，court 账本守恒；无罪不赔）
    ✅ 立案成功（state=filed） — case=case_13429f40faf8ec5c state=filed
    ✅ 举证成功（filed→hearing） — state=hearing
    ✅ 陪审投票1（有罪，hearing→jury） — state=jury votes=1
    ✅ 陪审投票2（有罪，共2票） — votes=2
    ✅ 判决有罪并赔付（guilty, paid=true） — verdict=guilty paid=true amount=40
    ✅ 原告获得赔付 = +40 — 290→330（+40）
    ✅ court 账本合计 = 0（财政-赔付 与 原告+赔付 守恒） — courtSum=0
    ✅ 原告账本 reason=court = +40 — court=+40
    案 case_13429f40faf8ec5c：filed→hearing→jury(2票有罪)→verdict(guilty)；原告 阿甲 290→330（+40），镇财政余额 460，court 合计=0
    ✅ 判决无罪不赔（not_guilty, paid=false） — verdict=not_guilty paid=false
    ✅ 无罪不改变原告余额 — 330→330
    案 case_d96b82532191ec66：2 票无罪 → verdict=not_guilty，paid=false（不赔）

[5] 公开只读：GET /api/public/{court,relations,phone}
    ✅ GET /api/public/court 返回真实案件列表 — cases=2
    ✅ GET /api/public/relations 返回真实好友对（含 阿甲-阿乙） — 阿乙-阿甲
    ✅ GET /api/public/phone 隐私占位（public=false） — public=false messages=0 note=小手机的私信仅当事人可见
    court: cases=2（含 guilty/not_guilty）；relations: 1 对，含 阿乙-阿甲
    phone: public=false，messages=0，「小手机的私信仅当事人可见」

    ✅ 全部鱼（含镇财政）账本不变量 SUM(ledger.delta)==balance

========================================================================
✅ P3 全链路通过：礼物(sender 扣款+预算/日上限) / 好友(双向·去重) / 小手机(好友·长度·日上限) / 法庭(有罪赔付守恒·无罪不赔) / 公开只读端点 均真跑通过。
========================================================================
```

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| 送礼物：sender 扣款、社交预算/日上限（超限拒绝） | ✅ | sender 300→290（gift -10）；GET /social used=10 remaining=40；再送 41 → 409 DAY_CAP；receiver 收礼物事件 |
| 加好友：双向可见、去重幂等 | ✅ | A 加 B：created=true 后重复 created=false；A/B 各自 GET /relations 互相可见 |
| 小手机：好友成功 / 非好友拒绝 / 超 60 字 / 日上限 20 拒绝 | ✅ | 好友 200；非好友 400；61 字 400；发满 20 条后第 21 条 409 DAY_CAP |
| 法庭：立案→举证→投票→判决，有罪赔付守恒 | ✅ | filed→hearing→jury(2 票)→guilty，原告 +40（290→330），court 合计=0，财政 460 |
| 法庭：无罪不赔 | ✅ | 2 票无罪 → verdict=not_guilty、paid=false，原告余额不变 |
| 公开只读 court/relations/phone 真实数据 | ✅ | court cases=2；relations 含 阿乙-阿甲；phone public=false（隐私占位） |
| 账本不变量 SUM==balance（含镇财政） | ✅ | 全部鱼 verifyBalance.ok |
| `node scripts/e2e/p3-full.mjs` 退出码 0 | ✅ | 退出码 0，末行「P3 全链路通过」 |

### 备注（礼物语义）

按 `packages/server/src/domain/social.ts` 与 `test/social.test.ts` 的既定设计，**礼物是消费**：送礼人扣钱、收礼人收到「礼物事件」（物品/附言），**不把现金打给收礼人**、收礼人余额不变。若产品要求「礼物=现金转账（受礼人进账）」，需改 `gift()` 增加对 receiver 的正向 `postLedger`——本测试按现有实现与单测口径验收，并在此显式标注该差异。

### 相关文件

- `scripts/e2e/p3-full.mjs` —— 本节「P3 全链路」验收脚本（复用 `lib.mjs`）
- `scripts/e2e/p3-full.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）
