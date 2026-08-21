
# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.12.0
ARG PNPM_VERSION=9.15.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
WORKDIR /app
# Install pnpm directly to avoid corepack signature verification failures in CI/deploy builds.
RUN npm install -g pnpm@${PNPM_VERSION}

FROM base AS pnpm-store
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS builder
COPY shared shared
COPY backend backend
RUN pnpm --filter @opencall/shared build \
    && pnpm --filter @opencall/api build

FROM builder AS api-deploy
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @opencall/api deploy --prod /prod/api

FROM node:${NODE_VERSION}-bookworm-slim AS api
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1024" \
    PORT=4000 \
    UPLOAD_DIR=/app/storage/uploads
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 opencall \
    && mkdir -p /app/storage/uploads /tmp/opencall \
    && chown -R opencall:nodejs /app /tmp/opencall
COPY --from=api-deploy --chown=opencall:nodejs /prod/api ./
USER opencall
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health/runtime').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run before the server, not as a step somebody has to remember afterwards.
# Every "a page 500s while /health says ready" outage this system has had came from code
# shipping ahead of its schema.
#
# `&&` is the safety: a non-zero exit from the migration step means the server is never
# reached, the container never becomes healthy, the deploy goes red, and the container
# already serving carries on. Starting on a half-applied schema would be the worse
# outcome — it is the silent drift this exists to prevent.
#
# The step is a no-op unless RUN_MIGRATIONS_ON_START is "true", so it can be switched off
# from the environment in seconds if it ever misbehaves.
CMD ["sh", "-c", "node dist/scripts/migrateOnStart.js && node dist/server.js"]
