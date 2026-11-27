FROM node:22-bookworm-slim AS build
WORKDIR /src
ENV CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/desktop/package.json ./apps/desktop/package.json
# Vite uses its platform esbuild package; this target needs no desktop installation hooks.
RUN corepack enable && pnpm --filter @deva/desktop install --frozen-lockfile --ignore-scripts
COPY apps/desktop ./apps/desktop
RUN pnpm --filter @deva/desktop build:headless

FROM node:22-bookworm-slim AS runtime
WORKDIR /opt/deva
ENV NODE_ENV=production DEVA_HOME=/data DEVA_HOST=127.0.0.1 DEVA_PORT=8787
RUN test -x /usr/bin/flock && install -d -m 0700 -o node -g node /data
COPY --from=build /src/apps/desktop/out/headless/ ./
RUN chmod -R u=rwX,go=rX /opt/deva
USER node:node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.DEVA_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/deva/server.mjs"]
