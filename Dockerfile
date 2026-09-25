# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files and the preinstall guard
COPY package.json pnpm-lock.yaml ./
COPY scripts/check-package-manager.js ./scripts/check-package-manager.js

# Activate the pinned pnpm version and install dependencies
RUN corepack enable && \
    corepack prepare pnpm@9.15.9 --activate && \
    pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

# Keep Corepack's prepared pnpm distribution outside root's home so the
# non-root runtime user can execute pnpm without downloading it again.
ENV COREPACK_HOME=/opt/corepack

# Copy package files and the preinstall guard
COPY package.json pnpm-lock.yaml ./
COPY scripts/check-package-manager.js ./scripts/check-package-manager.js

# Activate the pinned pnpm version and install production dependencies only
RUN corepack enable && \
    corepack prepare pnpm@9.15.9 --activate && \
    pnpm install --prod --frozen-lockfile

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership
RUN chown -R nodejs:nodejs /app /opt/corepack

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "dist/src/index.js"]
