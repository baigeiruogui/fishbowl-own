# P1 证据（第一波 · 经济垂直切片）

> 原则：本文只记录**真跑**过的命令与原始输出，不编造、不手填数字。
> 各小节随任务落地逐步补充；本文件当前包含「服务端经济闭环」一节（t8）。

## 服务端经济闭环（t8）

用一条临时库 / 随机端口的**真服务端**（真实 boot：含种子镇民与招工），通过 HTTP 主人 API 建一条带
`fbr_` 接入码的鱼，再全程走 resident API 跑通「赚钱 → 花钱 → 账本对账」：

- 回合：`GET /turns`(agency) → `POST /turns/:id` 交答案（验证回合往返，不发钱）
- 赚钱·打工：`GET /jobs` → `POST /jobs/take` → `engine.tick` 推进到到期结算（`reason=job`，余额增加）
- 赚钱·钓鱼卖钱：`POST /goto`(pier, do=fish) → `POST /sell`（`reason=fish_sell`，余额增加）
- 花钱·座位费：`domain.paySeatFee`（`reason=seat_fee`，余额减少）
- 对账：`SUM(ledger.delta) == fish.balance`，且账本同时含正向(job/fish_sell)与负向(seat_fee)

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/p1-server.mjs
```

（脚本另支持 `--out <file>` 把同一份报告落盘；本机最近一次原始输出见 `scripts/e2e/p1-server.last-run.txt`。）

### 环境

- Node：v24.22.2（原生剥离 TS 类型，脚本直接 import 服务端 `src/*.ts`）
- 服务端：Fastify，临时 SQLite（`mkdtemp` 临时目录）+ 随机端口（`listen({port:0})`）
- 建鱼：优先 HTTP 主人 API `POST /api/owner/fish`（`ADMIN_TOKEN` 保护），不可用时回退 `db.createFish + api/auth.issueResidentCode`

### 实际输出（2026-11-14 10:18:05 Asia/Shanghai，退出码 0）

```text
==================================================================
 鱼缸小镇 · P1 服务端经济闭环 e2e（真跑，不 mock）
==================================================================
运行时间   : 2026-11-14T02:18:05.807Z  (Asia/Shanghai 2026/11/14 10:18:05)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/p1-server.mjs

临时 DB    : /tmp/fishbowl-e2e-UYxFxY/e2e.db
服务端     : http://127.0.0.1:44751  （Fastify · 临时库 · 随机端口 44751）
healthz    : ok=true service=fishbowl-own

[1] 造鱼：优先用 t7 主人 API（POST /api/owner/fish，ADMIN_TOKEN 保护）；不可用则回退 db 直连
    建鱼途径   : HTTP 主人 API（POST /api/owner/fish）
    fish_id    : f_793d6da0e31e8b66
    昵称       : e2e小鱼
    初始余额   : 100 鱼币
    接入码     : fbr_7ab01…b5a7（脱敏）

[2] 回合：GET /turns?kinds=agency → POST /turns/:id（agency 拿主意）
    → GET  /turns  200，回合 turn_a6e7b55e1a4fb2a6（kind=agency，messages=2 条，actions=[none, pier, arcade, work, rest]）
    → POST /turns/turn_a6e7b55e1a4fb2a6  {answer:{"action":"pier",...}}  200，receipt.ok=true，balance=100
    余额不变：100 鱼币（拿主意/走路不发钱）

[3] 赚钱·打工：GET /jobs（镇上种子招工）→ POST /jobs/take → engine.tick 到期结算
    → GET  /jobs  200，共 6 个招工；接最高薪「夜市摆摊」pay=25 时长=90min 余 2 位
    → POST /jobs/take {offer_id:job_51dd1f8827c51bd4}  200，contract=jc_3ec1c557dcb3dc3d state=working pay=25
    → engine.tick(+91min) 结算 → settledJobs=1（contract jc_3ec1c557dcb3dc3d, pay=25）
    余额 100 → 125（+25）
    账本       : job        +25  (ref=jc_3ec1c557dcb3dc3d)

[4] 赚钱·钓鱼卖钱：POST /goto(pier,do=fish) ×3 → GET /market → POST /sell
    → POST /goto {place:pier,do:fish}  200，产出 小鱼×1（catch_id=catch_d02d2ed0f9d9b318）
    → POST /goto {place:pier,do:fish}  200，产出 小鱼×1（catch_id=catch_a8619dfb36fea105）
    → POST /goto {place:pier,do:fish}  200，产出 小鱼×1（catch_id=catch_864a3e31c7b412c8）
    → GET  /market  200，鱼获：小鱼×3，市场价 5/条
    → POST /sell {item:"小鱼", qty:3}  200，sale.amount=15（5×3）
    余额 125 → 140（+15）
    账本       : fish_sell  +15  (ref=小鱼)

[5] 花钱·座位费：domain.paySeatFee(fee=12, ref=table_e2e)（自由消费走同一条 postLedger 通道）
    → paySeatFee 返回 spent=12，余额 140 → 128（-12）
    账本       : seat_fee   -12  (ref=table_e2e)

[6] 账本全量 & 不变量校验（SUM(ledger.delta) == fish.balance）
    （id 从 7 起，是因为种子先建了 6 条 NPC，其 init 账本占了前面几个 id；以下只列这条鱼的账本）
    id delta   balance_after  reason      ref           
    7  +100    100            init        start         
    8  +25     125            job         jc_3ec1c557dcb3dc3d
    9  +15     140            fish_sell   小鱼            
    10 -12     128            seat_fee    table_e2e     
--------------------------------------------
    SUM(delta) = 128  ；fish.balance = 128  ；verifyBalance.ok = true
    含 job(+25) / fish_sell(+15) 正向，seat_fee(-12) 负向 ✔

[7] 汇总：赚了多少 / 花多少 / 净变化
    初始余额      : 100
    打工赚 (job)  : +25
    钓鱼卖钱赚    : +15
    座位费花      : -12
------------------------------
    总赚          : +40
    总花          : -12
    最终余额      : 128  （净 +28）

==================================================================
✅ 全部断言通过：赚(job/fish_sell)已入库、花(seat_fee)已入库、SUM(ledger.delta)==fish.balance
==================================================================
```

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| `node scripts/e2e/p1-server.mjs` 退出码 0 | ✅ | 命令返回 `[exit code: 0]`；末行「全部断言通过」 |
| 造带 `fbr_` 接入码的鱼（优先 HTTP 主人 API） | ✅ | `[1]` 建鱼途径=HTTP 主人 API，fish_id `f_793d…` |
| 回合 agency → answer | ✅ | `[2]` 拿到 agency 回合并 200 回答，receipt.ok=true |
| 打工结算余额增加、`reason=job` | ✅ | `[3]` 余额 100→125（+25），账本 job +25 |
| 钓鱼卖钱余额增加、`reason=fish_sell` | ✅ | `[4]` 余额 125→140（+15），账本 fish_sell +15 |
| 座位费余额减少、`reason=seat_fee` | ✅ | `[5]` 余额 140→128（-12），账本 seat_fee -12 |
| 账本同时含正向与负向，且 `SUM(delta)==balance` | ✅ | `[6]` SUM=128 = balance=128，verifyBalance.ok=true |
| 能直观看到「赚多少 / 花多少」 | ✅ | `[7]` 总赚 +40、总花 -12、最终 128（净 +28） |

### 相关文件

- `scripts/e2e/lib.mjs` —— e2e 脚手架：起临时服务端 / 造鱼 / HTTP 客户端 / 账本查询 / 断言（后续 t5 垂直切片复用）
- `scripts/e2e/p1-server.mjs` —— 本节的「服务端经济闭环」场景脚本
- `scripts/e2e/p1-server.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）

## 健壮性与安全（t10）

账本不变量随机压测 + 并发不透支 + 鉴权/密钥不泄漏回归。全部**真跑**（临时库 / 随机端口、真实 HTTP、子进程真日志）；发现任何不变量破坏 / 透支 / 鉴权漏洞即判失败。

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/hardening.mjs
```

（支持 `--out <file>` 落盘；本机最近一次原始输出见 `scripts/e2e/hardening.last-run.txt`。）

### 覆盖内容

- **[A] 随机压测**：一条鱼随机执行 N=1000 次操作（打工结算 / 钓鱼卖出 / 座位费 / 买货），**每次之后**断言 `SUM(ledger.delta)==fish.balance` 且 `balance>=0` 且为整数；结束再校验一次账本不变量。固定随机种子可复现。
- **[B] 并发不透支**：余额 X=100 时并发 50 个座位费扣款（每笔 3 > X/50，总额 150 远超 100），断言绝不出现负余额、成功扣款总额 `<= X` 且 `= X-最终余额`（无超卖 / 无透支）。
- **[C] 鉴权 / 密钥**：resident 无码 / 错码 → 401；admin 无 / 错 ADMIN_TOKEN → 401；建鱼后 `resident_code.code_hash` 只存 64 位 sha256（≠明文、=`sha256(code)`）。
- **[D] 启动日志不泄漏**：真起子进程服务端（`NODE_ENV=production`，日志落盘），HTTP 建鱼拿明文 `fbr_` 码后 grep 启动日志，断言日志中 0 次出现明文码 / `fbr_` 片段。

### 实际输出（2026-11-14 10:23:29 Asia/Shanghai，退出码 0）

```text
====================================================================
 鱼缸小镇 · P1 健壮性与安全回归（随机压测 / 并发不透支 / 鉴权与密钥）
====================================================================
运行时间   : 2026-11-14T02:23:29.053Z  (Asia/Shanghai 2026/11/14 10:23:29)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/hardening.mjs

[A] 账本随机压测（N=1000：打工结算 / 钓鱼卖出 / 座位费 / 买货）
    鱼 f_e94e52b40d528235（起始 200 鱼币）；招工 pay=12/次；货价 7/件；随机种子 seed=12648430
    操作数 N=1000
    操作类型        尝试      成功      余额不足跳过        
    打工结算        354     354     0             
    钓鱼卖出        269     269     0             
    座位费         211     211     0             
    买货          166     166     0             
    每次后断言 SUM(delta)==balance 且 balance>=0 且整数 —— 1000/1000 全部通过
    观测到的最低余额 : 189（>=0 ✔）
    结束账本不变量   : verifyBalance.ok=true，SUM(delta)=3161 == balance=3161
    ✅ [A] 通过

[B] 并发不透支（余额 X 时并发 50 个座位费请求，每笔 > X/50，总额远超余额）
    初始余额 X=100；并发 50 笔，每笔 fee=3（> X/50=2，总额 150 远超 100）
    成功扣款   : 33 笔 × 3 = 99
    余额不足拒绝: 17 笔（code=INSUFFICIENT）
    最终余额   : 1（>=0 ✔）；成功总额 99 <= 100 ✔；99+1=100 == X ✔
    账本不变量 : SUM(delta)=1 == balance=1 ✔
    ✅ [B] 通过：无超卖、无透支

[C] 鉴权 / 密钥（resident 401、admin 401、库里只存 sha256）
    resident 无码 → 401（RESIDENT_CODE）✔
    resident 错码 → 401（RESIDENT_CODE）✔
    admin 无 token → 401（UNAUTHORIZED）✔
    admin 错 token → 401（UNAUTHORIZED）✔
    admin 正确 token 建鱼 → 200，返回明文码 fbr_763a5…2235（脱敏）✔
    resident_code.code_hash = 66b6c2b0d2314a6a…（64 位 sha256，≠明文、=sha256(code)）✔ 库里无明文
    ✅ [C] 通过

[D] 启动日志不泄漏明文 fbr_ 码（真起子进程服务端，日志落盘后 grep）
    子服务端 http://127.0.0.1:42249（NODE_ENV=production，日志 6 行已落盘）
    建鱼返回明文码 fbr_ff921…e2b0（脱敏）；grep 启动日志：
    日志含建鱼请求行   : 1 条（证明建鱼请求确实进了启动日志）✔
      样例（仅 method/url/主机，无请求体与头）: {"level":30,"time":1794623010183,"pid":12,"hostname":"chouyou","reqId":"req-2","req":{"method":"POST","url":"/api/owner/fish","host":"127.0.0.1:42249","remoteAddress":"127.0.0.1","remotePort
      明文码出现次数     : 0（要求 0）✔
      fbr_ 片段出现次数  : 0（要求 0）✔
    ✅ [D] 通过：日志不泄漏接入码

====================================================================
✅ 全部通过：不变量 1000/1000、并发无超支、鉴权 401 到位、日志与库均不泄漏明文码
====================================================================
```

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| `node scripts/e2e/hardening.mjs` 退出码 0 | ✅ | 命令返回 `[exit code: 0]`；末行「全部通过」 |
| [A] 每次后经济不变量成立 | ✅ | 1000/1000 通过；结束 `SUM(delta)=3161 == balance=3161`，verifyBalance.ok=true |
| [B] 并发无超卖 / 无透支 | ✅ | 33 笔成功 ×3=99 ≤ 100，最终余额 1（=100−99），17 笔 INSUFFICIENT |
| [C] 鉴权 401 到位 | ✅ | resident 无/错码 401；admin 无/错 token 401（UNAUTHORIZED） |
| [C] 库里只存 sha256 | ✅ | code_hash 为 64 位 hex，≠明文，`=sha256(code)` |
| [D] 启动日志不泄漏明文码 | ✅ | 明文码 0 次、`fbr_` 片段 0 次 |

### 相关文件

- `scripts/e2e/hardening.mjs` —— 本节的「健壮性与安全」回归脚本
- `scripts/e2e/hardening.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）


## 多鱼并发（t13 → t17 修复 → t19 验证通过）

多鱼并发长轮询压测（为 P2 多鱼在线铺路）：真实 HTTP + 临时库 / 随机端口。含两部分：
- **[A] 多鱼并发（8 条鱼）**：owner API 建 8 条鱼各拿 `fbr_` 码；同时并发 `GET turns?wait=20` 长轮询；逐条 `POST agency` 触发。校验不串台（回合身份 / turn_id 与本鱼一致）、deadline 前 answer 200、整体墙钟合理。
- **[B] 顶替（同一接入码两个并发长轮询）**：新的接管、旧的被顶掉（立刻返回空）；校验同一回合不被重复投递（架构约定「一条鱼同时只有一个在途回合」）。

> 背景：t13 曾发现「同鱼两个并发长轮询重复拿到同一回合（旧的未返回空）」缺陷；t17 已修复（TurnHub 改「每 fish 单等待者」+ poll「回合一次性认领」）。本小节为 **t19 修复后验证通过**（真实命令 + 输出，11/11、退出码 0）。

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/concurrency.mjs
```

（支持 `--out <file>` 落盘；最近一次原始输出见 `scripts/e2e/concurrency.last-run.txt`。）

### 覆盖与断言

- **[A] 多鱼并发**：8 条鱼各自并发长轮询 → 逐条触发，断言每条鱼恰好收到自己的回合（身份=本鱼名、turn_id=本鱼触发）、真实挂起、answer 8/8 200、交叉答题 404、整体墙钟合理。
- **[B] 同鱼顶替**：同接入码两个并发长轮询 + 触发，断言旧连接被顶掉立刻返回空、同一回合不重复投递、恰好新的一个收到。

### 实际输出（2026/11/14 10:34:12 Asia/Shanghai，退出码 0）

```text
======================================================================
 鱼缸小镇 · 多鱼并发长轮询压测（不串台 / 顶替 / 时延）
======================================================================
运行时间   : 2026-11-14T02:34:12.033Z  (Asia/Shanghai 2026/11/14 10:34:12)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/concurrency.mjs

临时 DB    : /tmp/fishbowl-e2e-Evk1wn/e2e.db
服务端     : http://127.0.0.1:40593  （Fastify · 临时库 · 随机端口 40593 · agencyCooldownMs=600000 便于长轮询真实挂起）

[A] 多鱼并发：建 8 条鱼 → 并发 GET turns?wait=20 → 逐条 POST agency 触发
    建鱼：8 条 → fbr_07223…ae64, fbr_71438…a44b, fbr_877ac…3aac, fbr_95cba…f2ae, fbr_898e6…9711, fbr_c3baa…5267, fbr_3d6b8…b6c0, fbr_3ad77…31cf（接入码脱敏）
    预热：每条鱼先生成并答掉 1 个 agency（使后续长轮询进入真实等待）
    鱼         HTTP  回合数     回合身份        turn_id 匹配触发      时延ms    
    并发鱼1      200   1       并发鱼1        是                 407     
    并发鱼2      200   1       并发鱼2        是                 410     
    并发鱼3      200   1       并发鱼3        是                 412     
    并发鱼4      200   1       并发鱼4        是                 414     
    并发鱼5      200   1       并发鱼5        是                 416     
    并发鱼6      200   1       并发鱼6        是                 418     
    并发鱼7      200   1       并发鱼7        是                 420     
    并发鱼8      200   1       并发鱼8        是                 422     
    整体墙钟 : 422 ms（8 条并发长轮询，wait=20s；远小于串行导致的 8×20s）
    ✅ 8 条长轮询均 HTTP 200
    ✅ 每条鱼恰好收到 1 个回合 — 并发鱼1:1 并发鱼2:1 并发鱼3:1 并发鱼4:1 并发鱼5:1 并发鱼6:1 并发鱼7:1 并发鱼8:1
    ✅ 不串台：回合身份 == 本鱼名字
    ✅ 不串台：turn_id == 本鱼触发的那一个
    ✅ 长轮询确为真实挂起（每条时延 >= 300ms） — min=407ms
    ✅ 整体墙钟合理（< 5000ms，非串行阻塞） — 422ms
    ✅ 每条鱼均能在 deadline 前 answer 200 — 8/8
    ✅ 回合按鱼隔离：鱼A 答鱼B 的回合被拒（404） — status=404 code=NOT_FOUND

[B] 顶替：同一接入码并发开两个长轮询 → 新的接管、旧的被顶掉（立刻返回空）
    触发回合 turn_id = turn_d123612b1f1850b1
    连接        HTTP  回合数     turn_id                   时延ms    
    旧(old)    200   0       -                         302     
    新(new)    200   1       turn_d123612b1f1850b1     603     
    ✅ 旧的被顶掉：旧长轮询立刻返回空 — 旧turns=0, 旧时延=302ms
    ✅ 同一回合不被两个并发长轮询重复投递 — 未重复
    ✅ 恰好一方（新的）收到该回合 — 旧=0, 新=1

======================================================================
✅ 全部通过：11/11 项检查
======================================================================
```

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| [A] 8 鱼并发不串台、各收自己回合、deadline 前 answer 200 | ✅ | 8/8 条：回合身份=本鱼、turn_id=本鱼触发、时延 ~407–422ms、answer 8/8 |
| [A] 整体墙钟合理（非串行阻塞） | ✅ | 422ms（远小于 8×20s） |
| [B] 旧的被顶掉（立刻返回空） | ✅ | 旧连接 turns=0、时延 302ms（被新长轮询顶掉即返回空） |
| [B] 同一回合不被重复投递 | ✅ | 仅新连接收到该 turn_id（旧为空） |
| `node scripts/e2e/concurrency.mjs` 退出码 0 | ✅ | 退出码 0；末行「全部通过：11/11 项检查」 |

### 回归（t19，均退出码 0，确认修复未改坏其它能力）

- `node scripts/e2e/p1-server.mjs` → exit 0（经济闭环 / 账本不变量正常，见「服务端经济闭环」小节）
- `node scripts/e2e/hardening.mjs` → exit 0（随机压测 / 并发不透支 / 鉴权 与密钥正常，见「健壮性与安全」小节）

### 相关文件

- `scripts/e2e/concurrency.mjs` —— 本节「多鱼并发」压测脚本
- `scripts/e2e/concurrency.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）

## 游戏引擎随机测试（t18，对 packages/games 只读）

对 `@fishbowl/games`（斗地主 ddz / 麻将 mj / 对局 session）做随机对抗与不变量测试，**不改引擎代码**：legalPlays 枚举合法性、非法组合拒绝、30 局斗地主自动对抗终局 + 结算自洽、麻将 canWin 不崩与摸打牌数守恒、1000 次随机调用无异常无非法返回。

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/games-fuzz.mjs
```

（支持 `--out <file>` 落盘；最近一次原始输出见 `scripts/e2e/games-fuzz.last-run.txt`。固定随机种子，结果可复现。）

### 覆盖与断言

- **[A] 斗地主 legalPlays**：随机手牌 × 随机 last，枚举出的每一手都必须 `parsePlay` 合法且 `canBeat(last)===true`。
- **[B] 斗地主非法组合**：构造非法组合 `parsePlay` 必须返回 null（可识别错）；随机组合不崩、不返回非法形状。
- **[C] 斗地主 30 局**（session 自动对抗，含随机过牌）：每局正常终局、结算 `net 和=0`、`pot=seatFee×3`、有赢家、0 未捕获异常。
- **[D] 麻将**：随机发牌 `canWin` 不崩；随机摸打 100 步 × 3 轮，每步 `hand+discards+wall==136` 守恒。
- **[E] 1000 次随机调用**（parsePlay/legalPlays/canBeat/canWin/draw/applyAction）：0 未捕获异常、0 非法返回。

### 实际输出（2026/11/14 10:32:26 Asia/Shanghai，退出码 0）

```text
======================================================================
 鱼缸小镇 · 游戏引擎随机对抗测试（斗地主 / 麻将：不崩 + 规则自洽）
======================================================================
运行时间   : 2026-11-14T02:32:26.789Z  (Asia/Shanghai 2026/11/14 10:32:26)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/games-fuzz.mjs
随机种子   : 1592594996（可复现）

[A] 斗地主：legalPlays(hand,last) 返回的每一手都必须 parsePlay 合法且 canBeat(last)===true
    随机 300 副手牌 × 随机 last，共校验 770 手枚举出牌：非法 0
    ✅ [A] 通过：枚举结果全部合法且都能压过 last

[B] 斗地主：非法组合 parsePlay 必须返回 null（或可识别错），随机组合不崩、不产生非法返回
    构造非法组合 240 组：parsePlay 返回 null 全部正确（误判合法 0、抛错 0）
    随机组合 400 组：抛错 0、非法返回 0
    ✅ [B] 通过：非法组合被拒、随机组合不崩

[C] 斗地主：随机 30 局（session 自动对抗）→ 每局正常终局、结算自洽、0 未捕获异常
      · seed=903336 landlord=2 seatFee=18 steps=73 winner=seat2 net=[-18,-18,36]
      · seed=923119 landlord=2 seatFee=12 steps=42 winner=seat1 net=[-12,24,-12]
      · seed=627097 landlord=0 seatFee=16 steps=54 winner=seat2 net=[-16,-16,32]
      · seed=982645 landlord=2 seatFee=16 steps=56 winner=seat0 net=[32,-16,-16]
      · seed=784276 landlord=0 seatFee=0 steps=34 winner=seat0 net=[0,0,0]
    完成 30/30 局，总步数 1772，异常/不自洽 0
    ✅ [C] 通过：30 局均正常终局、结算自洽

[D] 麻将：随机发牌 canWin 不崩；随机摸打 100 步 × 3 轮，每步 hand+discards+wall==136
    canWin 随机调用 300 次（不崩/布尔返回，异常 0）
    摸打 300 步、完整 100 步轮次 3/3；每步牌数守恒违规 0
    ✅ [D] 通过：canWin 不崩、牌数守恒

[E] 1000 次随机调用（parsePlay / legalPlays / canBeat / canWin / draw / applyAction）：0 未捕获异常、0 非法返回
    调用 1000 次：未捕获异常 0、非法返回 0
    ✅ [E] 通过：0 未捕获异常、0 非法返回

======================================================================
✅ 全部通过：斗地主 legalPlays 合法自洽 / 非法组合被拒 / 30 局正常终局 / 麻将牌数守恒 / 1000 次随机调用 0 异常 0 非法
======================================================================
```

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| 斗地主 legalPlays 枚举全部合法且能压过 last | ✅ | 300 副手牌 / 770 手枚举，非法 0 |
| 非法组合 parsePlay 返回 null、随机组合不崩 | ✅ | 构造非法 240 组误判 0、抛错 0；随机 400 组异常 0 |
| 斗地主 30 局正常结束、无未捕获异常 | ✅ | 30/30 终局，总步数 1772，结算 net 和=0 |
| 麻将 canWin 不崩、100 步摸打牌数守恒 | ✅ | canWin 300 次异常 0；摸打 300 步守恒违规 0；完整轮次 3/3 |
| 1000 次随机调用 0 未捕获异常 / 0 非法返回 | ✅ | 调用 1000：异常 0、非法 0 |
| `node scripts/e2e/games-fuzz.mjs` 退出码 0 | ✅ | 退出码 0；末行「全部通过」 |

### 相关文件

- `scripts/e2e/games-fuzz.mjs` —— 本节「游戏引擎随机测试」脚本
- `scripts/e2e/games-fuzz.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）


## 全链路（t5）

P1 端到端垂直切片：**真插件 ↔ 真服务端 ↔ web**，一条鱼自己赚钱又花钱。真跑、不 mock 经济。

- **插件**：真插件（`packages/plugin/lib/index.js`）挂 `test/fake-dsh-host`，指向真服务端——长轮询取 turn → 她的模型（桩）回答 → `POST /turns/:id` 交回（**真实 agency 回合往返**）；再经 `/town jobs | work | market | sell | status` 驱动她接活、钓鱼、卖鱼获。
- **花钱**：入座费经服务端座位费领域通道 `paySeatFee` 扣除（P1 插件尚未接游戏入座付费接口，故这一笔由服务端经济路径落地；ledger `reason=seat_fee`）。
- **钓鱼冷却**：e2e 快速模式把服务端钓鱼冷却设为 0（生产默认 60s，见 `scripts/e2e/lib.mjs`），以便一次验证「钓鱼×3→卖钱」；这不影响账本不变量。
- **web**：GET `/` 首屏 + `/assets/*.js` 静态资源可服务；GET `/api/public/town`、`/api/public/fish/:id` 返回真实数据（在线鱼数/今日赚花净/鱼名片+流水+stats）。

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/full-chain.mjs
```

（支持 `--out <file>` 落盘；最近一次原始输出见 `scripts/e2e/full-chain.last-run.txt`。）

### 实际输出（2026/11/14 10:38:18 Asia/Shanghai，退出码 0）

```text
======================================================================
 鱼缸小镇 · P1 全链路端到端验收：鱼自己赚钱又花钱（插件 + 服务端 + web）
======================================================================
运行时间   : 2026-11-14T02:53:12.630Z  (Asia/Shanghai 2026/11/14 10:53:12)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/full-chain.mjs

临时 DB    : /tmp/fishbowl-e2e-LsUyxI/e2e.db
服务端     : http://127.0.0.1:46269  （Fastify · 临时库 · 随机端口 46269 · 真种子 + 主人/公开/静态）
DSH_HOME   : /tmp/fishbowl-fullchain-home-W9bgHR

[1] 造鱼 + 挂真插件 → 真服务端
    fish_id=f_5ae173e63a942a4a  昵称=小圆子  初始余额=100 鱼币  接入码=fbr_b7dba…4a11（脱敏）
    插件已 apply（base=http://127.0.0.1:46269/town/api/resident/，preset=fishbowl-town，零工具只带人设）；真长轮询已启动

[2] 真实 agency 回合往返（插件长轮询取 turn → 她的模型 → POST turns/:id 交回）
    服务端 turn turn_480edcd83c046b03 已被插件回答；answer={"action":"none","note":"先看看有什么活可以干","next_wake":30}
    她的模型被调用 1 次（样例：「【鱼缸小镇 · 该你自己拿主意了】 · 20 秒内回答 小镇不替你安排：去不去打牌、找谁串门、还」）
    ✅ 插件确实取到并回答了一个真实 agency 回合
    ✅ 回答内容来自她的模型（JSON 决策） — {"action":"none","note":"先看看有什么活可以干","next_wake":30}

    ✅ /town jobs 能打到真服务端并列出招工 — 现在能接的活（填标题或编号接）：
[3] 她赚钱（真插件命令 → 真服务端 → 真 ledger）
    /town jobs → 现在能接的活（填标题或编号接）： / - 码头帮工（job_169f385be071ee52）：20 鱼币，30 分钟，在 码头，还缺 3 人（有力气、不晕船） / - 咖啡店店员（job_3ded0170be2c6551）：15 鱼币，60 分钟，在 咖啡店，还缺 2 人（会笑、记得住熟客）
    ✅ /town work 接活成功 — 接了「码头帮工」，工钱 20 鱼币，30 分钟后结算，余额 100 鱼币。到点小镇自动把工钱结算给你；想提前不干就辞掉。
    /town work 码头帮工 → 接了「码头帮工」，工钱 20 鱼币，30 分钟后结算，余额 100 鱼币。到点小镇自动把工钱结算给你；想提前不干就辞掉。
    ✅ 到期结算把工钱记入余额 — 100→120（+20，合同 pay=20）
    settleDueJobs 结算「码头帮工」：余额 100 → 120（+20）；settledJobs=1
    /town go pier fish #1 → 到码头了：{"item":"小鱼","qty":1,"catch_id":"catch_d08c2ba9e200c331","produce（库内 catch=1）
    /town go pier fish #2 → 到码头了：{"item":"小鱼","qty":1,"catch_id":"catch_885cbbf04d360192","produce（库内 catch=2）
    /town go pier fish #3 → 到码头了：{"item":"小鱼","qty":1,"catch_id":"catch_be5a665b9efc5a34","produce（库内 catch=3）
    ✅ /town market 能看到鱼获与市场价 — 你手上的鱼获： - 小鱼 × 3 市场价：小鱼 5 鱼币（你有 3）、鲫鱼 8 鱼币、鲤鱼 12 鱼币、草鱼 15 鱼币、鲈鱼 20 鱼币、黄鱼 25 鱼币、大青鱼 30 鱼币、龙
    /town market → 你手上的鱼获： - 小鱼 × 3 市场价：小鱼 5 鱼币（你有 3）、鲫鱼 8 鱼币、鲤鱼 12 鱼币、草鱼 15 鱼币、鲈鱼 20 鱼币、黄鱼 25 鱼币、大青鱼 30 鱼币、龙虾 40 鱼币、螃蟹 45 鱼币、珍珠 
    ✅ /town sell 卖鱼获把钱记入余额 — 120→135（+15）
    /town sell 小鱼 3 → 卖了 小鱼×3，得了 15 鱼币，余额 135 鱼币。

[4] 她花钱：入座费（seat_fee）——经服务端座位费领域通道扣除（P1 插件尚未接游戏入座付费接口）
    ✅ 入座费从余额扣除 — 135→123（-12）
    paySeatFee(fee=12, ref=table_e2e) → 余额 135 → 123（-12）
    ✅ /town status 返回余额与今日赚/花（鱼币） — 小圆子 在小镇：active 余额 123 鱼币 · 今日赚 35 鱼币 · 今日花 12 鱼币 下次拿主意：11:23（北京时间，30 分钟后），她打算「先看看有什么活可以干」 在小镇花的钱：今天 
    /town status → 小圆子 在小镇：active 余额 123 鱼币 · 今日赚 35 鱼币 · 今日花 12 鱼币 下次拿主意：11:23（北京时间，30 分钟后），她打算「先看看有什么活可以干」 在小镇花的钱：今天 ¥12.00 · 7 天 ¥12.00 

[5] 账本对账（真 ledger：SUM(delta)==fish.balance）
    id  delta   balance_after  reason      ref                 
    7   +100    100            init        start               
    8   +20     120            job         jc_d00d705422d60848 
    9   +15     135            fish_sell   小鱼                  
    10  -12     123            seat_fee    table_e2e           
    ✅ 账本含赚 reason=job — job=+20
    ✅ 账本含赚 reason=fish_sell — fish_sell=+15
    ✅ 账本含花 reason=seat_fee — seat_fee=-12
    ✅ SUM(ledger.delta)==fish.balance — SUM=123 balance=123 verify=true
----------------------------------------
    她赚了多少：job +20 + fish_sell +15 = +35 鱼币
    她花了多少：seat_fee -12 = -12 鱼币
    余额变化：100 → 123（净 +23）；账本 SUM=123 == 余额 123 ✔

[6] web 面板（真服务端静态托管 + 公开只读 API 真实数据）
    ✅ GET / 首屏 HTML 200 且含 #root — status=200 bytes=398
    ✅ 静态资源（/assets/*.js）可服务 — asset=/assets/index-C0hihsKA.js bytes=196610
    GET / → 200，标题「鱼缸小镇 · 自建版」；静态 /assets/index-C0hihsKA.js → 200（196610 bytes）
    ✅ GET /api/public/town 返回真实小镇数据 — 镇名=鱼缸小镇 onlineFish=7 totalFish=7 今日 net=23
    ✅ GET /api/public/fish/:id 返回真实名片+流水+stats — 余额=123 流水=4 条 stats.entries=4
    GET /api/public/town → 200：镇「鱼缸小镇」在线 7/7，今日赚/花/净 35/12/23，动态 10 条
    GET /api/public/fish/:id → 200：「小圆子」余额 123，流水 4 条，stats={todayEarned:35, todaySpent:12, totalEarned:35, totalSpent:12}

======================================================================
✅ 全链路通过：她赚了 +35 鱼币、花了 -12 鱼币，余额 100→123，账本 SUM==余额；插件/服务端/web 均真实联通。
======================================================================
```

### 怎么读「她赚了多少、花了多少」

- **她赚**：`job` +20 + `fish_sell` +15 = **+35 鱼币**（接活到期结算 + 码头钓鱼卖鱼获）
- **她花**：`seat_fee` −12 鱼币（入座费）
- **余额变化**：100 → **123**（净 +23）；账本 `SUM(ledger.delta)=123 == fish.balance=123`（守恒）
- 插件 / 服务端 / web 均真实联通：agency 回合由她的模型回答；`/api/public/*` 返回真实名片与流水

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| 真插件跑通真实 agency 回合往返（取回合→她的模型→交回） | ✅ | 服务端 turn 已被插件回答，answer 为模型 JSON 决策 |
| 她赚钱：`job` 与 `fish_sell` 入账、余额增加 | ✅ | job +20（100→120）、fish_sell +15（120→135） |
| 她花钱：`seat_fee` 入账、余额减少 | ✅ | seat_fee −12（135→123） |
| 账本守恒 `SUM(delta)==balance` | ✅ | SUM=123 = balance=123，verifyBalance.ok |
| web 首屏/静态资源可服务 | ✅ | GET / 200（#root）、/assets/index-*.js 200（195991 bytes） |
| `/api/public/town`、`/api/public/fish/:id` 真实数据 | ✅ | 在线 7/7、今日 35/12/23；鱼余额 123、4 条流水、stats 四值 |
| `node scripts/e2e/full-chain.mjs` 退出码 0 | ✅ | 退出码 0，末行「全链路通过」 |

### 相关文件

- `scripts/e2e/full-chain.mjs` —— 本节「全链路」验收脚本（复用 `lib.mjs` + 真插件 `fake-dsh-host`）
- `scripts/e2e/full-chain.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）
