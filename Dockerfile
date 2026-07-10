# Agent System Dockerfile
# 多阶段构建：build → runtime

# ─── Stage 1: Build ───
FROM node:20-slim AS builder

WORKDIR /app

# 安装系统依赖（ts编译无需额外依赖，但保留 python3 以防 native module）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 复制 package.json 和 lockfile
COPY package.json package-lock.json* ./
COPY packages/*/package.json ./packages/

# 安装依赖（包括 devDependencies）
RUN npm ci || npm install

# 复制源代码
COPY tsconfig.json ./
COPY src/ ./src/
COPY packages/ ./packages/
COPY config/ ./config/

# 编译 TypeScript
RUN npx tsc -b --force

# ─── Stage 2: Runtime ───
FROM node:20-slim AS runtime

WORKDIR /app

# 安装 dumb-init 用于优雅信号处理
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# 复制 package.json 和 lockfile
COPY package.json package-lock.json* ./
COPY packages/*/package.json ./packages/

# 只安装 production 依赖
RUN npm ci --omit=dev || npm install --omit=dev

# 复制编译产物
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/packages/*/dist/ ./packages/*/dist/

# 复制配置和静态文件
COPY config/ ./config/
COPY agent-ui.html admin-panel.html audit-dashboard.html ./
COPY packages/*/src/ ./packages/*/src/

# 创建数据和日志目录
RUN mkdir -p data logs uploads memory

# 环境变量
ENV NODE_ENV=production
ENV PORT=19701
EXPOSE 19701

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||19701)+'/api/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# 使用 dumb-init 处理信号
ENTRYPOINT ["dumb-init", "--"]

# 启动命令
CMD ["node", "dist/server/agent-server.js"]
