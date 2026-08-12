import { Shell } from "@/components/Shell";
import { ExternalLink } from "lucide-react";
import { gcsHealthCheck, gcsCamerasGet, gcsPromptGet, gcsScenariosGet } from "@/lib/helpers/gcs-config";
import { configStoreHealthCheck } from "@/lib/config-store";
import { serverTelemetryDsn, clientTelemetryDsn } from "@/lib/telemetry-config";

interface ServiceUrlRow {
  label: string;
  envVar: string;
  value: string;
}

function buildServiceUrls(): ServiceUrlRow[] {
  return [
    {
      label: "Kafka Brokers",
      envVar: "KAFKA_BROKERS",
      value: process.env.KAFKA_BROKERS ?? "(not configured)",
    },
    {
      label: "Redis URL",
      envVar: "REDIS_URL",
      value: process.env.REDIS_URL ? "[configured — masked]" : "(not configured)",
    },
    {
      label: "VST Sensor URL",
      envVar: "VST_SENSOR_URL",
      value: process.env.VST_SENSOR_URL ?? "(defaults from VSS_NAMESPACE)",
    },
    {
      label: "VST MS URL",
      envVar: "VST_MS_URL",
      value: process.env.VST_MS_URL ?? "(not set)",
    },
    {
      label: "mediamtx API URL",
      envVar: "MEDIAMTX_API_URL",
      value: process.env.MEDIAMTX_API_URL ?? `http://${process.env.CAMERA_SIM_HOST ?? "camera-sim-host"}:9997`,
    },
    {
      label: "Camera Sim Host",
      envVar: "CAMERA_SIM_HOST",
      value: process.env.CAMERA_SIM_HOST ?? "(not configured)",
    },
    {
      label: "Prometheus URL",
      envVar: "PROMETHEUS_URL",
      value: process.env.PROMETHEUS_URL ?? "http://prometheus.monitoring.svc.cluster.local:9090",
    },
    {
      label: "Object-store Endpoint",
      envVar: "OBJECTSTORE_ENDPOINT",
      value:
        process.env.OBJECTSTORE_ENDPOINT ??
        process.env.S3_ENDPOINT ??
        "(AWS default — virtual-hosted style)",
    },
    {
      label: "Object-store Bucket (video)",
      envVar: "OBJECTSTORE_BUCKET",
      value:
        process.env.OBJECTSTORE_BUCKET ??
        process.env.S3_BUCKET ??
        process.env.VSS_VIDEO_BUCKET ??
        "nvidia-vss-recordings",
    },
    {
      label: "NIM Preview Endpoint",
      envVar: "NIM_PREVIEW_ENDPOINT",
      value: process.env.NIM_PREVIEW_ENDPOINT ?? "(not configured)",
    },
    {
      label: "NIM Model",
      envVar: "NIM_PREVIEW_MODEL",
      value: process.env.NIM_PREVIEW_MODEL ?? "(not configured)",
    },
    {
      label: "Alert Worker URL",
      envVar: "ALERT_WORKER_URL",
      value: process.env.ALERT_WORKER_URL ?? "(not configured)",
    },
    {
      label: "GCS Config Bucket",
      envVar: "GCS_CONFIG_BUCKET",
      value: process.env.GCS_CONFIG_BUCKET ?? "scality-isv-labs-config (default)",
    },
    {
      label: "GCS Credentials",
      envVar: "GOOGLE_APPLICATION_CREDENTIALS",
      value: process.env.GOOGLE_APPLICATION_CREDENTIALS
        ? "[configured — masked]"
        : "(not configured)",
    },
    {
      label: "VSS Instance Name",
      envVar: "VSS_INSTANCE_NAME",
      value: process.env.VSS_INSTANCE_NAME ?? "(not configured)",
    },
  ];
}

