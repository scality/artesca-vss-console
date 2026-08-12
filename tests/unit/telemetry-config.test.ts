// ISVD-607. Two properties, and the source-scan half is the one that survives a
// refactor: the DSN and the GCP project id were each compiled in as a fallback,
// so an outside build with no configuration reported its errors into Scality's
// Sentry project and looked for its state in Scality's GCP project. Nothing
// failed — that is what makes it worth a test rather than a code review.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  serverTelemetryDsn,
  clientTelemetryDsn,
  tracesSampleRate,
} from "@/lib/telemetry-config";

const ROOT = path.resolve(__dirname, "../..");

// Every file that may not carry an ingest endpoint or a project id.
const SOURCES = [
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "src/instrumentation-client.ts",
  "src/lib/telemetry-config.ts",
  "src/lib/config-store/firestore.ts",
  "src/app/about/page.tsx",
];

describe("no vendor endpoint is compiled in", () => {
  it("carries no Sentry ingest host or DSN key", () => {
    for (const rel of SOURCES) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      // A DSN is https://<32-hex>@<host>.ingest.<region>.sentry.io/<id>. Match the
      // shape rather than the specific value, so a different account's DSN fails
      // this too — the point is that no ingest endpoint belongs in the tree.
      expect(src, `${rel} contains a Sentry DSN`).not.toMatch(
        /https:\/\/[0-9a-f]{16,}@[\w.-]*ingest[\w.-]*\.sentry\.io/i,
      );
      expect(src, `${rel} names a Sentry org ingest host`).not.toMatch(/o\d{10,}\.ingest\./);
    }
  });

  it("hardcodes no GCP project as a fallback", () => {
    for (const rel of SOURCES) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      // `?? "some-project"` after a project-id env read is the exact shape that
      // was removed from three sites. A comment mentioning a project is fine;
      // a fallback expression is not.
      expect(src, `${rel} defaults the GCP project`).not.toMatch(
        /(FIRESTORE_PROJECT_ID|GOOGLE_CLOUD_PROJECT)[\s\S]{0,80}\?\?\s*["'][a-z0-9-]+["']/,
      );
    }
  });
});

describe("telemetry is off unless configured", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reports no DSN when the env is unset", () => {
    expect(serverTelemetryDsn()).toBeUndefined();
    expect(clientTelemetryDsn()).toBeUndefined();
  });

  it("treats a blank or whitespace value as unset", () => {
    // A ConfigMap key present with an empty value is the normal shape of "left
    // to be filled in". `??` alone accepts it and hands Sentry an empty DSN,
    // which initialises the SDK and then drops every event.
    process.env.SENTRY_DSN = "";
    process.env.NEXT_PUBLIC_SENTRY_DSN = "   ";
    expect(serverTelemetryDsn()).toBeUndefined();
    expect(clientTelemetryDsn()).toBeUndefined();
  });

  it("returns a configured DSN, trimmed", () => {
    process.env.SENTRY_DSN = " https://abc@o1.ingest.de.sentry.io/2 ";
    expect(serverTelemetryDsn()).toBe("https://abc@o1.ingest.de.sentry.io/2");
  });

  it("keeps the two runtimes' variables separate", () => {
    // Next inlines NEXT_PUBLIC_* into client code and replaces everything else
    // with undefined, so a shared reader would silently disable browser
    // reporting while the server kept working.
    process.env.SENTRY_DSN = "https://server@o1.ingest.de.sentry.io/2";
    expect(clientTelemetryDsn()).toBeUndefined();
  });

  it("guards every init call on a configured DSN", () => {
    for (const rel of ["sentry.server.config.ts", "sentry.edge.config.ts", "src/instrumentation-client.ts"]) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src, `${rel} calls Sentry.init unguarded`).toMatch(/if\s*\(\s*dsn\s*\)/);
    }
  });

  it("samples 100% in development and 10% otherwise", () => {
    expect(tracesSampleRate()).toBe(process.env.NODE_ENV === "development" ? 1.0 : 0.1);
  });
});
