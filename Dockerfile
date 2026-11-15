# The base image is pinned by digest; update the digest deliberately when moving to a newer Node 24 image.
FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
# Corepack installs the pnpm version named by package.json's packageManager field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
# No dependency needs an install script (only the optional macOS fsevents declares one), so none run.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY index.html tsconfig.json tsconfig.backend.json presentation-baseline.json raw-statements.json vite.config.mjs ./
COPY server ./server
COPY src ./src
COPY shared ./shared
COPY public ./public
# The architecture check in `pnpm build` inventories every source root, so the build stage needs tests and scripts too.
# Neither reaches the final image.
COPY tests ./tests
COPY scripts ./scripts
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
# Openship passes no build args, so the defaults are what ships there: APP_VERSION must equal package.json's version
# (tests/image-labels.test.mjs fails CI otherwise) and APP_REVISION is overridden by `--build-arg` where one is available.
ARG APP_VERSION=0.41.0
ARG APP_REVISION=unknown
LABEL org.opencontainers.image.title="Ten98 Campaign" \
      org.opencontainers.image.description="Open-source campaign management for per-platform social publishing, advertising, OOH media and digital assets" \
      org.opencontainers.image.source="https://github.com/Ten98-IO-Company/ten98-campaign" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_REVISION}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3018 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node migrations ./migrations
RUN mkdir data && chown node:node data
USER node
EXPOSE 3018
CMD ["node", "server/index.ts"]
