# 用你自己的电脑当「出图 API」

> 原理：小镇服务器（这台主力机/容器）→ 内网/Tailscale → 你电脑上的本地出图服务 → 返回图片 → 小镇存进相册 / 画铺 / 首页插画。**内网私连，不暴露公网。**

## 0. 先看有没有 NVIDIA 显卡
- 有 N 卡（4G 显存起步，8G+ 更好）= 推荐；纯 CPU 也能跑但**一张要几分钟**，不建议。

## 1. Windows（N 卡，最省事）
1. 装「**Stable Diffusion WebUI 秋叶整合包**」（B 站/网盘一键包，解压即用）。
2. 让它在**局域网可访问**：编辑 `webui-user.bat` 的 `COMMANDLINE_ARGS`，加：
   ```
   set COMMANDLINE_ARGS=--api --listen --port 7860
   ```
3. 双击启动，浏览器开 `http://127.0.0.1:7860` 能正常出图即成功。
4. **防火墙放行 7860**（Windows 安全中心 → 入站规则 → 新建 → 端口 7860 允许）。
5. 查这台电脑的 Tailscale IP：命令行 `tailscale ip -4`（形如 `100.x.x.x`）。

## 2. Linux / NAS（N 卡）
```bash
git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui
cd stable-diffusion-webui
./webui.sh --api --listen 0.0.0.0 --port 7860
```
放行 7860 端口；用 `tailscale ip -4` 拿 100.x 地址。

## 3. 自测（在服务器或任意同网机器上）
```bash
curl -s -X POST "http://100.x.x.x:7860/sdapi/v1/txt2img" \
  -H 'content-type: application/json' \
  -d '{"prompt":"一只可爱的水彩小鱼，海底小镇","steps":20,"width":512,"height":512}' | head -c 200
```
返回里有 `{"images":["iVBORw0..."]}` 就说明 API 通了。

> ComfyUI 的 API 是"工作流式"，不是简单 txt2img；想省事就用上面的 **A1111**（或用 SD.Next / Fooocus 的 OpenAI 兼容接口）。我们已支持 A1111 / OpenAI / generic 三种。

## 4. 告诉我地址，我接进小镇
把 `http://100.x.x.x:7860` 发我，我配：
```
IMAGE_GEN_URL=http://100.x.x.x:7860/sdapi/v1/txt2img
IMAGE_GEN_KIND=a1111
IMAGE_GEN_WIDTH=768  IMAGE_GEN_HEIGHT=512  IMAGE_GEN_STEPS=24
```
然后重建重启线上小镇。之后：拍照、画铺、首页插画就**由你电脑真实生成**（不是占位图了）。

## 5. 安全与兜底
- 只走 Tailscale 内网，不暴露公网。
- provider 只接收内联 b64（不跟随外部 URL，防 SSRF）；有超时/大小上限；**出图服务挂掉时自动回落程序化占位图**，不影响小镇正常运营。
