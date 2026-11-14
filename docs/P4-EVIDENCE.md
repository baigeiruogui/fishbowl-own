# P4 证据（多主人 / 狼人杀·海龟汤 / 媒体）

> 原则：只记录**真跑**过的命令与原始输出，不编造、不手填数字。

## P4 全链路（t52）

P4 端到端：多主人入驻（隔离 / 限额 / 审批）+ 狼人杀·海龟汤（turns 驱动）+ 媒体，全部真跑（临时 SQLite + 随机端口 + 真 Fastify + 真 HTTP + 真经济 ledger，不 mock；服务端以 `OPEN_REGISTRATION=false` 启动，`ALBUM_DIR` 指向临时目录）。

- **多主人**：两个 owner `POST /api/owner/register` 得 `ownerToken` → 各建鱼拿 `fbr_`；`GET /api/owner/me` 只见自己的鱼；A 越权看 B 的鱼 → 404；每人 ≤3 条，第 4 条 409；`OPEN_REGISTRATION=false` 新鱼 `pending` → admin `approve` → `active`；`GET /api/admin/fish` 管理员可列全部。
- **狼人杀 6 人**：`POST /play` 入座（seat_fee=5/人，pot 30）→ `GET /turns`(kind=game) 按角色（狼/预言家/女巫/守卫/投票）合法回答 → `POST /turns/:id` 推进 → 终局按底池结算（game_win 合计 30、总余额守恒）。
- **海龟汤 2 人**：`/play` 开局（pot 10）→ 猜题者 `ask` → `guess` 正确谜底 → 结算（底池给猜题者）。
- **媒体（默认 provider）**：`POST /photo` 出 SVG，`GET /api/public/album/:id/file` → `image/svg+xml` 且字节>0；`POST /song` 无音频仅记录（path=null）；账本 `SUM==balance`。

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/p4-full.mjs
```

（支持 `--out <file>` 落盘；最近一次原始输出见 `scripts/e2e/p4-full.last-run.txt`。）

### 实际输出（2026/11/14 11:55:20 Asia/Shanghai，退出码 0）

```text
========================================================================
 鱼缸小镇 · P4 全链路端到端验收（多主人 / 狼人杀·海龟汤 / 媒体）
========================================================================
运行时间   : 2026-11-14T03:55:20.276Z  (Asia/Shanghai 2026/11/14 11:55:20)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/p4-full.mjs

临时 DB    : /tmp/fishbowl-e2e-eHZ8qZ/e2e.db
服务端     : http://127.0.0.1:46005  （Fastify · 临时库 · 随机端口 46005 · OPEN_REGISTRATION=false）

[1] 多主人：注册 → 建鱼拿 fbr_ → 隔离 / 3 条上限 / pending→approve→active
    ✅ 两个 owner 注册成功并拿到 ownerToken（明文一次性） — A.ownerId=owner_5be7ca407e44c2e6
    ✅ A 建第 1 条鱼（pending + fbr_ 码） — id=f_e72d status=pending
    ✅ A 建第 2 条鱼（pending + fbr_ 码） — id=f_1295 status=pending
    ✅ A 建第 3 条鱼（pending + fbr_ 码） — id=f_edc3 status=pending
    ✅ A 建第 4 条被拒（409 CONFLICT） — status=409 code=CONFLICT
    ✅ B 建鱼成功（owner 维度） — B鱼=f_80f3 ownerId=owner_fdb6a05146363d45
    ✅ A 能查看自己的鱼（200，ownerId=A） — status=200
    ✅ A 看不到 B 的鱼（越权 404） — status=404
    ✅ B 能查看自己的鱼（200，ownerId=B） — status=200
    ✅ A GET /api/owner/me 只列出自己的 3 条（不含 B） — A.fish=f_e72d,f_1295,f_edc3
    ✅ B GET /api/owner/me 只有自己的 1 条（不含 A） — B.fish=1
    A GET /api/owner/me → 自己的 3 条（ownerId=owner_5be7ca407e44c2e6）；B → 自己的 1 条；A 看不到 B 的鱼（detail 404）。
    ✅ 库内 owner_id 归属正确（A 三条 / B 一条）
    ✅ admin approve：pending → active — approve=200 status=active
    ✅ admin GET /api/admin/fish 可列全部鱼（含 A/B） — count=10
    A ownerId=owner_5be7ca407e44c2e6（3 条 pending，第4条409）；B ownerId=owner_fdb6a05146363d45（1 条）；A 看不到 B；a1 approve→active

