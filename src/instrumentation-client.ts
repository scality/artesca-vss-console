import * as Sentry from "@sentry/nextjs";
import { clientTelemetryDsn, tracesSampleRate } from "@/lib/telemetry-config";

const dsn = clientTelemetryDsn();

if (dsn) {
  Sentry.init({
    dsn,

    tracesSampleRate: tracesSampleRate(),

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
}

// Exported unconditionally: Next calls this hook on every App Router
// navigation, and an undefined export would break navigation rather than
// telemetry. With no init it is a no-op.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
