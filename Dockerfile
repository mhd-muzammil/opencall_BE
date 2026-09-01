
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
# LIVENESS, not readiness: "is this process alive", answered without touching the
# database.
#
# This used to probe /api/v1/health/runtime, which queries information_schema through
# the shared pg pool. Under morning load the pool (report generation holds one
# connection for its whole transaction) had nothing free, so the probe waited on
# connectionTimeoutMillis and blew the 5s budget. Three of those in 90 seconds and
# Swarm SIGKILLed the container — "non-zero exit (137): dockerexec: unhealthy
# container" — taking every in-flight request with it. The browser sees a response
# with no headers and reports it as a CORS failure.
#
# That is a restart loop that feeds itself: the kill drops the reports being
# generated, everyone retries, the pool starves again. Under sustained load the
# report could never finish, because the container never survived long enough.
#
# /api/v1/health touches nothing, so it answers while the app is merely BUSY — which
# is what a liveness probe must distinguish from dead. Schema readiness is still
# reported by /health/runtime for deploys and dashboards to read; it just no longer
# gets to kill a working API. The wider timeout and retry count are headroom for the
# event loop being briefly blocked serializing a large report.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
