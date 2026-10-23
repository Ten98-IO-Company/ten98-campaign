# The base image is pinned by digest; update the digest deliberately when moving to a newer Node 24 image.
FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS build
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

FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d
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
