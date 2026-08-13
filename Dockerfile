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

# The SDK is an optional install and `npm ci` above does not bring it, because it
# is in no dependency field — it pulls @sentry/cli under FSL-1.1-MIT, which is
# source-available rather than open source, and this repository is public
# (telemetry-optional.cjs). An image built without this arg has telemetry
# compiled out: next.config.js aliases the specifier to a no-op and the app runs
# with no reporting whatever SENTRY_DSN says.
#
# Scality lab images set WITH_TELEMETRY=1. A third-party build leaves it unset
# and gets an image with no source-available dependency in it.
ARG WITH_TELEMETRY=
RUN if [ -n "$WITH_TELEMETRY" ]; then \
      npm run enable-telemetry && node -e "require.resolve('@sentry/nextjs')"; \
    else \
      echo "telemetry: not installed (WITH_TELEMETRY unset) — building with reporting compiled out"; \
    fi

# The Firestore SDK is optional for a different reason: it is Apache-2.0, but the
# config store defaults to a YAML file under CONSOLE_DATA_DIR, so a default clone
# would pull a GCP client library, gRPC and protobufjs (208 packages) for code
# paths it never reaches (firestore-optional.cjs).
#
# It must be installed BEFORE `npm run build`: next.config.js decides at build
# time whether to alias the specifier to a refusing stub or to treat it as a
# server external and trace it into .next/standalone. An image built without this
# arg cannot serve CONSOLE_CONFIG_STORE=firestore at all — it refuses at startup
# with a message naming this flag.
#
# Scality lab images set WITH_FIRESTORE=1, because every existing lab's cameras,
# prompt-sets and scenarios still live in Firestore and this is the rollback path
# while they are migrated.
ARG WITH_FIRESTORE=
RUN if [ -n "$WITH_FIRESTORE" ]; then \
      npm run enable-firestore && node -e "require.resolve('@google-cloud/firestore')"; \
    else \
      echo "firestore: not installed (WITH_FIRESTORE unset) — the YAML file store is the only backend"; \
    fi

# Drop the image optimizer's native stack, then build — in ONE step (ISVD-609).
#
# next build emits .next/standalone: a self-contained Node server tree carrying
# node_modules entries for the serverExternalPackages (ssh2, better-sqlite3,
# cpu-features) resolved at build time for the current arch. That trace is also
# how sharp gets in, which is what the removal below is about.
#
# `sharp` is not declared in package.json: it is an optionalDependency of `next`,
# for `next/image` optimization. This app imports `next/image` nowhere — the one
# component that renders a camera still uses a plain <img> on purpose, because the
# frame is proxied per-request from VST and would be cached stale. A unit test
# asserts that stays true and names this removal as the reason.
#
# It shipped anyway. Measured on next@16.2.11: `output: standalone` traces
# sharp + @img into .next/standalone/node_modules unconditionally — 10.6 MB, and
# `@img/sharp-libvips-*` is LGPL-3.0-or-later, the only copyleft licence in the
# production tree of a repository about to be public.
#
# ⚠ The removal MUST be in this step, not an earlier one. It was a separate RUN
# straight after `npm ci`, and the published image still contained sharp: the two
# opt-in steps above run `npm install --no-save`, and npm repairs the dependency
# tree as it goes — reinstalling next's optional deps. Verified by inspecting the
# pushed image rather than the build log, which showed the `rm` running and told
# us nothing about what survived.
#
# ⚠ Two obvious alternatives do not work, both measured:
#   - `images: { unoptimized: true }` in next.config.js — the documented switch
#     for turning optimization off. It does not affect the trace; sharp is copied
#     regardless, so the config would assert a decision and change nothing.
#   - `npm ci --omit=optional` — also drops lightningcss's platform binary, which
#     Tailwind v4 requires, so the build fails.
# npm has no way to exclude a single optional dependency, hence remove-then-build.
#
# The final assertion is the part that makes this stick: a build that would ship
# sharp fails here instead. Nothing outside the image can check this — a unit test
# sees a laptop's node_modules, where `npm ci` legitimately installs it.
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN,required=false \
    rm -rf node_modules/sharp node_modules/@img \
    && npm run build \
    && if [ -e .next/standalone/node_modules/sharp ] || [ -e .next/standalone/node_modules/@img ]; then \
         echo "ISVD-609: sharp was traced into .next/standalone despite removal — refusing to ship an LGPL libvips" >&2; \
         exit 1; \
       else \
         echo "sharp: absent from .next/standalone (no LGPL libvips in the image)"; \
       fi

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
