# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source and build frontend
COPY . .
RUN bun run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM oven/bun:1-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Only copy what the server needs at runtime
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY server/ ./server/
COPY --from=builder /app/dist ./dist
COPY tsconfig.json ./

EXPOSE 3001

# Health check — Render uses this to confirm the service is up
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

CMD ["bun", "run", "server/index.ts"]
