# syntax=docker/dockerfile:1

# One image, one process, one origin. The API serves /api and the built web app
# from the same port, which is what keeps the session cookie same-origin — see
# apps/api/src/web.ts. Splitting the assets onto their own origin would need
# SameSite=None and the CORS path in app.ts, and neither is wired up.
#
# Built and pushed by .github/workflows/release.yml on a version tag and by
# .github/workflows/deploy.yml on every green main. docs/deploying.md is the
# runbook for what happens to it afterwards.

# Node 22 to match CI. The floor in package.json is 20; the image is pinned
# higher on purpose so "it built in CI" and "it runs in production" mean the
# same runtime.
FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Takes the pnpm version from the `packageManager` field, so the image cannot
# drift from the version the lockfile was written by.
RUN corepack enable

WORKDIR /src

# Manifests first: dependencies only change when these do, so an edit to a
# source file reuses the install layer.
#
# This list has to be every workspace project, not most of them. pnpm-workspace
# globs apps/* and packages/*, and a frozen install checks the lockfile's
# importers against the projects it can actually see — so a context that is one
# manifest short fails here rather than installing something smaller. That is
# the right failure, but it used to be a failure nothing would ever run: add a
# project, and the first build was a merge to main. The `image` job in
# .github/workflows/ci.yml now builds this file on every pull request, so it is
# the pull request that goes red instead.
#
# Four projects as of this commit — root, apps/api, apps/web, packages/shared —
# which is `importers:` in pnpm-lock.yaml. Add a fifth, add a line.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .

# tsc for the API and for shared, vite for the web app. Everything the runtime
# stage needs is produced here; nothing is compiled after this point.
RUN pnpm build

# Strip the toolchain — typescript, vite, vitest, tsx, mongodb-memory-server.
# Same lockfile, so the versions that survive are the ones that were resolved
# above rather than whatever is newest today.
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

# The whole pruned workspace rather than a hand-picked list of directories.
# pnpm's node_modules is a farm of relative symlinks into node_modules/.pnpm,
# and copying only some of it produces an image that resolves most imports and
# then dies on one. The source files that come along are a few hundred
# kilobytes and are what make that trade worth taking.
COPY --from=build --chown=node:node /src /app

# Runs as an ordinary user. Nothing here writes to disk: uploads go nowhere,
# state lives in Mongo, and the assets are read-only.
USER node

EXPOSE 3001

# The same check Fly polls over HTTP, so `docker run` locally fails the same way
# a bad deploy does. node rather than wget: node is unarguably in this image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --conditions=invintelx-dist is not optional. @invintelx/shared resolves to its
# TypeScript source by default, which is what vite, vitest and tsx all want and
# what Node cannot load; the condition points the same specifier at the JavaScript
# `pnpm build` emitted into packages/shared/dist. Mirrors apps/api's `start`
# script — change one and change the other.
CMD ["node", "--conditions=invintelx-dist", "apps/api/dist/index.js"]
