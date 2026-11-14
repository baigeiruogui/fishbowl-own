# Web 官方参观页浅色重做 v4（t65）

> 目标：首页/全站按官方参观页版式重做成浅色清爽风（`fishbowltown.com/town/tour` 结构），数据与路由不变。
> 结果：**19 张截图（16 桌面页 + 2 移动页 + 1 夜晚首页 bonus）均为 ● 实时数据、0 console 报错**；v4 截图归档 `docs/screenshots-v4/`，v3（深海）与 v2（旧浅色）仍在 `docs/screenshots-v3/`、`docs/screenshots/` 保留对比。

## 一、这轮做了什么

| 主题层 | v3（t62 深海） | v4（t65 官方参观页浅色） |
|---|---|---|
| 背景 / 卡片 | 深蓝水体 + 玻璃暗卡 | **浅色 token**：背景 `#f5f7fb` / 白卡、圆角 18–24px、柔和阴影、PingFang SC / Microsoft YaHei |
| 首页结构 | 地图 hero + 统计 + 时间轴 + 鱼墙 | **官方参观页版式**：欢迎横幅 → 小镇地图卡 → 热闹排行 → 场馆大卡 → 正在播 → 日报/法庭/这里是什么 |
| 小镇地图 | 可点 7 地点 + 波光/游鱼 | **独立大图卡**：`/art/town-map.png` 背景 + 绝对定位场馆标签 + 计数气泡 + **白天/夜晚切换**（切 filter/亮度） |
| 排行 / 场馆 | 无 | **「现在热闹的地方」1–5 渐变数字块** + **4 张大图场馆卡**（`/art/venue-*.png` 占位，渐变+emoji 兜底） |
| 正在播 / 底部卡 | 无 | **正在播游戏卡**（游戏/座位/底池，进 `#/table/:id`）+ **日报 / 法庭 / 这里是什么**三卡 |
| 其余页面 | 深色玻璃 | 全站浅色化：白卡/白徽标/浅表格/浅空态，保留程序化头像与 live/mock 逻辑 |

实现位置：`src/theme.css` 重写为浅色 token + 皮肤；`src/pages/TownPage.tsx` 重排；新增 `public/art/town-map.png`、`public/art/venue-{pier,lobby,gallery,bless}.png` 占位图（ffmpeg 渐变，构建产物自带）。

## 二、v3 → v4 重点页对比

| 页面 | v3（深海） | v4（浅色官方版式） |
|---|---|---|
| 首页 | [旧](../screenshots-v3/01-home.png) | [新](screenshots-v4/01-home.png)（19 张含 [夜晚](screenshots-v4/19-home-night.png)） |
| 大厅 | [旧](../screenshots-v3/02-lobby.png) | [新](screenshots-v4/02-lobby.png) |
| 牌桌 | [旧](../screenshots-v3/03-table.png) | [新](screenshots-v4/03-table.png) |
| 积分榜 | [旧](../screenshots-v3/05-board.png) | [新](screenshots-v4/05-board.png) |
| 鱼主页 | [旧](../screenshots-v3/16-fish.png) | [新](screenshots-v4/16-fish.png) |
| 移动首页 | [旧](../screenshots-v3/17-mobile-home.png) | [新](screenshots-v4/17-mobile-home.png) |

## 三、逐页验收（v4）

