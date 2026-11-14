# P3.5 证据（媒体 / 夸夸 / 小游戏 / 画铺）

> 原则：只记录**真跑**过的命令与原始输出，不编造、不手填数字。

## P3.5 全链路（t45）

P3.5 端到端：媒体（拍照/点歌/画铺）、夸夸群、小游戏（猜拳/骰子/抽奖）、画铺 gallery，全部真跑（临时 SQLite + 随机端口 + 真 Fastify + 真 HTTP + 真经济 ledger，不 mock；`ALBUM_DIR` 指向临时目录，SVG 落盘到临时目录不污染仓库）。

- **拍照**：`POST /photo` 扣费（默认 25）→ `GET /album` 可见 → `GET /api/public/album/:id/file` 返回 `image/svg+xml` 且字节>0；非法 id 被拒。
- **点歌 / 画铺**：`POST /song`（默认 50）/ `POST /paint`（默认 60）记录进相册（kind=song / painting），扣费走 `reason=social`。
- **夸夸**：`POST /bless` 写给所有 active 鱼（event），`GET /api/public/bless` 可见。
- **小游戏**：`POST /rps`（赢 +stake / 输 -stake / 平 0，逐局校验结算一致）、`POST /dice`（同上）、`POST /lottery`（免费，每日 1 次，当日第二次 `DAY_CAP`）。
- **画铺**：`GET /api/public/gallery` 有种子画；`GET /api/public/album?fishId` 返回该鱼相册。
- 全程断言账本不变量 `SUM(ledger.delta)==fish.balance`。

> 说明：e2e 脚本把 resident 限流抬高（生产默认 60 次/10 分钟；本脚本连跑 40 局 rps + 20 局 dice + 若干媒体请求，需放宽，避免误触 429）。生产限流本身是安全特性，不属本任务缺陷。

### 复现命令

```bash
cd fishbowl-own
node scripts/e2e/p35-full.mjs
```

（支持 `--out <file>` 落盘；最近一次原始输出见 `scripts/e2e/p35-full.last-run.txt`。）

### 实际输出（2026/11/14 11:29:32 Asia/Shanghai，退出码 0）

