# The base image is pinned by digest; update the digest deliberately when moving to a newer Node 24 image.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
# No dependency needs an install script (only the optional macOS fsevents declares one), so none run.
RUN npm ci --ignore-scripts
COPY index.html tsconfig.json tsconfig.backend.json presentation-baseline.json vite.config.mjs ./
COPY server ./server
COPY src ./src
COPY shared ./shared
COPY public ./public
# The architecture check in `npm run build` inventories every source root, so the build stage needs tests and scripts too.
# Neither reaches the final image.
COPY tests ./tests
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
# Openship passes no build args, so the defaults are what ships there: APP_VERSION must equal package.json's version
# (tests/image-labels.test.mjs fails CI otherwise) and APP_REVISION is overridden by `--build-arg` where one is available.
ARG APP_VERSION=0.40.0
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
