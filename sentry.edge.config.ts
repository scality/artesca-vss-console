import * as Sentry from "@sentry/nextjs";
import { serverTelemetryDsn, tracesSampleRate } from "@/lib/telemetry-config";

// The DSN was inlined here rather than imported from sentry.server.config,
// because importing that module would run its Sentry.init in the edge runtime.
// src/lib/telemetry-config.ts has no side effects, so it is safe to share.
const dsn = serverTelemetryDsn();

if (dsn) {
  Sentry.init({
    dsn,

    tracesSampleRate: tracesSampleRate(),
  });
}
