/**
 * Where telemetry reports, and whether it reports at all.
 *
 * Telemetry is **off unless configured**. There is no DSN in this source tree:
 * the three runtimes each carried the same Scality DSN as a compiled-in
 * fallback, with comments on two of them asking the next editor to keep the
 * copies in sync. That was correct for the labs — every in-cluster pod reported
 * with no env plumbing — and wrong for anyone else's build, which would have
 * posted its errors into Scality's Sentry project. In a public repository it is
 * also a standing invitation to spend that project's quota.
 *
 * A DSN is an ingest-only identifier rather than a credential, so the reason to
 * keep it out of the tree is not secrecy: it is that a default pointing at one
 * organisation's account is not a default, it is a destination someone else
 * inherits by accident.
 *
 * Supply it from the deployment (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`). For
 * the Scality labs that happens in `isv-labs:scripts/deploy-console.sh`, which
 * already rewrites the `console-env` ConfigMap at deploy time.
 *
 * Pure by design — no `@sentry/nextjs` import. All three runtimes import this,
 * and the edge runtime cannot import `sentry.server.config.ts` because doing so
 * would run that module's `Sentry.init`. A module with no side effects is safe
 * from anywhere, which is what lets one definition serve all three.
 */

/**
 * Treat blank as unset. A ConfigMap key present with an empty value is the
 * normal shape of "someone left this to be filled in", and `??` alone would
 * accept it and hand Sentry an empty DSN.
 */
function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Server and edge ingest. Read separately from the browser's, so the client
 * bundle never depends on a variable it cannot see: Next inlines
 * `NEXT_PUBLIC_*` into client code and replaces everything else with
 * `undefined`, so a single shared reader would silently disable browser
 * reporting.
 */
export function serverTelemetryDsn(): string | undefined {
  return configured(process.env.SENTRY_DSN);
}

/** Browser ingest. Baked at build time — changing it needs a rebuild. */
export function clientTelemetryDsn(): string | undefined {
  return configured(process.env.NEXT_PUBLIC_SENTRY_DSN);
}

/** 100% of traces in development, 10% in production. */
export function tracesSampleRate(): number {
  return process.env.NODE_ENV === "development" ? 1.0 : 0.1;
}
