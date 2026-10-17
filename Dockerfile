# Self-hosted Maktab (docs/self-host.md): the same app as the Cloudflare Worker, on Node with SQLite
# on disk and local file storage. One container = one school; all state lives in /data.
#
#   docker build -t maktab:local --build-arg MAKTAB_VERSION=$(git describe --always --dirty) .
#
# Base images are pinned by the multi-platform manifest-list digest (linux/amd64 + linux/arm64) of
# node:24-bookworm-slim as of 2026-10-17; bump it deliberately (docker buildx imagetools inspect
# node:24-bookworm-slim) and re-run scripts/selfhost-smoke.sh.
#
# Build stage: install with the lockfile (no install scripts: better-sqlite3 ships prebuilt N-API
# binaries, esbuild and workerd use platform packages; the same as CI), build the web app and bundle
# the Node server (apps/api/scripts/build-node.mjs).
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build -w @maktab/web && npm run build:node -w @maktab/api
# Runtime needs only better-sqlite3's JS and this platform's binary (the bundle has everything else).
RUN set -eu; \
    arch="$(node -p 'process.arch')"; \
    mkdir -p /out/node_modules/better-sqlite3/prebuilds; \
    cp -r node_modules/better-sqlite3/package.json node_modules/better-sqlite3/lib node_modules/better-sqlite3/LICENSE \
      /out/node_modules/better-sqlite3/; \
    cp "node_modules/better-sqlite3/prebuilds/linux-${arch}.node" /out/node_modules/better-sqlite3/prebuilds/; \
    node -e "const D=require('/out/node_modules/better-sqlite3'); const d=new D(':memory:'); console.log('better-sqlite3 ok, sqlite', d.prepare('select sqlite_version() v').get().v)"

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
# tini as PID 1; no package managers at run time (npm, npx, corepack, yarn are removed: the
# server needs only node itself).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg /opt/yarn-*
ARG MAKTAB_VERSION=dev
ENV NODE_ENV=production \
    MAKTAB_VERSION=${MAKTAB_VERSION} \
    DATA_DIR=/data \
    PORT=8787 \
    HOST=0.0.0.0
WORKDIR /app
# The layout the server expects (paths relative to apps/api/dist-node, as in the repository).
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/api/dist-node ./apps/api/dist-node
COPY --from=build /src/apps/api/bin ./apps/api/bin
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY --from=build /src/packages/db/migrations ./packages/db/migrations
COPY --from=build /src/packages/db/sql ./packages/db/sql
COPY LICENSE ./
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
# The image's `node` user (uid 1000). The host's data folder must be writable by it (install.sh).
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# tini: PID 1 that forwards SIGTERM (docker stop) to node, which closes the server and the database.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/bin/server.mjs"]
