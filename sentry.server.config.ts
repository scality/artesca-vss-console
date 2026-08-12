import * as Sentry from "@/lib/telemetry";
import { serverTelemetryDsn, tracesSampleRate } from "@/lib/telemetry-config";

const dsn = serverTelemetryDsn();

// No DSN, no init. Calling Sentry.init with an undefined dsn installs the SDK's
// global handlers and then drops every event, which reads in a log as working
// telemetry. Skipping the call entirely is what makes "off" observable.
if (dsn) {
  Sentry.init({
    dsn,

    tracesSampleRate: tracesSampleRate(),

    // Deliberately NO includeLocalVariables and NO enableLogs: server code holds
    // lab secrets (S3/objectstore keys, the camera-sim SSH PEM, Firestore SA key,
    // ARTESCA Grafana/Keycloak passwords) in locals and logs cluster command
    // lines — neither may reach the observability sink.
  });
}
