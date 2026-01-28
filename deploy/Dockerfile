# syntax=docker/dockerfile:1

# 说明：
# 1. 应用构建（`bun run build`）在宿主机本地完成
# 2. 构建产物（.next/standalone、.next/server、.next/static 等）随代码一起上传到服务器
# 3. 服务器上执行 `docker-compose up -d --build` 时，只会打包已有产物，不再执行 bun 构建

# 运行阶段：使用 Node.js（避免 Bun 流式响应内存泄漏 Issue #18488）
FROM node:trixie-slim AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# 安装 PostgreSQL 18 客户端工具（用于数据库备份/恢复功能）和 curl（用于健康检查）
# node:trixie-slim 基于 Debian Trixie，默认只有 PostgreSQL 17.x
# 使用 PostgreSQL 官方仓库安装 18.x 以匹配 docker-compose 中的 postgres:18
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg && \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends postgresql-client-18 && \
    apt-get purge -y --auto-remove gnupg && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

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
