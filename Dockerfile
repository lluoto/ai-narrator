# ============================================================
# AI Narrator — 多阶段 Docker 构建
# ============================================================
# External world-model data is intentionally excluded from the build context.
# The optional Compose override supplies reviewed host data only through
# explicit read-only runtime mounts; a clean clone needs no assets/ directory.

# ── Shared toolchain version ──
ARG BUN_VERSION=1.3.14

# ── Stage 1: 构建前端 ──
FROM oven/bun:${BUN_VERSION} AS frontend-build

WORKDIR /app/frontend
# 锁文件统一成 bun.lock（根目录一直如此，frontend 以前跟踪的是 npm 的
# package-lock.json —— 同一个项目两个包管理器的锁，迟早分叉）。
# `bun install` 迁移时实测「no changes」：34 个安装、84 个包，版本一个没变。
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

COPY frontend/ .
RUN bun run build

# ── Stage 2: 运行后端 ──
FROM oven/bun:${BUN_VERSION}-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/

# 前端构建产物 —— 由后端在同一端口托管，见 src/api/server.ts 的 serveStatic
COPY --from=frontend-build /app/frontend/dist/ ./frontend/dist/

ENV PORT=3099
ENV NODE_ENV=production
ENV FRONTEND_DIR=/app/frontend/dist
ENV WORLD_MODEL_PATH=/app/assets/v18_all_master.jsonl
ENV CTHULHU_MODEL_PATH=/app/assets/cthulhu_world_model.jsonl

# Only durable session data is writable by the runtime user. World-model input
# is supplied through explicit read-only runtime bind mounts, never image COPY.
RUN mkdir -p /app/data /app/assets /app/world-model-policy /app/cthulhu-dataset && chown bun:bun /app/data && chmod 0555 /app/assets /app/world-model-policy /app/cthulhu-dataset

VOLUME [ "/app/data" ]

USER bun

EXPOSE 3099

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "src/api/container-healthcheck.ts"]

CMD ["bun", "src/api/server.ts"]
