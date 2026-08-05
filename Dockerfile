# syntax=docker/dockerfile:1
# Multi-stage build: builder → runner (standalone output)
# Final image runs as uid/gid 1001 (nextjs:nodejs); exposes :8800.

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1 – builder: full dev deps + Next.js standalone build
# ──────────────────────────────────────────────────────────────────────────────
# Node is pinned to an EXACT version, deliberately.
#
# `node:24-alpine` floats. The image running in the Pyramid showroom was built
# on 24.18.0; a rebuild months later silently picked up 24.19.0, which aborts
# the process on the first render of `/`:
#
#   void node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
#   Assertion failed: (env) != nullptr        → SIGABRT, exit 134
#
# The console then crash-looped ~every few minutes with no JS error anywhere,
# and the same source built against 24.18.0 is fine — so the runtime, not the
# app, was the variable. Never widen this back to a floating tag: it makes the
# deployed runtime a function of the build date, which is unreproducible and
# cost a full day to bisect. Bump it consciously, and verify `GET /` afterwards.
FROM node:24.18.0-alpine AS builder
WORKDIR /app

# Same toolchain required for npm ci (full devDeps includes @types/* etc., but
# native modules still need to compile).
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
# --ignore-scripts: the package.json `prepare` hook is
# `cd .. && console/node_modules/.bin/husky console/.husky` — a path that
# assumes the monorepo layout. Inside the build container we are at /app
# and there is no parent console/ dir, so npm errors out before the hook
# can even check HUSKY=0. We don't need git hooks installed in the image.
#
# After install, explicitly rebuild native modules — `--ignore-scripts`
# also skips legitimate postinstall hooks like better-sqlite3's
# node-gyp compile that produces the .node binary. Without this, the
# console pod's /api/health/ready returns "db: Could not locate the
# bindings file" and never becomes Ready.
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# Sentry source-map upload during `next build` (see next.config.js
# withSentryConfig). Non-secret build metadata is passed as ARGs; the auth
# token is a BuildKit secret so it never lands in an image layer. All are
# optional — without SENTRY_AUTH_TOKEN, next build proceeds and upload is
# skipped (events still report, frames stay minified). CI/laptop drivers pass
# these from Secret Manager `isv-labs-sentry-build-env`.
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_RELEASE
ENV SENTRY_ORG=${SENTRY_ORG} \
    SENTRY_PROJECT=${SENTRY_PROJECT} \
    SENTRY_RELEASE=${SENTRY_RELEASE}

# next build emits .next/standalone — a self-contained Node server tree that
# includes node_modules entries for serverExternalPackages (ssh2, better-sqlite3,
# cpu-features) resolved at build time for the current arch.
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN,required=false \
    npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2 – runner: minimal Alpine with runtime-only packages
# ──────────────────────────────────────────────────────────────────────────────
# Same pinned runtime as the builder — see the note above.
FROM node:24.18.0-alpine AS runner
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
