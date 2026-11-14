# 鱼缸小镇 · 自建版 —— 生产镜像（Node 24 原生跑 TS）
FROM node:24-slim
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

# 先装依赖（利用缓存）：需要 lockfile + 所有 workspace 的 package.json
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/plugin/package.json packages/plugin/
COPY packages/games/package.json packages/games/
COPY packages/npc/package.json packages/npc/
RUN pnpm install --frozen-lockfile

# 拷源码 + 构建 web（server 同源托管 dist）
COPY . .
RUN pnpm -C packages/web build

EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "packages/server/src/index.ts"]
