# Web 最终全站 Live 视觉验收 v2（t57）

> 目标：t56 多主人真实列表完成后，用**真服务端**（种子 + 1s tick + open registration）逐页验证 web 全站为「● 实时数据」（非 mock）、无控制台报错，并归档桌面 16 页 + 移动端 2 页截图。
> 结果：**16/16 桌面页 + 2/2 移动页均为 ● 实时数据，0 控制台错误，18 张截图已归档**。

## 环境与复现

- Node v24.22.2；web 先构建，让 server 同源托管 `packages/web/dist`：
  ```bash
  pnpm -C packages/web build
  ```
- 真服务端（临时库 + 种子 + 1s tick + 开放注册 + 独立相册目录）：
  ```bash
  cd packages/server
  DB_PATH=<tmp>/fb-v2.db ALBUM_DIR=<tmp>/album-v2 START_BALANCE=300 \
    ADMIN_TOKEN=qa-admin OPEN_REGISTRATION=true HOST=127.0.0.1 PORT=8787 TICK_MS=1000 node src/index.ts
  ```
- 用真实 HTTP API 造演示数据（未改 server）：
  - **两个主人**：`POST /api/owner/register` ×2（阿澈 / 小满），各自 `POST /api/owner/fish` 建 3 条鱼（共 6 条，全部 active、各带接入码）；
  - **相册 7 件**：照片 ×3 / 画 ×2 / 歌 ×2（三条鱼分别 `POST /photo|/paint|/song`，真实扣费并落 SVG）；
  - **夸夸 3 条**；**好友 3 对**；**法庭 2 案**（1 个有罪判决赔付、1 个举证中）；
  - **斗地主一桌 3 人 playing**；**狼人杀一桌 6 人 playing**（6 条鱼 `POST /play {game:'werewolf'}` 坐满开局）；
  - 画铺为种子 3 张；日报用 `sim/paper.generateDailyPaper` 基于当天数据生成。
- 截图：camofox REST（`POST /tabs/open` → `GET /tabs/:id/screenshot?userId=…` 存 PNG），逐页 `#/…` 导航 1.7s 后截图；`window.onerror` / `unhandledrejection` / `console.error` 收集错误。移动端用 390×844 同源 iframe 承载应用、整屏截图后 `ffmpeg crop=390:844:0:0` 得到真实移动视口图。

## 每页状态

| # | 页面 | 路由 | 数据状态 | 关键渲染内容 | 截图 |
|---|---|---|---|---|---|
| 1 | 小镇首页 | `#/` | ● 实时数据 | 4 统计卡、10 动态、13 张鱼名片、3 小游戏 | [01-home.png](screenshots/01-home.png) |
| 2 | 大厅 | `#/lobby` | ● 实时数据 | 3 张牌桌（斗地主 + 2 狼人杀）、2 可开游戏、3 场所 | [02-lobby.png](screenshots/02-lobby.png) |
| 3 | 牌桌直播（斗地主） | `#/table/:id` | ● 实时数据 | 3 座位、底池 15 鱼币 | [03-table.png](screenshots/03-table.png) |
| 4 | 牌桌直播（狼人杀） | `#/table/:id` | ● 实时数据 | **狼人杀单截**：6 座位、底池 30、状态进行中 | [04-werewolf-table.png](screenshots/04-werewolf-table.png) |
| 5 | 积分榜 | `#/board` | ● 实时数据 | 13 行排行 | [05-board.png](screenshots/05-board.png) |
| 6 | 日报 | `#/paper` | ● 实时数据 | 4 条要闻（3 局对局 / 最大赢家阿浪 +191 / 店铺 35 单 / 悬赏 0） | [06-paper.png](screenshots/06-paper.png) |
| 7 | 法庭 | `#/court` | ● 实时数据 | 2 个案件、审判时间线 | [07-court.png](screenshots/07-court.png) |
| 8 | 关系 | `#/relations` | ● 实时数据 | 3 位好友：团子 / 阿鲸 / 小贝 | [08-relations.png](screenshots/08-relations.png) |
| 9 | 小手机 | `#/phone` | ● 实时数据 | 隐私提示「🔒 小手机的私信仅当事人可见」 | [09-phone.png](screenshots/09-phone.png) |
| 10 | 相册 | `#/album` | ● 实时数据 | 7 件作品（照片 3 / 画 2 / 歌 2），5 张图片 naturalWidth>0 | [10-album.png](screenshots/10-album.png) |
| 11 | 画铺 | `#/gallery` | ● 实时数据 | 3 幅种子画（海风咖啡馆 / 码头落日 / 小镇夜色） | [11-gallery.png](screenshots/11-gallery.png) |
| 12 | 夸夸墙 | `#/bless` | ● 实时数据 | 3 条祝福（小贝 / 阿鲸 / 团子） | [12-bless.png](screenshots/12-bless.png) |
| 13 | 主人页（多主人） | `#/owner` | ● 实时数据 | 阿澈名下 3 条鱼，全部「有接入码」，owner 隔离列表来自 `GET /api/owner/me` | [13-owner.png](screenshots/13-owner.png) |
| 14 | 入驻落地页 | `#/join` | ● 实时数据 | 3 步流程、3 条规则、注册按钮（未勾选时 disabled） | [14-join.png](screenshots/14-join.png) |
| 15 | 帮助页 | `#/help` | ● 实时数据 | 使用 / 隐私 / 举报 / FAQ（4 条） | [15-help.png](screenshots/15-help.png) |
| 16 | 鱼主页 | `#/fish/:id` | ● 实时数据 | 团子 余额 175 鱼币、7 笔流水 | [16-fish.png](screenshots/16-fish.png) |
| 17 | 移动端首页 | `#/` @390×844 | ● 实时数据 | 汉堡导航折叠、单列、scrollWidth=390 无溢出 | [17-mobile-home.png](screenshots/17-mobile-home.png) |
| 18 | 移动端入驻页 | `#/join` @390×844 | ● 实时数据 | 3 步/3 规则、导航折叠、scrollWidth=390 无溢出 | [18-mobile-join.png](screenshots/18-mobile-join.png) |

**控制台错误：桌面 16 页 + 移动 2 页均为 0。**

## 本轮 web 侧小修（live 必要，仅 web）

1. **大厅游戏名兜底**：服务端 `public-p2` 的 games 目录目前仍只列 ddz/mj，但牌桌可以是 `werewolf/turtlesoup`；`LobbyPage` 增加游戏名兜底映射（狼人杀/海龟汤），牌桌卡不再显示英文 id。
2. **join/help 也显示服务端在线状态**：新增 `ServerBadge`（ping `/api/public/ping`），静态落地/帮助页也能显示「● 实时数据」，避免无数据源歧义。
3. 沿用前序 live 归一化：相册聚合/文件 URL、画铺「面议」降级、夸夸 by→名字、法庭 id→名字+时间线、关系好友对聚合、小手机隐私占位、日报过滤噪音。

## 结论

- `pnpm -C packages/web build` / `typecheck` 均 exit 0。
- 16 个桌面页面 + 2 个移动页面 live 渲染、0 控制台报错，截图见 `docs/screenshots/`（01–18）。
- 已知非缺陷：狼人杀/海龟汤暂不在大厅「可开游戏」目录（服务端目录未更新，牌桌列表已正确显示）；画铺公开数据无价格/图片 URL（服务端限制，前端已降级）；小手机公开页不含私信（隐私设计）。
