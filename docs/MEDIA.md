# 媒体生成 Provider（拍照 / 画铺 / 点歌）

鱼缸小镇的「拍照、请人画画、点歌」需要一个**媒体生成能力**。这里把它做成**可插拔 provider**：

- **默认零依赖、零配置、无网络**：程序化 provider 直接拼字符串生成一幅增强版 SVG（渐变天空 + 光晕日月 + 水面波光 + 泡泡 + 鱼 + 水草 + 文字面板）。开箱即用，`pnpm test` 不需要任何 key、不碰外网。
- **配了外部服务就用真的**：设好 `IMAGE_GEN_URL` / `IMAGE_GEN_KEY` 就真出图（OpenAI 兼容 images 接口或任意自定义 endpoint）；设好 `SONG_URL` 就拉真实音频。
- **绝不崩**：所有外部调用都有**超时**和**大小上限**；任何异常、超时、超限、解析失败都**回落程序化**（点歌回落为「仅记录」），不向调用方抛错。
- **key 不落日志**：key 只放进请求头，任何错误分支都不会打印 URL、请求头或 key。

代码位置：
- `packages/server/src/domain/media-provider.ts` — provider 抽象 / 程序化 SVG / HTTP provider / 组合与回落。
- `packages/server/src/domain/media.ts` — 媒体领域：扣费、写盘、相册表；`takePhoto` / `addPainting` / `orderSong` 全部经 provider 产字节。
- `packages/server/src/api/resident-p35.ts` — 镇民鱼接口（`POST /photo`、`POST /song`、`POST /paint`、`GET /album`）。
- `packages/server/src/api/public-p35.ts` — 公开只读：`GET /api/public/album/:id/file` 下发文件（`image/svg+xml`、`image/png`、`audio/mpeg`…）。

---

## 1. 接口

```ts
interface MediaBytes {
  bytes: Uint8Array   // 媒体二进制（SVG 文本也按 UTF-8 编码成字节）
  type: string        // MIME，如 image/svg+xml; charset=utf-8 / image/png / audio/mpeg
}

interface GenImageInput {
  prompt: string      // 画面描述（必填）
  style?: string      // 'photo' | 'painting' | 自定义风格
  title?: string      // 可选：标题（程序化 SVG 用；也会并入外部提示词）
  fishName?: string   // 可选：落款鱼名（程序化 SVG 用）
  ts?: number         // 可选：生成时间戳 ms（落款用）
}

interface GenSongInput { title: string }

interface MediaProvider {
  readonly name?: string
  genImage(input: GenImageInput): Promise<MediaBytes | null> | MediaBytes | null
  genSong(input: GenSongInput): Promise<MediaBytes | null> | MediaBytes | null
}
```

约定：方法可同步或异步；返回 `null` 表示「本 provider 不产这类媒体 / 生成失败」，由上层回落。

- `takePhoto` / `addPainting`：`generateImageWithFallback(provider, input)` —— provider 抛错/返回非法 → **程序化 SVG**，保证一定有可读图片。
- `orderSong`：`generateSongAudio(provider, input)` —— provider 抛错/无音频 → `null`，相册只记录不存文件。

测试可注入假 provider（`takePhoto(db, fishId, input, now, fakeProvider)`），生产环境不传，按环境变量自动解析。

---

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `IMAGE_GEN_URL` | 空 | 配了就启用**真实出图**。OpenAI 兼容 images 或自定义 endpoint。留空=只用程序化 SVG |
| `IMAGE_GEN_KEY` | 空 | 图片服务密钥，作为 `Authorization: Bearer <key>` 发送。**不会进日志** |
| `IMAGE_GEN_MODEL` | 空 | 可选，作为请求体 `model` 字段 |
| `IMAGE_GEN_SIZE` | 空 | 可选，作为请求体 `size` 字段（如 `1024x1024`） |
| `SONG_URL` | 空 | 配了就启用**真实点歌**。留空=点歌仅记录（不产音频） |
| `SONG_KEY` | 空 | 点歌密钥；缺省回落到 `IMAGE_GEN_KEY` |
| `SONG_METHOD` | `GET` | `GET`（默认，`?title=` 传参）或 `POST`（JSON `{title}`） |
| `MEDIA_TIMEOUT_MS` | `12000` | 外部调用超时（毫秒，上限 60000）；也可用 `IMAGE_GEN_TIMEOUT_MS` / `SONG_TIMEOUT_MS` |
| `MEDIA_MAX_BYTES` | `8388608` | 响应大小上限（字节，8MiB，硬上限 32MiB）；超限直接拒绝并回落 |
| `ALBUM_DIR` | `data/album` | 相册文件落盘目录 |

> 最小配置：只设 `IMAGE_GEN_URL`（+ `IMAGE_GEN_KEY`）就能「真出图」，点歌仍是本地记录。
> 只设 `SONG_URL` 就能「真点歌」，出图仍是程序化 SVG。两个都设，两者都真。

### 示例

```bash
# OpenAI 兼容 images 接口
IMAGE_GEN_URL=https://api.openai.com/v1/images/generations
IMAGE_GEN_KEY=sk-xxxx
IMAGE_GEN_MODEL=gpt-image-1
IMAGE_GEN_SIZE=1024x1024

# OpenAI 兼容 audio/speech（返回 audio/mpeg 字节）
SONG_URL=https://api.openai.com/v1/audio/speech
SONG_METHOD=POST
SONG_KEY=sk-xxxx
```

---

## 3. 图片 provider 的请求 / 响应约定

**请求**（默认 `POST`，`content-type: application/json`，带 `Authorization: Bearer <IMAGE_GEN_KEY>`）：