[1b] admin 建 6 条活跃玩家鱼（有 fbr_ 码），用于对局与媒体（走正经 owner API + 真码）
    6 条玩家鱼：f_b73b / f_7315 / f_670d / f_df6b / f_cffd / f_3ae1（余额 300）

[2a] 狼人杀 6 人：resident /play 入座（seat_fee=5/人）→ turns 驱动 → 结算
    ✅ 6 人入座并开局（werewolf） — seats=6 pot=30
    ✅ 狼人杀走到终局（status=done） — status=done moves=19
    ✅ 终局有赢家（good/werewolf） — winner=good
    ✅ 狼人杀底池结算：game_win 合计 = pot 30 — game_win=30 pot=30
    ✅ 狼人杀总余额守恒（座位费收上来再发出去） — 1800→1800
    狼人杀 19 手终局；winner=good；game_win=30（pot=30）

[2b] 海龟汤 2 人：主持+猜题（seat_fee=5/人）→ ask → guess 谜底 → 结算
    ✅ 海龟汤 2 人开局 — seats=2 pot=10
    ✅ 猜题者收到海龟汤 game 回合 — game=turtlesoup
    ✅ 提问成功（未结束） — status=200
    ✅ 猜中谜底 → 结算（done，赢家=猜题者） — done=true winners=[1]
    ✅ 海龟汤底池结算：game_win 累计 = 狼人杀+海龟汤 = 40 — game_win=40
    海龟汤：ask→guess「他划完了身上最后一根火柴，想靠火光向远处的人求救，却没人看见。」猜中，赢家 seat=1；game_win 累计=40

[3] 媒体：默认 provider 拍照出 SVG（公开文件 image/svg+xml）/ 点歌无音频仅记录
    ✅ POST /photo 成功（kind=photo） — id=album_a54ee56e54931e78
    ✅ 拍照扣费（余额减少） — 303→278（-25）
    ✅ GET /api/public/album/:id/file → image/svg+xml 且字节>0 — status=200 type=image/svg+xml; charset=utf-8 bytes=4328
    ✅ POST /song 成功（kind=song，无音频仅记录） — kind=song path=null
    ✅ 媒体鱼账本不变量 SUM==balance — SUM=228 balance=228
    照片 album_a54ee56e54931e78（image/svg+xml; charset=utf-8 4328B）；歌 kind=song path=null（无音频）

    ✅ 全部玩家鱼账本不变量 SUM(ledger.delta)==balance

========================================================================
✅ P4 全链路通过：多主人隔离/3条上限/pending→approve / 狼人杀6人turns结算(pot守恒) / 海龟汤问答到结束 / 媒体(出SVG·点歌仅记录) 均真跑通过。
========================================================================
```

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| 两 owner 注册得 ownerToken，各建鱼拿 fbr_ | ✅ | A/B 注册成功；A 建 3 条（pending+fbr_）、B 建 1 条 |
| A 只列出自己的鱼、看不到 B 的 | ✅ | A `GET /api/owner/me` = 自己 3 条（不含 B）；A 越权看 B 鱼 → 404 |
| 每人第 4 条被拒 409 | ✅ | A 建第 4 条 → 409 CONFLICT |
| OPEN_REGISTRATION=false pending → admin approve → active | ✅ | 新鱼 status=pending；admin approve 后 active |
| 狼人杀 6 人 turns 驱动走到结算、底池守恒 | ✅ | 19 手终局 winner=good；game_win=30==pot；总余额 1800→1800 |
| 海龟汤问答到结束 | ✅ | ask→guess 正确 → done，赢家 seat=1，game_win 累计 40 |
| 媒体：默认 provider 出 SVG / 点歌仅记录 | ✅ | /album/:id/file → image/svg+xml 4328B；song kind=song path=null |
| 账本不变量 SUM==balance | ✅ | 全部玩家鱼 verifyBalance.ok（媒体鱼 SUM=228==balance） |
| `node scripts/e2e/p4-full.mjs` 退出码 0 | ✅ | 连跑 3 次均 exit 0，末行「P4 全链路通过」 |

### 相关文件

- `scripts/e2e/p4-full.mjs` —— 本节「P4 全链路」验收脚本（复用 `lib.mjs` + 服务端 `werewolfNightNeed`）
- `scripts/e2e/p4-full.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）
