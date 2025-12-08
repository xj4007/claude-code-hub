# syntax=docker/dockerfile:1

# 说明：
# 1. 应用构建（`bun run build`）在宿主机本地完成
# 2. 构建产物（.next/standalone、.next/server、.next/static 等）随代码一起上传到服务器
# 3. 服务器上执行 `docker-compose up -d --build` 时，只会打包已有产物，不再执行 bun 构建

FROM node:22-slim AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
WORKDIR /app

# 安装 PostgreSQL 18 客户端工具（用于数据库备份/恢复）和 curl（用于健康检查）
# 使用官方 PostgreSQL APT 仓库以获得最新版本
RUN apt-get update && \
    apt-get install -y gnupg curl ca-certificates && \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-archive-keyring.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && \
    apt-get install -y postgresql-client-18 && \
    rm -rf /var/lib/apt/lists/*

# 这里直接拷贝已经在宿主机构建好的产物
# 注意：需要在本机执行过 `bun install && bun run build`，
# 且 Next 输出模式为 standalone（next.config.ts 里已经是 output: "standalone"）
COPY --chown=node:node ./public ./public
COPY --chown=node:node ./drizzle ./drizzle
COPY --chown=node:node ./messages ./messages
COPY --chown=node:node ./.next/standalone ./
# Server Actions 需要 .next/server；如果缺少将导致无法解析 Action ID
COPY --chown=node:node ./.next/server ./.next/server
COPY --chown=node:node ./.next/static ./.next/static

USER node
EXPOSE 3000

CMD ["node", "server.js"]
