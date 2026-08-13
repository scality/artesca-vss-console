import { headers } from "next/headers";
import { Shell } from "@/components/Shell";
import { HealthBanner } from "@/components/overview/HealthBanner";
import { KpiGrid } from "@/components/overview/KpiGrid";
import { GpuCard } from "@/components/overview/GpuCard";
import { GpuSharingCard } from "@/components/overview/GpuSharingCard";
import { GrafanaAccessCard } from "@/components/overview/GrafanaAccessCard";
import { ConnectivityStrip } from "@/components/overview/ConnectivityStrip";
import { KafkaLagTable } from "@/components/overview/KafkaLagTable";
import { PodSummaryList } from "@/components/overview/PodSummaryList";
import { OverviewAutoRefresh } from "@/components/overview/OverviewAutoRefresh";
import { KioskHero } from "@/components/overview/KioskHero";
import { isKioskFromHeaders } from "@/lib/kiosk";
import {
  collectOverviewSnapshot,
  collectPodSummaries,
  type PodsResult,
} from "@/lib/overview-collector";
import { collectHeroExtras } from "@/lib/hero-collector";
import { CLUSTER } from "@/lib/cluster-refs";

export default async function OverviewPage() {
  const hdrs = await headers();
  const kiosk = isKioskFromHeaders(hdrs);

  const [overviewResult, podsResult, heroExtras] = await Promise.all([
    collectOverviewSnapshot(),
    // Kiosk shows no namespace/pod plumbing — skip the pod list there.
    kiosk
      ? Promise.resolve<PodsResult>({ pods: [], warnings: [] })
      : collectPodSummaries(),
    kiosk ? collectHeroExtras() : Promise.resolve(null),
  ]);
  const { snapshot: overview } = overviewResult;
  const pods = podsResult.pods;

  // Kiosk / showroom display: a story-first hero, no cluster plumbing.
  if (kiosk && heroExtras) {
    return (
      <Shell>
        <OverviewAutoRefresh />
        <KioskHero overview={overview} extras={heroExtras} />
      </Shell>
    );
  }

  // Degraded probes record *why* in warnings[]; surface them so an empty panel
  // (e.g. a missing GPU section) explains itself instead of silently vanishing.
  const warnings = Array.from(
    new Set([...overviewResult.warnings, ...podsResult.warnings])
  );

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
    // the namespace as N-1/N WARN.
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

        {/* Row 1 — KPI cards. */}
        {hasOverviewData && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              System Overview
            </h2>
            <KpiGrid data={overview} />
          </section>
        )}

        {/* Row 2 — Per-namespace summary. */}
        {(nsGroups.length > 0 || Object.keys(overview.namespaces).length > 0) && (
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Namespaces
            </h2>
            <PodSummaryList groups={nsGroups} />
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

            {/* Monitoring access — URL and user in clear; the password is fetched
                on request from POST /api/grafana-credential, which audits the
                reveal. Passing it as a prop would put it back in this server
                component's payload on every dashboard load, which is the thing
                ISVD-550 removes. `hasPassword` is a boolean by design. */}
            {CLUSTER.grafana.url && (
              <GrafanaAccessCard
                url={CLUSTER.grafana.url}
                user={CLUSTER.grafana.user}
                hasPassword={Boolean(CLUSTER.grafana.password)}
                loginHint={CLUSTER.grafana.loginHint}
              />
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

      </div>
    </Shell>
  );
}
