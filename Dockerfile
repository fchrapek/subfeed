# Subfeed production image.
#
# Stage 1 builds both halves: vite compiles the SPA into dist/client, esbuild
# bundles the Hono server into a single ESM file at dist/server.js.
# Stage 2 carries dist/ only, so no node_modules and no source ship to the box.
#
# Build it on the machine that runs it. Cross-building for linux/amd64 on an
# arm64 Mac (--platform linux/amd64) tends to fail: esbuild is a Go binary and
# crashes under QEMU ("fatal error: lfstack.push") during the vite build.

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# SPA into dist/client (outDir comes from vite.config.ts)
RUN npm run build

# Server into dist/server.js. platform=node keeps every node: builtin external
# instead of inlining or shimming it.
RUN ./node_modules/.bin/esbuild server/index.ts \
      --bundle \
      --platform=node \
      --format=esm \
      --target=node24 \
      --outfile=dist/server.js


FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    SUBFEED_DB=/data/db.sqlite \
    PORT=8787

# server/index.ts serves the SPA with serveStatic({ root: './dist/client' }),
# and that root is resolved against process.cwd(), so dist/ has to sit directly
# under WORKDIR exactly as it does in the build stage.
COPY --from=build /app/dist ./dist
# So a password hash can be made inside the container:
#   docker run --rm -it subfeed node scripts/hash-password.mjs
COPY scripts/hash-password.mjs ./scripts/hash-password.mjs

# /data is the SQLite mount point. A fresh named volume inherits the ownership
# of the image directory it covers, which is what lets the unprivileged node
# user create the WAL and shm sidecar files next to db.sqlite.
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "dist/server.js"]
