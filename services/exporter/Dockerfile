# syntax=docker/dockerfile:1.6
#
# OpenMAIC content exporter sidecar — multi-stage build.
#
# Stage layout:
#   deps      — install all deps (incl. native build chain for better-sqlite3)
#   builder   — compile TypeScript to dist/
#   prod-deps — prune node_modules to prod-only, rebuild native bindings
#   runtime   — slim runtime image, non-root user, wget for healthcheck only
#
# The `prod-deps` stage is separate so the final image doesn't carry the compiler
# toolchain (python3/make/g++). Native bindings for better-sqlite3 get rebuilt
# against the pruned deps so they match the lockfile exactly.

FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine AS runtime
RUN apk add --no-cache wget
WORKDIR /app

# Non-root user. UID/GID 1001 chosen to match OpenMAIC's convention.
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs exporter

COPY --from=prod-deps --chown=exporter:nodejs /app/node_modules ./node_modules
COPY --from=builder   --chown=exporter:nodejs /app/dist ./dist
COPY --chown=exporter:nodejs package.json ./

# DATA_DIR default — SqliteJobStore + LocalDiskStorage both write here.
# Must be writable by uid 1001; the named volume in docker-compose inherits this.
RUN mkdir -p /data && chown -R exporter:nodejs /data

USER exporter
ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/server.js"]