const DOCS = [
  {
    label: "Console Design Doc",
    href: "/docs/console-design.md",
    external: false,
  },
  {
    label: "Demo Runbook",
    href: "/docs/demo-runbook.md",
    external: false,
  },
  {
    label: "Troubleshooting Guide",
    href: "/docs/troubleshooting.md",
    external: false,
  },
  {
    label: "Architecture Overview",
    href: "/docs/architecture.md",
    external: false,
  },
  {
    label: "Pre-install Dashboard (:5002)",
    href: "http://localhost:5002",
    external: true,
  },
];

export default async function AboutPage() {
  const gitSha =
    process.env.NEXT_PUBLIC_GIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    null;

  const buildDate = new Date().toISOString().split("T")[0];
  const nodeVersion = process.version;
  const serviceUrls = buildServiceUrls();

  // GCS health — run at render time (server component).
  const gcsHealth = await gcsHealthCheck().catch(() => ({
    status: "error" as const,
    detail: "health check threw unexpectedly",
  }));

  // Per-surface object existence check (only if GCS is reachable).
  const instance = process.env.VSS_INSTANCE_NAME ?? "";
  const [cameraObj, promptObj, scenariosObj] =
    gcsHealth.status === "ok" && instance
      ? await Promise.all([
          gcsCamerasGet(instance).catch(() => null),
          gcsPromptGet(instance).catch(() => null),
          gcsScenariosGet(instance).catch(() => null),
        ])
      : [null, null, null];

  // Config-store health (the k8s-path runtime-config canonical) — run at render
  // time. Reports whichever backend this pod actually selected, which is the
  // thing worth showing: the selection can be inferred rather than set, and a
  // pod reading an empty YAML file looks exactly like a fresh instance.
  const storeHealth = await configStoreHealthCheck(instance).catch(() => ({
    kind: "file" as const,
    inferred: false,
    status: "error" as const,
    detail: "health check threw unexpectedly",
    location: "",
    counts: undefined,
  }));

  return (
    <Shell>
      <div className="max-w-3xl space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">About</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build information, service endpoints, and documentation links.
          </p>
        </div>

        {/* Build info */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Build
          </h2>
          <div className="grid grid-cols-2 gap-y-3 gap-x-6 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Git SHA</p>
              <p className="font-mono text-xs mt-0.5">
                {gitSha ? (
                  <span title={gitSha}>{gitSha.slice(0, 12)}</span>
                ) : (
                  <span className="text-muted-foreground">dev / unknown</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Build Date</p>
              <p className="font-mono text-xs mt-0.5">{buildDate}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Node.js</p>
              <p className="font-mono text-xs mt-0.5">{nodeVersion}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Next.js</p>
              <p className="font-mono text-xs mt-0.5">
                {/* Next.js version from package constants */}
                {process.env.NEXT_PUBLIC_VERSION ?? "16.x"}
              </p>
            </div>
          </div>
        </section>

        {/* Service URLs */}
        <section className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Service URLs
            </h2>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {serviceUrls.map(({ label, envVar, value }) => (
                <tr key={envVar} className="hover:bg-muted/20 transition-colors">
                  <td className="px-5 py-2.5">
                    <p className="font-medium">{label}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {envVar}
                    </p>
                  </td>
                  <td className="px-5 py-2.5">
                    <p className="font-mono text-xs break-all">{value}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Documentation links */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Documentation
          </h2>
          <div className="flex flex-col gap-2">
            {DOCS.map(({ label, href, external }) => (
              <a
                key={href}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
                className="flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                {label}
                {external && <ExternalLink className="h-3 w-3 shrink-0" />}
              </a>
            ))}
          </div>
        </section>

        {/* GCS persistence health */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            GCS Config Persistence
          </h2>

          {/* Overall health */}
          <div className="flex items-center gap-3">
            <span
              className={
                gcsHealth.status === "ok"
                  ? "text-emerald-700 font-semibold text-sm"
                  : gcsHealth.status === "no-credentials"
                    ? "text-amber-700 font-semibold text-sm"
                    : "text-muted-foreground font-semibold text-sm"
              }
            >
              {gcsHealth.status === "ok"
                ? "available"
                : gcsHealth.status === "no-credentials"
                  ? "no credentials"
                  : gcsHealth.status === "no-gcloud"
                    ? "no gcloud"
                    : "error"}
            </span>
            {gcsHealth.detail && (
              <span className="text-xs text-muted-foreground">{gcsHealth.detail}</span>
            )}
          </div>

          {/* Per-surface object status (only shown when GCS reachable) */}
          {gcsHealth.status === "ok" && instance && (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {[
                  {
                    surface: "Cameras",
                    path: `cameras/${instance}.json`,
                    obj: cameraObj,
                    detail: cameraObj
                      ? `${(cameraObj as { cameras?: unknown[] }).cameras?.length ?? 0} cameras · updated ${(cameraObj as { updatedAt?: string }).updatedAt ?? "?"}`
                      : null,
                  },
                  {
                    surface: "Prompt",
                    path: `prompt/${instance}.json`,
                    obj: promptObj,
                    detail: promptObj
                      ? `updated ${(promptObj as { updatedAt?: string }).updatedAt ?? "?"} by ${(promptObj as { updatedBy?: string }).updatedBy ?? "?"}`
                      : null,
                  },
                  {
                    surface: "Scenarios",
                    path: `scenarios/${instance}.json`,
                    obj: scenariosObj,
                    detail: scenariosObj
                      ? `${(scenariosObj as { scenarios?: unknown[] }).scenarios?.length ?? 0} scenarios · updated ${(scenariosObj as { updatedAt?: string }).updatedAt ?? "?"}`
                      : null,
                  },
                ].map(({ surface, path, obj, detail }) => (
                  <tr key={surface} className="hover:bg-muted/20 transition-colors">
                    <td className="py-2 pr-4">
                      <p className="font-medium text-sm">{surface}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{path}</p>
                    </td>
                    <td className="py-2">
                      {obj ? (
                        <span className="text-emerald-700 text-xs font-semibold">object exists</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">object missing</span>
                      )}
                      {detail && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">{detail}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="text-xs text-muted-foreground">
            Bucket:{" "}
            <code className="font-mono">
              gs://{process.env.GCS_CONFIG_BUCKET ?? "scality-isv-labs-config"}/
            </code>
            . Mount the service account key at{" "}
            <code className="font-mono">/etc/gcs-config-rw.json</code> and set{" "}
            <code className="font-mono">GOOGLE_APPLICATION_CREDENTIALS</code>.
          </p>
        </section>

        {/* Config store health (k8s-path runtime-config canonical) */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Config Store — {storeHealth.kind === "file" ? "YAML file" : "Firestore"}
          </h2>

          <div className="flex items-center gap-3">
            <span
              className={
                storeHealth.status === "ok"
                  ? "text-emerald-700 font-semibold text-sm"
                  : storeHealth.status === "no-credentials" ||
                      storeHealth.status === "unconfigured"
                    ? "text-amber-700 font-semibold text-sm"
                    : "text-muted-foreground font-semibold text-sm"
              }
            >
              {storeHealth.status === "ok"
                ? "available"
                : storeHealth.status === "unconfigured"
                  ? "not configured"
                  : storeHealth.status === "no-credentials"
                    ? "no credentials"
                    : "error"}
            </span>
            {storeHealth.detail && (
              <span className="text-xs text-muted-foreground">{storeHealth.detail}</span>
            )}
          </div>

          {/* An inferred selection is called out, because nobody chose it. It
              happens when FIRESTORE_PROJECT_ID is set and CONSOLE_CONFIG_STORE is
              not — the shape an instance is left in by `kubectl set image`. */}
          {storeHealth.inferred && (
            <p className="text-xs text-amber-700">
              Backend inferred from <code className="font-mono">FIRESTORE_PROJECT_ID</code>, not
              selected. Set <code className="font-mono">CONSOLE_CONFIG_STORE</code> to{" "}
              <code className="font-mono">file</code> or{" "}
              <code className="font-mono">firestore</code> to make it explicit.
            </p>
          )}

          {storeHealth.status === "ok" && storeHealth.counts && (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {[
                  {
                    surface: "Prompt sets",
                    path: storeHealth.kind === "file" ? "promptSets[]" : `instances/${instance}/prompts`,
                    n: storeHealth.counts.promptSets,
                  },
                  {
                    surface: "Cameras",
                    path: storeHealth.kind === "file" ? "cameras[]" : `instances/${instance}/cameras`,
                    n: storeHealth.counts.cameras,
                  },
                  {
                    surface: "Scenarios",
                    path: storeHealth.kind === "file" ? "scenarios[]" : `instances/${instance}/scenarios`,
                    n: storeHealth.counts.scenarios,
                  },
                ].map(({ surface, path, n }) => (
                  <tr key={surface} className="hover:bg-muted/20 transition-colors">
                    <td className="py-2 pr-4">
                      <p className="font-medium text-sm">{surface}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{path}</p>
                    </td>
                    <td className="py-2">
                      <span className="text-emerald-700 text-xs font-semibold">
                        {n} {storeHealth.kind === "file" ? "entr" : "doc"}
                        {storeHealth.kind === "file" ? (n === 1 ? "y" : "ies") : n === 1 ? "" : "s"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="text-xs text-muted-foreground">
            {storeHealth.kind === "file" ? "File" : "Project/database"}{" "}
            <code className="font-mono">{storeHealth.location || "(none)"}</code> · instance{" "}
            <code className="font-mono">{instance || "(not configured)"}</code>. The k8s-path
            runtime config (cameras / prompt-sets / scenarios) the console + reconcile-agent
            read and write; set <code className="font-mono">VSS_INSTANCE_NAME</code> to select
            the instance.{" "}
            {storeHealth.kind === "file" ? (
              <>
                One YAML file per instance under{" "}
                <code className="font-mono">CONSOLE_DATA_DIR</code>, which must be a volume both
                pods mount — a store on a container filesystem is a store each pod has its own
                private copy of.
              </>
            ) : (
              <>
                Credentials from <code className="font-mono">GOOGLE_APPLICATION_CREDENTIALS</code>{" "}
                (secret <code className="font-mono">config-store-rw</code>).
              </>
            )}
          </p>
        </section>

        {/* Telemetry. Reported because it is off unless configured (ISVD-607) and
            there is otherwise no way to tell short of causing an error: the SDK
            is silent either way, and a pod that reports nothing looks exactly
            like a pod with nothing to report. */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Telemetry
          </h2>

          <div className="flex items-center gap-3">
            <span
              className={
                serverTelemetryDsn()
                  ? "text-emerald-700 font-semibold text-sm"
                  : "text-muted-foreground font-semibold text-sm"
              }
            >
              {serverTelemetryDsn() ? "reporting" : "off"}
            </span>
            <span className="text-xs text-muted-foreground">
              server + edge {serverTelemetryDsn() ? "— SENTRY_DSN set" : "— no SENTRY_DSN"}
              {" · "}browser {clientTelemetryDsn() ? "reporting" : "off"}
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            The image carries no DSN. Set <code className="font-mono">SENTRY_DSN</code> in the{" "}
            <code className="font-mono">console-env</code> ConfigMap for server and edge
            reporting. The browser bundle reads{" "}
            <code className="font-mono">NEXT_PUBLIC_SENTRY_DSN</code>, which is inlined at build
            time — a ConfigMap value cannot reach it, so enabling it needs a rebuild.
          </p>
        </section>

        {/* License */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            License
          </h2>
          <p className="text-sm text-muted-foreground">
            Scality internal tooling — not for distribution. ARTESCA × Pyramid ×
            NVIDIA VSS demo console.
          </p>
        </section>
      </div>
    </Shell>
  );
}
