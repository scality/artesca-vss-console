import { Shell } from "@/components/Shell";
import { ExternalLink } from "lucide-react";

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
      value: process.env.VST_SENSOR_URL ?? "http://sensor-ms.vst.svc.cluster.local:5010/api/v1/live/sensor",
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
        "vss-video",
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

export default function AboutPage() {
  const gitSha =
    process.env.NEXT_PUBLIC_GIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    null;

  const buildDate = new Date().toISOString().split("T")[0];
  const nodeVersion = process.version;
  const serviceUrls = buildServiceUrls();

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
