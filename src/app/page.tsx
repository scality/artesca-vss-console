import { headers } from "next/headers";
import { Shell } from "@/components/Shell";
import { HealthBanner } from "@/components/overview/HealthBanner";
import { KpiGrid } from "@/components/overview/KpiGrid";
import { GpuCard } from "@/components/overview/GpuCard";
import { GpuSharingCard } from "@/components/overview/GpuSharingCard";
import { ConnectivityStrip } from "@/components/overview/ConnectivityStrip";
import { KafkaLagTable } from "@/components/overview/KafkaLagTable";
import { PodSummaryList } from "@/components/overview/PodSummaryList";
import { OverviewAutoRefresh } from "@/components/overview/OverviewAutoRefresh";
import { isKioskFromHeaders } from "@/lib/kiosk";
import { collectOverviewSnapshot, collectPodSummaries } from "@/lib/overview-collector";
import { CLUSTER } from "@/lib/cluster-refs";

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
  const { snapshot: overview, mode } = overviewResult;
  const dockerMode = mode === "docker";
  const pods = podsResult.pods;

  // Degraded probes record *why* in warnings[]; surface them so an empty panel
  // (e.g. a missing GPU section) explains itself instead of silently vanishing.
  // The compose-empty case has its own hint below, so drop that specific noise.
  const warnings = Array.from(
    new Set([...overviewResult.warnings, ...podsResult.warnings])
  ).filter((w) => !(dockerMode && w.includes("No containers found")));

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
    // Completed Jobs (Succeeded) carry no Ready condition but are terminal
    // successes — count them toward ready so a finished one-shot doesn't show
    // the namespace as N-1/N WARN. Matches the docker path's succeeded→ready.
    ready: nsPods.filter((p) => p.ready || p.phase === "Succeeded").length,
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
              {kiosk ? "Scality VSS Console" : "Overview"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              ARTESCA × Pyramid × NVIDIA VSS operator view
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ConnectivityStrip />
              {overview.recording && (overview.recording.recovering > 0 || overview.recording.degraded > 0) && (
                <span
                  className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                  title="Guarded recording auto-heal — cameras currently being re-armed or that exhausted their re-arm attempts"
                >
                  Recording recovery: {overview.recording.recovering} recovering, {overview.recording.degraded} degraded
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {kiosk && (
              <span className="rounded border border-primary/40 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                KIOSK
              </span>
            )}
            {dockerMode && (
              <span className="rounded border border-brand-teal/30 bg-brand-teal-soft px-2 py-1 text-xs font-medium text-brand-teal">
                COMPOSE
              </span>
            )}
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Updated {new Date(overview.takenAt).toLocaleTimeString()}
            </span>
          </div>
        </div>

        {/* At-a-glance system verdict — worst-of across pods / NIM / GPU /
            Kafka / cameras / monitoring. Hidden until there's real data. */}
        {hasOverviewData && (
          <HealthBanner overview={overview} warningCount={warnings.length} />
        )}

        {/* Degraded-probe banner — lists which probes failed so empty panels
            are explained rather than silently absent. */}
        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-700">
              {warnings.length} probe{warnings.length > 1 ? "s" : ""} degraded — affected panels may be empty
            </p>
            <ul className="mt-2 space-y-1">
              {warnings.map((w) => (
                <li key={w} className="font-mono text-xs text-amber-700/70 break-all">
                  • {w}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Compose-mode empty hint */}
        {dockerMode && Object.keys(overview.namespaces).length === 0 && (
          <div className="rounded-lg border border-brand-teal/30 bg-brand-teal-soft p-4 text-sm text-brand-teal">
            <p className="font-medium">Compose-mode runtime — no compose containers detected.</p>
            <p className="mt-1 text-brand-teal/80">
              Run <code>scripts/stacks/nvidia-vss/bootstrap-compose.sh</code> on the workspace to bring up the stack.
              KPIs and topology populate automatically once containers are running.
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
            <div className="mb-3">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                GPUs
              </h2>
            </div>

            {/* Monitoring access — URL + login surfaced in clear so the operator
                can open the historical GPU dashboard without hunting for creds. */}
            {CLUSTER.grafana.url && (
              <div className="mb-4 rounded-lg border border-brand-light-gray bg-muted p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Historical graphs — Grafana
                  </p>
                  <a
                    href={CLUSTER.grafana.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-brand-teal hover:text-brand-teal/80 hover:underline"
                  >
                    Open Grafana ↗
                  </a>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">URL</dt>
                    <dd className="font-mono text-xs break-all">
                      <a
                        href={CLUSTER.grafana.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-teal hover:text-brand-teal/80 hover:underline"
                      >
                        {CLUSTER.grafana.url}
                      </a>
                    </dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">User</dt>
                    <dd className="font-mono text-xs select-all">{CLUSTER.grafana.user}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground uppercase tracking-wider">Password</dt>
                    <dd className="font-mono text-xs select-all break-all">
                      {CLUSTER.grafana.password || "—"}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  {CLUSTER.grafana.loginHint}
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {overview.gpus.map((gpu) => (
                <GpuCard key={gpu.index} gpu={gpu} />
              ))}
            </div>

            {/* How the GPUs are shared across workloads (live, per-pod VRAM) */}
            <h3 className="mt-5 mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Sharing across workloads
            </h3>
            <GpuSharingCard />
          </section>
        )}

        {/* Row 4 — Kafka lag table */}
        {Object.keys(overview.kafka).length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Kafka Topic Depth
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
      </div>
    </Shell>
  );
}
