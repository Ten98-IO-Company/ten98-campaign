FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci
COPY index.html tsconfig.json tsconfig.backend.json presentation-baseline.json vite.config.mjs ./
COPY server ./server
COPY src ./src
COPY shared ./shared
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3018 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
RUN mkdir data && chown node:node data
USER node
EXPOSE 3018
CMD ["node", "server/index.mjs"]
