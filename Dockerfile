FROM node:20-bookworm-slim AS deps

WORKDIR /app

# Install dependencies once to maximize build cache reuse.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts


FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node tsconfig.json ./tsconfig.json
COPY --chown=node:node src ./src

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]