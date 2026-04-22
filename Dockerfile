# syntax=docker/dockerfile:1
# Multi-stage build: builder → runner (standalone output)
# Final image runs as uid/gid 1001 (nextjs:nodejs); exposes :8800.

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1 – builder: full dev deps + Next.js standalone build
# ──────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

# Same toolchain required for npm ci (full devDeps includes @types/* etc., but
# native modules still need to compile).
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
# Full install (includes devDeps for TypeScript compilation).
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# next build emits .next/standalone — a self-contained Node server tree that
# includes node_modules entries for serverExternalPackages (ssh2, better-sqlite3,
# cpu-features) resolved at build time for the current arch.
RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2 – runner: minimal Alpine with runtime-only packages
# ──────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

# Runtime packages:
#   tini     — PID 1 signal handling / zombie reaping
#   ffmpeg   — HLS transcoding used by /api/clips/** routes
#   curl     — HEALTHCHECK + optional debugging
RUN apk add --no-cache tini ffmpeg curl

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8800
ENV HOSTNAME=0.0.0.0

# Non-root user matching K8s runAsUser: uid/gid 1001
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Pre-create writable directories before switching to non-root user.
#   /data          — CONSOLE_DATA_DIR for clip cache and SQLite
#   /app/.next/cache — Next.js incremental cache writes
RUN mkdir -p /data /app/.next/cache && \
    chown -R nextjs:nodejs /data /app/.next

# standalone output is self-contained; copy static assets separately.
# The standalone dir already includes node_modules for serverExternalPackages
# (ssh2, better-sqlite3, cpu-features) compiled for the builder's arch (Linux amd64).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 8800

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8800/api/health/self || exit 1

# tini as PID 1 ensures proper signal forwarding and zombie reaping.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
