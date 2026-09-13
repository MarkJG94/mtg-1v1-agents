# syntax=docker/dockerfile:1

# One image serves the API and the built web app on a single port
# (see "Deployment" in docs/01-architecture.md).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app

# --- Build: install every dependency, then bundle the server and the web app ---
FROM base AS build
# better-sqlite3 falls back to compiling from source when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

# --- Production dependencies only ---
FROM base AS prod-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/cards/package.json packages/cards/
COPY packages/agents/package.json packages/agents/
COPY packages/sim/package.json packages/sim/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@mtg/server..."

# --- Runtime ---
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    SCRYFALL_IMAGE_CACHE=lazy
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/server/node_modules /app/apps/server/node_modules
COPY --from=build /app/apps/server/dist /app/apps/server/dist
COPY --from=build /app/apps/web/dist /app/web
COPY --from=build /app/scripts /app/scripts
COPY --from=build /app/package.json /app/package.json
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