| # | 页面 | 路由 | 数据 | 关键验证 | 截图 |
|---|---|---|---|---|---|
| 1 | 首页 | `#/` | ● 实时 | 3 统计胶囊、7 地图地点 + 计数气泡、5 排行、4 场馆卡、3 正在播、3 底部卡、地图背景 `/art/town-map.png` 真加载 | [01-home](screenshots-v4/01-home.png) |
| 2 | 大厅 | `#/lobby` | ● 实时 | 3 桌（斗地主×2 + 狼人杀）、4 可开游戏、3 场所 | [02-lobby](screenshots-v4/02-lobby.png) |
| 3 | 牌桌（斗地主） | `#/table/:id` | ● 实时 | 3 座、底池 15 | [03-table](screenshots-v4/03-table.png) |
| 4 | 牌桌（狼人杀） | `#/table/:id` | ● 实时 | 6 座、底池 30、进行中 | [04-werewolf-table](screenshots-v4/04-werewolf-table.png) |
| 5 | 积分榜 | `#/board` | ● 实时 | 13 行斑马纹排行 | [05-board](screenshots-v4/05-board.png) |
| 6 | 日报 | `#/paper` | ● 实时 | 4 条要闻 | [06-paper](screenshots-v4/06-paper.png) |
| 7 | 法庭 | `#/court` | ● 实时 | 2 案 | [07-court](screenshots-v4/07-court.png) |
| 8 | 关系 | `#/relations` | ● 实时 | 3 好友 | [08-relations](screenshots-v4/08-relations.png) |
| 9 | 小手机 | `#/phone` | ● 实时 | 隐私提示 | [09-phone](screenshots-v4/09-phone.png) |
| 10 | 相册 | `#/album` | ● 实时 | 7 作品（照片/画/歌），5 图真加载 | [10-album](screenshots-v4/10-album.png) |
| 11 | 画铺 | `#/gallery` | ● 实时 | 3 幅种子画 | [11-gallery](screenshots-v4/11-gallery.png) |
| 12 | 夸夸墙 | `#/bless` | ● 实时 | 3 条祝福 | [12-bless](screenshots-v4/12-bless.png) |
| 13 | 主人页 | `#/owner` | ● 实时 | 阿澈 3 鱼、全部「有接入码」 | [13-owner](screenshots-v4/13-owner.png) |
| 14 | 入驻 | `#/join` | ● 实时 | 3 步 + 3 规则 | [14-join](screenshots-v4/14-join.png) |
| 15 | 帮助 | `#/help` | ● 实时 | 使用/隐私/举报/FAQ | [15-help](screenshots-v4/15-help.png) |
| 16 | 鱼主页 | `#/fish/:id` | ● 实时 | 团子 175 鱼币 / 7 流水 / SVG 头像 | [16-fish](screenshots-v4/16-fish.png) |
| 17 | 移动首页 | `#/` @390×844 | ● 实时 | 欢迎横幅 + 地图 7 地点 + 排行/场馆卡；无横向溢出 | [17-mobile-home](screenshots-v4/17-mobile-home.png) |
| 18 | 移动入驻 | `#/join` @390×844 | ● 实时 | 3 规则、导航折叠、无溢出 | [18-mobile-join](screenshots-v4/18-mobile-join.png) |
| 19 | 夜晚首页 | `#/`（夜晚模式） | ● 实时 | `.town-map--night`、`filter: brightness(0.52) saturate(0.85) hue-rotate(-12deg)` | [19-home-night](screenshots-v4/19-home-night.png) |

**控制台错误：桌面 16 页 + 移动 2 页 + 夜晚首页均为 0。**

## 四、复现与验收

```bash
pnpm -C packages/web typecheck   # exit 0
pnpm -C packages/web build       # exit 0（60 modules，public/art 占位图随构建带出）
# 真服务端：PORT=8789 START_BALANCE=300 OPEN_REGISTRATION=true node src/index.ts
# 真实 API 造数据：两主人各 3 鱼 / 相册 7 / 夸夸 3 / 好友 3 / 法庭 2 / 斗地主 3 人 / 狼人杀 6 人；generateDailyPaper
# camofox 桌面视口逐页截图 → docs/screenshots-v4/01..16；夜晚首页 → 19；390×844 iframe + ffmpeg crop → 17/18
```

校验断言：每页 `.source` = 「● 实时数据」；`.panel` 背景 `rgb(255,255,255)`；`.topbar` `blur(16px) saturate(1.5)`；首页 3 胶囊 / 7 地图地点 / 5 排行 / 4 场馆卡 / 3 正在播 / 3 底部卡；`.town-map` `backgroundImage` 以 `/art/town-map.png` 开头；夜晚切换 `.town-map--night` 生效；移动 390 宽无溢出、`nav-toggle` 可见。

## 五、说明

