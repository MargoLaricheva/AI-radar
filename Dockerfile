FROM docker.io/oven/bun:1.2-slim AS base
WORKDIR /app

# Runtime-переключатель: bun (default) или node
ARG RUNTIME=bun

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Миграции применяются при старте (drizzle-orm runtime, без drizzle-kit)
CMD ["sh", "-c", "bun src/db/migrate.ts && bun src/index.ts"]
