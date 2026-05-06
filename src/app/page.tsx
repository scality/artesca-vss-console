import { headers } from "next/headers";
import { Shell } from "@/components/Shell";
import { StatusBadge } from "@/components/StatusBadge";
import { KpiGrid } from "@/components/overview/KpiGrid";
import { GpuCard } from "@/components/overview/GpuCard";
import { KafkaLagTable } from "@/components/overview/KafkaLagTable";
import { PodSummaryList } from "@/components/overview/PodSummaryList";
import { OverviewAutoRefresh } from "@/components/overview/OverviewAutoRefresh";
import { isKioskFromHeaders } from "@/lib/kiosk";
import { collectOverviewSnapshot, collectPodSummaries } from "@/lib/overview-collector";

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${bytes} B`;
}

export default async function OverviewPage() {
  const hdrs = await headers();
  const kiosk = isKioskFromHeaders(hdrs);

  const [overviewResult, podsResult] = await Promise.all([
    collectOverviewSnapshot(),
    collectPodSummaries(),
  ]);
  const { snapshot: overview, mode, warnings } = overviewResult;
  const dockerMode = mode === "docker";
  const pods = podsResult.pods;

  // Group pods by namespace
  const nsByName = new Map<string, typeof pods>();
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

  const hasOverviewData =
    overview.gpus.length > 0 || Object.keys(overview.namespaces).length > 0;

  return (
    <Shell>
      {/* Auto-refresh client island */}
      <OverviewAutoRefresh />

      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Scality VSS Console
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
            <p className="text-xs text-muted-foreground tabular-nums">
              {new Date(overview.takenAt).toLocaleTimeString()}
            </p>
          </div>
        </div>

        {/* Compose-mode empty hint */}
        {dockerMode && Object.keys(overview.namespaces).length === 0 && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-300">
            <p className="font-medium">Compose-mode runtime — no compose containers detected.</p>
            <p className="mt-1 text-sky-300/80">
              Run <code>scripts/stacks/nvidia-vss/bootstrap-compose.sh</code> on the workspace to bring up the stack.
              KPIs and topology populate automatically once containers are running.
            </p>
          </div>
        )}

        {/* Degraded-collector hint: shown only when probes failed AND we
            have nothing to render. Healthy probes that produce partial
            data don't trigger this — warnings stay in pod logs. */}
        {!hasOverviewData && warnings.length > 0 && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 space-y-2">
            <p className="text-sm font-medium text-yellow-300">
              Overview probes failed — no data to show yet.
            </p>
            <ul className="text-xs text-yellow-400/80 font-mono space-y-0.5 max-h-32 overflow-y-auto">
              {warnings.slice(0, 8).map((w, i) => (
                <li key={i} className="break-all">{w}</li>
              ))}
            </ul>
            <p className="text-xs text-yellow-400/80">
              The page polls every 5 s and recovers automatically once probes succeed.
              For deeper diagnosis: <code>kubectl logs -n console -l app=console --tail=100</code>{" "}
              (k8s) or <code>docker logs vss-console</code> (compose).
            </p>
          </div>
        )}

        {/* Row 1 — KPI cards. Docker path populates the same OverviewSnapshot
            shape from docker.sock + nvidia-smi exec, so the grid renders unchanged. */}
        {hasOverviewData && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {dockerMode ? "Compose Stack Overview" : "System Overview"}
            </h2>
            <KpiGrid data={overview} />
          </section>
        )}

        {/* Row 2 — Per-namespace summary (compose services on docker mode). */}
        {(nsGroups.length > 0 || Object.keys(overview.namespaces).length > 0) && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {dockerMode ? "Compose Services" : "Namespaces"}
            </h2>
            {dockerMode ? (
              <PodSummaryList
                groups={Object.entries(overview.namespaces).map(([namespace, n]) => ({
                  namespace,
                  pods: [],
                  total: n.total,
                  ready: n.ready,
                }))}
              />
            ) : (
              <PodSummaryList groups={nsGroups} />
            )}
          </section>
        )}

        {/* Row 3 — GPU card grid */}
        {overview.gpus.length > 0 && (
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
        {Object.keys(overview.kafka).length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Kafka Consumer Lag
            </h2>
            <div className="rounded-lg border border-border bg-card p-4">
              <KafkaLagTable kafka={overview.kafka} />
            </div>
          </section>
        )}

        {/* Row 5 — S3 bucket stats. Shown when bucket is configured in either mode. */}
        {overview.s3.bucket && (
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

        {/* Row 6 — Camera-sim card (k8s mode only — compose path doesn't yet wire camera-sim probes) */}
        {!dockerMode && (
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
