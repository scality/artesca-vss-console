import * as Sentry from "@sentry/nextjs";

// DSN inlined (not imported from sentry.server.config, whose import would run
// that module's Sentry.init in the edge runtime). Keep in sync with the
// CONSOLE_SENTRY_DSN fallback there. Empty = disabled until the real DSN lands.
const CONSOLE_SENTRY_DSN = "";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? CONSOLE_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
});