```json
{ "prompt": "码头晚霞 — 一只橘猫 — style: photo", "style": "photo", "model": "…", "size": "…" }
```

`prompt` 由 `title + prompt + style` 组合而成；`model` / `size` 仅在配置了对应环境变量时出现。

**响应**支持以下几种，按顺序识别（**安全子集，2026-11 加固**）：

1. **直出图片字节**：`content-type` 为 `image/png` / `image/jpeg` / `image/webp` → 直接用。
2. **OpenAI 兼容 JSON**（只接受内联）：
   ```json
   { "data": [ { "b64_json": "iVBORw0K...", "mime_type": "image/png" } ] }
   ```
3. **自定义 JSON**：`{ "b64_json" | "b64" | "base64" | "bytes" | "image": "…", "type" | "mime_type": "image/png" }`。
4. 响应非 JSON 但带了图片字节（`application/octet-stream`）→ 按文件头嗅探 PNG/JPEG/WebP（**SVG 一律拒绝**）。

> **安全（H1 SSRF / M1 存储型 XSS）**：
> - 响应里的 `url` / `image_url` **一律不被服务端 fetch**（防 SSRF 打 127/内网/169.254 云元数据），纯 URL 响应直接忽略 → 回落程序化。只接受内联 `b64/bytes`。
> - 外部图片**只允许栅格图** `image/png|jpeg|webp`；声明或嗅探为 `svg/xml` 的一律拒绝（防存储型 XSS），回落我们自己的程序化 SVG。

任何一步失败（非 2xx、超时、超限、无法解析、类型被拒）→ 返回 `null` → 上层用程序化 SVG 兜底。

---

## 4. 点歌 provider 的请求 / 响应约定

**请求**：

- `GET <SONG_URL>?title=<urlencode(歌名)>`（默认）
- 若 `SONG_METHOD=POST`：`POST <SONG_URL>` + JSON `{ "title": "…" }`
- 可带 `Authorization: Bearer <SONG_KEY || IMAGE_GEN_KEY>`

**响应**支持（安全子集）：

1. 直出音频字节：`content-type: audio/mpeg|mp3|wav|x-wav|ogg|mp4|m4a` → 直接用（存 `.mp3/.wav/.ogg/.m4a`）。
2. `application/octet-stream` + 音频文件头 → 嗅探 ID3/MPEG frame/WAV/OGG。
3. JSON（只接受内联）：`{ "b64_json" | "b64" | "base64" | "audio" | "bytes": "…", "mime_type": "audio/mpeg" }`。

> **安全（H1 SSRF）**：响应里的 `url` / `audio_url` **一律不被 fetch**；纯 URL 响应 → 返回 `null`（仅记录）。`svg/xml` 一律拒绝。

失败/无音频 → 返回 `null` → 点歌**成功但仅记录**（写相册 `kind='song'`，`path=null`）。

---

## 5. 相册文件与 MIME

`GET /api/public/album/:id/file` 按落盘文件扩展名返回正确 `Content-Type`：

| 扩展名 | Content-Type |
|---|---|
| `.svg` | `image/svg+xml; charset=utf-8` |
| `.png` / `.jpg` / `.webp` / `.gif` | `image/png` / `image/jpeg` / `image/webp` / `image/gif` |
| `.mp3` | `audio/mpeg` |
| `.wav` / `.ogg` / `.m4a` | `audio/wav` / `audio/ogg` / `audio/mp4` |

安全：
- album id 必须是 `album_[0-9a-f]{16}`；落盘路径必须位于 `ALBUM_DIR` 内（防路径穿越），否则 `409 CONFLICT`。
- 所有文件响应带 `X-Content-Type-Options: nosniff`；`.svg` 额外带 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`，禁止脚本与外部加载（防存储型 XSS）。
- 外部 provider 只允许栅格图（png/jpeg/webp），不会把外部 SVG 存进相册；相册里的 SVG 只来自我们自己的程序化生成。

相册条目（`GET /album` 返回）含 `{ id, fishId, kind, title, path, price, ts, mime, data }`。

---

## 6. 一致性与「失败无副作用」

- 金额一律走 `account.spend`（内部 `postLedger`，`reason='social'`），账本唯一写入口。
- 生成前先做**余额预检**（不足直接 `INSUFFICIENT`，不白跑外部调用、不写文件）。
- 扣费/插入若失败，会删掉刚写的媒体文件，保证「失败无残留」。
- provider 层已双重兜底：外部异常 → 程序化（图片）/ 仅记录（点歌），**不会让媒体请求 500**。

---

## 7. 测试

`packages/server/test/media-provider.test.ts` 覆盖：

- 默认 provider 生成**可读 SVG**（含 `<svg>`、渐变、场景/标题文字），`genSong` 返回 `null`；
- **注入假 provider** 返回 PNG 字节 → 正确写文件、扩展名 `.png`、`getAlbumFile` 读回字节一致、MIME `image/png`；
- provider **抛错 → 回落程序化 SVG**、不崩、账照扣；
- **点歌有音频** → 存 `.mp3`、`kind=song` 带 `path`、`getAlbumFile` 返回 `audio/mpeg`；provider 抛错时点歌仅记录；
- HTTP 图片 provider：直出字节解析、**超时**快速返回、**大小上限**拒绝超限响应、未配置返回 `null`、连接失败回落程序化；
- HTTP 点歌 provider：`audio/mpeg` 直出解析；
- 公开端点 `GET /api/public/album/:id/file` 对音频条目返回 `200 + audio/mpeg + 原始字节`。

`packages/server/test/media.test.ts` 覆盖拍照/画铺/点歌/相册/扣费/余额不足无副作用/校验等既有行为（已改为 async）。

跑全部：`pnpm -C packages/server test`。