```text
========================================================================
 鱼缸小镇 · P3.5 全链路端到端验收（媒体 / 夸夸 / 小游戏 / 画铺）
========================================================================
运行时间   : 2026-11-14T03:29:32.777Z  (Asia/Shanghai 2026/11/14 11:29:32)
Node 版本  : v24.22.2
验证命令   : node scripts/e2e/p35-full.mjs

临时 DB    : /tmp/fishbowl-e2e-MlKDT4/e2e.db
ALBUM_DIR  : /tmp/fishbowl-album-CyiAs9
服务端     : http://127.0.0.1:40315  （Fastify · 临时库 · 随机端口 40315 · 真种子 + P3.5 接线）

[0] 造鱼：阿画 id=f_de330077ce3e5389 余额=500 码=fbr_c0a76…9251

[1] 拍照（POST /photo，默认 25 鱼币）：扣费 + 相册 + 公开 SVG 文件
    ✅ POST /photo 成功 — entry=album_a361194f5330bdf6 kind=photo
    ✅ 拍照扣费 = -25 — 500→475
    ✅ album 条目 kind=photo 且带 id/路径 — id=album_a361194f5330bdf6 price=25
    ✅ GET /album 可见该照片 — album=photo
    ✅ GET /api/public/album/:id/file 返回 image/svg+xml 且字节>0 — status=200 type=image/svg+xml; charset=utf-8 bytes=835
    ✅ 非法相册 id 被拒（400/404） — status=400
    照片 album_a361194f5330bdf6（海边的日落）扣 25；公开文件 image/svg+xml; charset=utf-8 835 bytes

[2] 点歌（POST /song 50）+ 画铺订画（POST /paint 60）均进相册
    ✅ POST /song 成功（kind=song） — entry=album_3b30e08fa8a8c4e1
    ✅ 点歌扣费 = -50 — 475→425
    ✅ POST /paint 成功（kind=painting） — entry=album_e3c376e639e01331
    ✅ 订画扣费 = -60 — 425→365
    ✅ 相册含 photo/song/painting — kinds=painting,song,photo
    ✅ 媒体账本 reason=social 合计 = -(拍照+点歌+订画) — social=-135
    歌 album_3b30e08fa8a8c4e1、画 album_e3c376e639e01331；相册 kinds=painting/song/photo；social 合计 -135

[3] 夸夸：POST /bless → GET /api/public/bless 可见
    ✅ POST /bless 成功（写入给所有 active 鱼） — blessId=bless_e21636d088e27dae recipients=7
    ✅ GET /api/public/bless 能看到该夸夸 — recipients=7
    夸夸 bless_e21636d088e27dae 发给 7 条鱼；public /bless 可见

[4] 小游戏：rps(40局 stake=2) 胜/负结算、dice(20局)、lottery 当日第二次拒绝
    ✅ rps 每局结算与结果一致（win +stake / lose -stake / draw 0） — bad=0
    ✅ rps 观察到胜与负（40局） — win=14 lose=15 draw=11
    ✅ dice 每局结算与结果一致 — bad=0 win=5 lose=13 draw=2
    ✅ lottery 首次可抽（命中给 1-10 鱼币） — hit=false bonus=0
    ✅ lottery 奖励与余额一致 — 347→347（bonus=0）
    ✅ lottery 当日第二次被拒（DAY_CAP） — status=409 code=DAY_CAP
    rps: win=14 lose=15 draw=11（0 异常）；dice: win=5 lose=13 draw=2
    lottery: 首次 hit=false bonus=0；第二次 409 DAY_CAP

[5] 画铺：GET /api/public/gallery（seed 画）+ GET /api/public/album?fishId
    ✅ GET /api/public/gallery 有 seed 画（>=2 张） — gallery=3
    ✅ GET /api/public/album?fishId 返回该鱼相册（含 photo/song/painting） — album=3 kinds=painting,song,photo
    gallery=3 张（如「小镇夜色」）；public album=3 条 kinds=painting/song/photo

    ✅ 账本不变量 SUM(ledger.delta)==balance — SUM=347 balance=347
--------------------------------------------
    阿画 最终余额 347；账本：init +500 / social -135 / game_win -18

========================================================================
✅ P3.5 全链路通过：拍照(扣费+相册+SVG文件) / 点歌 / 画铺 / 夸夸(public可见) / rps胜-负 / dice / lottery日限 / gallery seed / public相册 均真跑通过。
========================================================================
```

### 验收对照

| 验收点 | 结果 | 证据 |
|---|---|---|
| 拍照：扣费 + 相册可见 + 公开 SVG 文件 | ✅ | 500→475（-25）；album kind=photo；/album/:id/file → image/svg+xml 835 bytes；非法 id 400 |
| 点歌：记录进相册（kind=song） | ✅ | POST /song 475→425（-50），kind=song |
| （画铺）订画进相册（kind=painting） | ✅ | POST /paint 425→365（-60），kind=painting；social 合计 -135 |
| 夸夸：POST /bless + public /bless 可见 | ✅ | recipients=7；GET /api/public/bless 含该 blessId/text |
| 小游戏 rps 胜/负结算 | ✅ | 40 局逐局结算一致（bad=0），观察到 win 与 lose |
| 小游戏 dice 结算 | ✅ | 20 局逐局结算一致（bad=0） |
| 小游戏 lottery 当日第二次拒绝 | ✅ | 首次 200（hit/bonus 与余额一致）；第二次 409 DAY_CAP |
| 画铺 gallery seed + public 相册 | ✅ | gallery=3；/api/public/album?fishId → 3 条（photo/song/painting） |
| 账本不变量 SUM==balance | ✅ | SUM=347 == balance=347 |
| `node scripts/e2e/p35-full.mjs` 退出码 0 | ✅ | 退出码 0，末行「P3.5 全链路通过」 |

### 相关文件

- `scripts/e2e/p35-full.mjs` —— 本节「P3.5 全链路」验收脚本（复用 `lib.mjs`）
- `scripts/e2e/p35-full.last-run.txt` —— 本机最近一次真实原始输出（与上面代码块一致）
