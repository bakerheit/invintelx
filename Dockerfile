# syntax=docker/dockerfile:1

# InvIntelX as one image. The API process serves the built web app itself, so a
# deployment is one container, one port and one origin — which is also what
# keeps the session cookie SameSite=Lax with no CORS arrangement at all.
#
# Four stages. Only the last one is shipped, and it contains no pnpm, no
# TypeScript, no vite and no dev dependencies: Node, the compiled JavaScript,
# the built web assets, and the packages the API imports at runtime.

ARG NODE_VERSION=22

# ---------------------------------------------------------------- base -------
# pnpm and the manifests, and nothing else. Splitting the manifests out from the
# sources is what lets a code change reuse the install layer.
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack fetches the pnpm version pinned by `packageManager` in the root
# package.json, so the image installs with the same pnpm the lockfile was
# written by. Nothing here is interactive; do not stop to ask.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# ----------------------------------------------------------- prod-deps -------
# The dependency tree the runtime stage carries: production only, resolved from
# the committed lockfile so the image cannot drift from what CI tested.
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# --------------------------------------------------------------- build -------
# The whole workspace, dev dependencies and all. `pnpm build` is the same
# command CI runs; pnpm orders it topologically, so packages/shared emits its
# JavaScript before apps/api and apps/web compile against it.
FROM base AS build
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web

# AGPL section 13: the running app offers its source to network users, and this
# is baked into the web bundle at build time. If you modify InvIntelX and serve
# it to other people, build your own image with this pointed at YOUR source —
# pulling ours and modifying it is not a thing you can do without rebuilding.
ARG VITE_SOURCE_URL
RUN pnpm build

# ------------------------------------------------------------- runtime -------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="InvIntelX" \
      org.opencontainers.image.description="Open source inventory intelligence" \
      org.opencontainers.image.source="https://github.com/bakerheit/invintelx" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app

# The workspace layout is load-bearing and is reproduced here on purpose. The
# API finds the web build at ../../web/dist and its own version at
# ../package.json, both relative to apps/api/dist. Flattening this would need
# WEB_DIST set and would still report the version at /api/health as "unknown".
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# `node` exists in the official image with uid 1000. Nothing here is written to
# at runtime, so root ownership of read-only files is what we want.
USER node

EXPOSE 3001

# Node's own fetch, so the image needs no curl and no shell for this. A degraded
# instance answers 503 — it is running but it cannot reach its database, and an
# orchestrator should treat that as unhealthy rather than as serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||3001}/api/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

# --conditions=production is what makes @invintelx/shared resolve to its
# compiled JavaScript. Without it the package exports its TypeScript source,
# which is exactly what `tsx` and vite want in a dev checkout and exactly what
# Node cannot load here. See the README.
#
# Node is PID 1 deliberately: apps/api/src/index.ts handles SIGTERM and closes
# the server and the Mongo connection, so `docker stop` is a clean shutdown.
CMD ["node", "--conditions=production", "apps/api/dist/index.js"]
