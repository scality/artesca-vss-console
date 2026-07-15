import * as Sentry from "@sentry/nextjs";

// DSN inlined as a fallback (ingest-only identifier, not a secret). Keep in
// sync with CONSOLE_SENTRY_DSN in sentry.server.config.ts.
const CONSOLE_SENTRY_DSN =
  "https://507501f6802911f191fb369c30d22471@o4511336023326720.ingest.de.sentry.io/4511738391494736";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? CONSOLE_SENTRY_DSN,

  // 100% in dev, 10% in production
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Session Replay: 10% of all sessions, 100% of sessions with errors
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // No enableLogs: the operator UI renders lab credentials as plain text
  // (Grafana/Keycloak passwords on Overview, the Secrets page, S3 endpoint
  // keys); forwarded console logs could carry them to the observability sink.

  integrations: [
    // Explicit masking (matches the defaults, pinned on purpose): the console
    // renders Grafana passwords, S3 keys, and secret-status details as plain
    // text, so replays must never capture raw text/inputs/media or network
    // bodies.
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
      networkDetailAllowUrls: [],
    }),
  ],
});

// Hook into App Router navigation transitions
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
