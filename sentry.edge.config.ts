import * as Sentry from "@sentry/nextjs";

// DSN inlined (not imported from sentry.server.config, whose import would run
// that module's Sentry.init in the edge runtime). Keep in sync with the
// CONSOLE_SENTRY_DSN fallback there.
const CONSOLE_SENTRY_DSN =
  "https://507501f6802911f191fb369c30d22471@o4511336023326720.ingest.de.sentry.io/4511738391494736";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? CONSOLE_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
});
