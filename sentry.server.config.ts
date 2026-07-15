import * as Sentry from "@sentry/nextjs";

// Fallback DSN for project `scality-vss-console-ui` (org scality-3i, de region).
// A DSN is an ingest-only identifier, not a secret — hardcoding it lets every
// in-cluster pod report without env plumbing. Empty = Sentry disabled (no-op),
// which keeps builds green until the real DSN is inlined here.
// TODO(sentry): paste the scality-vss-console-ui DSN as CONSOLE_SENTRY_DSN below.
export const CONSOLE_SENTRY_DSN = "";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? CONSOLE_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Deliberately NO includeLocalVariables and NO enableLogs: server code holds
  // lab secrets (S3/objectstore keys, the camera-sim SSH PEM, Firestore SA key,
  // ARTESCA Grafana/Keycloak passwords) in locals and logs cluster command
  // lines — neither may reach the observability sink.
});
