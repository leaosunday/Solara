# --- 阶段 1: 构建阶段 ---
FROM node:20-slim AS builder

# 安装编译 better-sqlite3 所需的工具
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 仅复制依赖相关文件
COPY package*.json ./

# 安装所有依赖（包括原生模块编译）
RUN npm install

# --- 阶段 2: 运行阶段 ---
FROM node:20-slim

WORKDIR /app

# 从构建阶段复制 node_modules
COPY --from=builder /app/node_modules ./node_modules

# 复制项目源代码
COPY . .

# 设置环境变量默认值
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/solara.db
ENV NAS_DOWNLOAD_DIR=/app/downloads

# 创建数据和下载目录
RUN mkdir -p /app/data /app/downloads

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["npm", "start"]