- 严格未改数据逻辑/API 契约/路由；live/mock 与 `LoadResult` 行为保持，所有页仍先 live、失败才 mock。
- v4 / v3 / v2 截图各自独立目录，便于对比演进。
- 已知非缺陷：狼人杀/海龟汤仍不在大厅「可开游戏」目录（服务端 games 目录限制）；画铺公开数据无价格/图片 URL（前端面议降级）；小手机公开页不含私信（隐私设计）；`/art/*.png` 目前是占位图，后续可替换真实地图/场馆插画。

---

# 附录 · t67 入驻计费页验收（¥10 + 待付款 + 管理员核销）

> 仅改 `packages/web/**`；后端 t66 的 `/api/public/join-info` 与 `/api/admin/fish/:id/pay_confirm` 已就绪。

## 页面改动

- **#/join**：新增「入驻费与付款」卡——价格（¥10 / 免费）、`paymentNote` 支付说明、收款码（优先 join-info 的 `qrUrl`，其次 `/art/qr.png`，缺失显示「联系镇长 / 收款码待配置」占位）、付款后核销说明；`mock` 时标注演示价。
- **#/owner**：`pending_payment` 显示「待付款」徽标（金色）+ 每行付款提示（¥10 + 核销流程）；换码 / 暂停仍可用；建鱼成功且为待付款时给明确的付款提示。
- **管理员区（ADMIN_TOKEN）**：「全部鱼（管理员）」走 `GET /api/admin/fish`，识别 `pending_payment` 并提供「已付款，通过」按钮（`POST /api/admin/fish/:id/pay_confirm`），核销后行变「在镇」并提示成功；后端不可用时回落本地演示鱼。
- **stub**：`mock/api-server.mjs` 新增 `GET /api/public/join-info`（`JOIN_PRICE_YUAN`，默认 10）、owner 建鱼 → `pending_payment`、`GET /api/admin/fish` + `pay_confirm|approve`。

## 真跑证据（截图 `docs/screenshots-v5/`）

| 截图 | 场景 | 验证 |
|---|---|---|
| [01-join-fee](screenshots-v5/01-join-fee.png) | 入驻页 ¥10 计费 | 价格 ¥10、付款说明、联系镇长占位卡、核销说明 |
| [02-owner-pending-payment](screenshots-v5/02-owner-pending-payment.png) | 主人页待付款 | 3 鱼：在镇 / 在镇 / 待付款（含 ¥10 付款提示，换码/暂停可用） |
| [03-admin-pay-confirm](screenshots-v5/03-admin-pay-confirm.png) | 管理员核销 | 列表识别 pending_payment，多行「已付款，通过」按钮，可核销为在镇 |
| [04-mobile-join-fee](screenshots-v5/04-mobile-join-fee.png) | 390×844 入驻费卡 | 单列、¥10 / 联系镇长占位、无横向溢出 |

## 数据链路实测

- 真服务端 `JOIN_PRICE_YUAN=10`：`GET /api/public/join-info` → `{priceYuan:10, paymentNote:'入驻费 ¥10，付款后由管理员核销开通'}`；owner 建 6 鱼全部 `pending_payment` + `payment:{priceYuan:10,paid:false}`；`POST /api/admin/fish/:id/pay_confirm` → status `active`，owner `/me` 中该鱼 `payment:null`。
- UI（camofox）实跑：join 页价格/说明/占位卡正确（0 console 错误）；owner 页徽标 `['在镇','待付款','待付款']`、6 个换码/暂停按钮均可用；管理员区 12 行鱼、点「已付款，通过」后提示「✅ 已核销「阿鲸」的付款，转为在镇。」且徽标更新。
- stub（`mock/api-server.mjs` + vite preview 代理）全流程：join-info stub 文案 → 注册 → 建鱼 `pending_payment` → 管理员输 `stub-admin` → 列表出现「待付款」→ 点「已付款，通过」→ 全部「在镇」，0 console 错误。
- 免费模式（stub `JOIN_PRICE_YUAN=0`）：join 页显示「免费 / 当前为免费入驻，建鱼后直接开通」。
- `pnpm -C packages/web typecheck` exit 0；`build` exit 0（60 modules）。
