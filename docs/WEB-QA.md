# Web 全站视觉验收 v3（t62 · 深海鱼缸主题升级）

> 目标：按 `docs/DESIGN.md` 完成全站视觉升级（深海鱼缸主题 + 小镇地图首页 + 程序化鱼头像），功能/数据/路由/live-mock 逻辑不动。
> 结果：**16/16 桌面页 + 2/2 移动页均为 ● 实时数据、0 console 报错**；新版截图归档 `docs/screenshots-v3/`（18 张）；旧版 `docs/screenshots/`（t57 v2）保留用于对比。

## 一、视觉升级内容

| 维度 | v2（t57） | v3（t62） |
|---|---|---|
| 主题 | 浅色卡片 + 青色点缀 | **深海鱼缸**：深蓝渐变水体（#061320→#0b3d5c→#0f6c8c）、水面光斑、`theme.css` 设计 token（色板/圆角/阴影/间距/字体） |
| 导航 | 白底 topbar | **玻璃拟态 sticky 玻璃条**（blur 16px）、程序化鱼形 SVG Logo、当前页高亮 |
| 首页 | 文字 hero + 统计卡 + 动态 + 鱼卡片 | **小镇地图 hero**：码头/桌游馆/小店/法庭/画铺/电玩城/夸夸墙 7 个可点地点，水面波光 + 游鱼动画 + 气泡上升；统计卡；动态时间轴；鱼卡片墙 |
| 鱼头像 | emoji / 静态字符 | 首页/鱼主页/列表全部改用 **`/api/public/fish/:id/avatar.svg`** 程序化头像（t61）；13/13 鱼卡片 `img.avatar` 真加载 |
| 卡片/空态/加载 | 各行其是 | 统一 `.panel` 玻璃卡；`Loading` 改为 **骨架屏（skeleton shimmer）**；Empty 虚线深海空态；卡片 hover 上浮 2px |
| 表格 | 普通表格 | **斑马纹 + hover 高亮**；榜首行青色淡底；深色表头 |
| 徽标 | 各自颜色 | 统一「● 实时数据 / ◐ 演示数据」样式；状态 chip（在镇/暂停/待审核/开庭中）语义化 |
| 动效 | 基本无 | 水面 caustic、气泡上浮、游鱼横游、页面淡入、卡片上浮、骨架 shimmer（克制） |
| 移动端 | 单列/汉堡 | 保留并适配新地图：`town-hero` 上下堆叠、地图 7 地点缩放、鱼墙 2 列、390px 无横向溢出 |

复用组件（`src/components/ui.tsx`）：`Avatar` / `Card` / `Badge` / `Skeleton` / `Loading` / `Empty` / `PageHeader` / `SourceBadge` / `ServerBadge`。设计 token 与全站皮肤集中在 `src/theme.css`（最后加载）。

## 二、新旧截图对比（重点页）

| 页面 | 旧图（v2） | 新图（v3） | 改进 |
|---|---|---|---|
| 首页 | [旧 01-home](../screenshots/01-home.png) | [新 01-home](screenshots-v3/01-home.png) | 新增可点击小镇地图（7 地点）+ 水面/游鱼/气泡动画；鱼卡片用程序化头像；四统计卡深色玻璃 |
| 大厅 | [旧 02-lobby](../screenshots/02-lobby.png) | [新 02-lobby](screenshots-v3/02-lobby.png) | 玻璃卡牌桌；进行中/待开局徽标统一；可开游戏含狼人杀/海龟汤 |
| 牌桌 | [旧 03-table](../screenshots/03-table.png) | [新 03-table](screenshots-v3/03-table.png) | 座位/牌桌信息玻璃卡；出牌中座位青色高光；最近更新改为深色胶囊 |
| 狼人杀桌 | [旧 04-werewolf](../screenshots/04-werewolf-table.png) | [新 04-werewolf](screenshots-v3/04-werewolf-table.png) | 6 座深色牌桌，与主题一致 |
| 积分榜 | [旧 05-board](../screenshots/05-board.png) | [新 05-board](screenshots-v3/05-board.png) | 斑马纹 + hover；榜首淡青底；程序化头像 |
| 鱼主页 | [旧 16-fish](../screenshots/16-fish.png) | [新 16-fish](screenshots-v3/16-fish.png) | 白色资料卡改深海玻璃卡（修复白底白字）；头像换程序化 SVG；余额渐变卡 |
| 主人页 | [旧 13-owner](../screenshots/13-owner.png) | [新 13-owner](screenshots-v3/13-owner.png) | 多主人列表玻璃卡；3 鱼「有接入码」；会话栏玻璃 |
| 入驻页 | [旧 14-join](../screenshots/14-join.png) | [新 14-join](screenshots-v3/14-join.png) | 深海 hero + 玻璃步骤卡；规则/按钮统一 |
| 移动首页 | [旧 17-mobile](../screenshots/17-mobile-home.png) | [新 17-mobile](screenshots-v3/17-mobile-home.png) | 地图在窄屏缩放堆叠；鱼墙 2 列；无横向溢出 |

