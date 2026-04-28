import { headers } from "next/headers";
import { Shell } from "@/components/Shell";
import { StatusBadge } from "@/components/StatusBadge";
import { KpiGrid } from "@/components/overview/KpiGrid";
import { GpuCard } from "@/components/overview/GpuCard";
import { KafkaLagTable } from "@/components/overview/KafkaLagTable";
import { PodSummaryList } from "@/components/overview/PodSummaryList";
import { OverviewAutoRefresh } from "@/components/overview/OverviewAutoRefresh";
import { isKioskFromHeaders } from "@/lib/kiosk";
import { OverviewSnapshotSchema } from "@/lib/schemas";
import type { OverviewSnapshot, PodSummary } from "@/lib/types";

type OverviewFetchResult =
  | { kind: "ok"; snapshot: OverviewSnapshot; mode?: string }
  | { kind: "unauthorized" }
  | { kind: "unreachable"; status?: number };

async function fetchOverview(): Promise<OverviewFetchResult> {
  const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:8800";
  try {
    const hdrs = await headers();
    const cookie = hdrs.get("cookie") ?? "";
    const res = await fetch(`${baseUrl}/api/status/overview`, {
      cache: "no-store",
      headers: cookie ? { cookie } : {},
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (!res.ok) return { kind: "unreachable", status: res.status };
    const raw = (await res.json()) as { mode?: string } & Record<string, unknown>;
    const snapshot = OverviewSnapshotSchema.parse(raw);
    return { kind: "ok", snapshot, mode: typeof raw.mode === "string" ? raw.mode : undefined };
  } catch {
    return { kind: "unreachable" };
  }
}

async function fetchPods(): Promise<PodSummary[]> {
  const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:8800";
  try {
    const hdrs = await headers();
    const cookie = hdrs.get("cookie") ?? "";
    const res = await fetch(`${baseUrl}/api/pods`, {
      cache: "no-store",
      headers: cookie ? { cookie } : {},
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { pods?: PodSummary[] };
    return body.pods ?? [];
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${bytes} B`;
}

export default async function OverviewPage() {
  const hdrs = await headers();
  const kiosk = isKioskFromHeaders(hdrs);

  const [overviewResult, pods] = await Promise.all([fetchOverview(), fetchPods()]);
  const overview = overviewResult.kind === "ok" ? overviewResult.snapshot : null;
  const dockerMode = overviewResult.kind === "ok" && overviewResult.mode === "docker";

  // Group pods by namespace
  const nsByName = new Map<string, PodSummary[]>();
  for (const pod of pods) {
    if (!nsByName.has(pod.namespace)) nsByName.set(pod.namespace, []);
    nsByName.get(pod.namespace)!.push(pod);
  }

  const nsGroups = Array.from(nsByName.entries()).map(([namespace, nsPods]) => ({
    namespace,
    pods: nsPods,
    total: nsPods.length,
    ready: nsPods.filter((p) => p.ready).length,
  }));

  return (
    <Shell>
      {/* Auto-refresh client island */}
      <OverviewAutoRefresh />

      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              VSS Demo Console
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              ARTESCA × Pyramid × NVIDIA VSS operator view
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {kiosk && (
              <span className="rounded border border-primary/40 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                KIOSK
              </span>
            )}
            {dockerMode && (
              <span className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-400">
                COMPOSE
              </span>
            )}
            {overview && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {new Date(overview.takenAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>

        {/* No data / mode fallbacks */}
        {overviewResult.kind === "unauthorized" && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4">
            <p className="text-sm text-rose-300">
              Not signed in. <a href="/api/auth/signin" className="underline hover:text-rose-200">Sign in</a> to load operator views.
            </p>
          </div>
        )}
        {overviewResult.kind === "unreachable" && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
            <p className="text-sm text-yellow-400">
              Could not reach <code>/api/status/overview</code>
              {overviewResult.status ? <> (HTTP {overviewResult.status})</> : null}
              {" "}— the console pod may still be starting up. Data will appear automatically once available.
            </p>
          </div>
        )}
        {dockerMode && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-300">
            <p className="font-medium">Compose-mode runtime — k8s probes inactive.</p>
            <p className="mt-1 text-sky-300/80">
              The Overview KPIs (namespace pod counts, NIM warmup, GPU metrics from Prometheus, Kafka lag) are k8s-specific.
              On the docker compose path, navigate to{" "}
              <a href="/topology" className="underline hover:text-sky-200">/topology</a>,{" "}
              <a href="/cameras" className="underline hover:text-sky-200">/cameras</a>, or{" "}
              <a href="/chat" className="underline hover:text-sky-200">VSS Chat</a>{" "}
              for compose-mode operations.
            </p>
          </div>
        )}

        {/* Row 1 — KPI cards (k8s mode only — KPIs are zero/empty on docker) */}
        {overview && !dockerMode && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              System Overview
            </h2>
            <KpiGrid data={overview} />
          </section>
        )}

        {/* Row 2 — Per-namespace pod summary */}
        <section>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Namespaces
          </h2>
          <PodSummaryList groups={nsGroups} />
        </section>

        {/* Row 3 — GPU card grid */}
        {overview && overview.gpus.length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              GPUs
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {overview.gpus.map((gpu) => (
                <GpuCard key={gpu.index} gpu={gpu} />
              ))}
            </div>
          </section>
        )}

        {/* Row 4 — Kafka lag table */}
        {overview && Object.keys(overview.kafka).length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Kafka Consumer Lag
            </h2>
            <div className="rounded-lg border border-border bg-card p-4">
              <KafkaLagTable kafka={overview.kafka} />
            </div>
          </section>
        )}

        {/* Row 5 — S3 bucket stats */}
        {overview && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              S3 Bucket
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-card p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  Bucket
                </p>
                <p className="font-mono text-sm font-semibold">
                  {overview.s3.bucket}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  Objects / Total Size
                </p>
                <p className="text-xl font-bold tabular-nums">
                  {overview.s3.objectCount.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(overview.s3.bytesTotal)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  24h Growth
                </p>
                <p className="text-xl font-bold tabular-nums">
                  {formatBytes(overview.s3.growth24h)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {(overview.s3.growth24h / (24 * 3600 * 1024 * 1024)).toFixed(3)}{" "}
                  MB/s avg
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Row 6 — Camera-sim card */}
        {overview && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Camera Simulator
            </h2>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-6">
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">Instance State</p>
                  <StatusBadge
                    health={
                      overview.cameraSim.instanceState === "running"
                        ? "ok"
                        : overview.cameraSim.instanceState === "stopped"
                          ? "warn"
                          : "fail"
                    }
                    label={overview.cameraSim.instanceState}
                  />
                </div>
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">Paths Ready</p>
                  <p className="text-xl font-bold tabular-nums">
                    {overview.cameraSim.pathsReady}/{overview.cameraSim.pathsTotal}
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </Shell>
  );
}