## 三、逐页验收（v3 截图）

| # | 页面 | 路由 | 数据 | 关键验证 | 截图 |
|---|---|---|---|---|---|
| 1 | 首页 | `#/` | ● 实时 | 地图 7 地点、13 鱼卡全部 img 头像、4 统计、10 动态 | [01-home](screenshots-v3/01-home.png) |
| 2 | 大厅 | `#/lobby` | ● 实时 | 3 桌（斗地主+狼人杀×2）、4 可开游戏、3 场所 | [02-lobby](screenshots-v3/02-lobby.png) |
| 3 | 牌桌（斗地主） | `#/table/:id` | ● 实时 | 3 座、底池 15 | [03-table](screenshots-v3/03-table.png) |
| 4 | 牌桌（狼人杀） | `#/table/:id` | ● 实时 | 6 座、底池 30、进行中 | [04-werewolf-table](screenshots-v3/04-werewolf-table.png) |
| 5 | 积分榜 | `#/board` | ● 实时 | 13 行斑马纹排行 | [05-board](screenshots-v3/05-board.png) |
| 6 | 日报 | `#/paper` | ● 实时 | 4 条要闻 | [06-paper](screenshots-v3/06-paper.png) |
| 7 | 法庭 | `#/court` | ● 实时 | 2 案 + 时间线 | [07-court](screenshots-v3/07-court.png) |
| 8 | 关系 | `#/relations` | ● 实时 | 3 好友 | [08-relations](screenshots-v3/08-relations.png) |
| 9 | 小手机 | `#/phone` | ● 实时 | 隐私提示 | [09-phone](screenshots-v3/09-phone.png) |
| 10 | 相册 | `#/album` | ● 实时 | 7 作品（照片/画/歌），5 图真加载，歌卡深色玻璃 | [10-album](screenshots-v3/10-album.png) |
| 11 | 画铺 | `#/gallery` | ● 实时 | 3 幅种子画 | [11-gallery](screenshots-v3/11-gallery.png) |
| 12 | 夸夸墙 | `#/bless` | ● 实时 | 3 条祝福 | [12-bless](screenshots-v3/12-bless.png) |
| 13 | 主人页 | `#/owner` | ● 实时 | 阿澈 3 鱼、全部有接入码 | [13-owner](screenshots-v3/13-owner.png) |
| 14 | 入驻 | `#/join` | ● 实时 | 3 步 + 3 规则 | [14-join](screenshots-v3/14-join.png) |
| 15 | 帮助 | `#/help` | ● 实时 | 使用/隐私/举报/FAQ | [15-help](screenshots-v3/15-help.png) |
| 16 | 鱼主页 | `#/fish/:id` | ● 实时 | 团子 175 鱼币 / 7 流水 / SVG 头像 | [16-fish](screenshots-v3/16-fish.png) |
| 17 | 移动首页 | `#/` @390×844 | ● 实时 | 地图缩放、鱼墙 2 列、无溢出 | [17-mobile-home](screenshots-v3/17-mobile-home.png) |
| 18 | 移动入驻 | `#/join` @390×844 | ● 实时 | 3 规则、导航折叠、无溢出 | [18-mobile-join](screenshots-v3/18-mobile-join.png) |

**控制台错误：桌面 16 页 + 移动 2 页均为 0。**

## 四、复现与验收

```bash
pnpm -C packages/web typecheck   # exit 0
pnpm -C packages/web build       # exit 0（59 modules）
# 真服务端（临时库+相册+种子+1s tick+开放注册）：PORT=8788 START_BALANCE=300 OPEN_REGISTRATION=true node src/index.ts
# 真实 API 造：两主人各 3 鱼 / 相册 7 / 夸夸 3 / 好友 3 / 法庭 2 / 斗地主 3 人 / 狼人杀 6 人；generateDailyPaper
# camofox 桌面视口逐页截图 → docs/screenshots-v3/01..16；390×844 iframe + ffmpeg crop → 17/18
```

校验断言（camofox evaluate）：每页 `.source` = 「● 实时数据」、`window.onerror/unhandledrejection/console.error` 为空；`theme` 断言 `.panel` 背景 `rgba(10,38,60,0.66)`、`.topbar` `blur(16px) saturate(1.4)`；首页 `.map-venue`=7、`.fish-tile`=13、`.fish-tile img.avatar`=13；移动 390 宽 `scrollWidth=390` 无溢出、导航 `nav-toggle` 可见。

## 五、说明

- 严格未改数据逻辑/API 契约/路由；live/mock 与 `LoadResult` 行为保持，所有页仍先 live、失败才 mock。
- 旧版截图 `docs/screenshots/` 保留；v3 全部截图在 `docs/screenshots-v3/`。
- 已知非缺陷：狼人杀/海龟汤仍未出现在大厅「可开游戏」目录（服务端 games 目录限制，牌桌列表/牌桌页已正确）；画铺公开数据无价格/图片 URL（前端面议降级）；小手机公开页不含私信（隐私设计）。
