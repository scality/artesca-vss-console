import Link from "next/link";
import { Camera, AlertTriangle, HardDrive, Cpu, ArrowRight } from "lucide-react";
import type { OverviewSnapshot, Incident } from "@/lib/types";
import type { HeroExtras } from "@/lib/hero-collector";
import { formatBytes } from "@/lib/format-bytes";
import { formatAge } from "@/lib/format-age";

/**
 * KioskHero — the showroom story hero shown at `/?mode=kiosk`.
 *
 * Reads as a narrative for a non-engineer audience (NVIDIA, Pyramid): the video
 * AI watches N cameras, has detected M incidents, and remembers everything on
 * ARTESCA on-premises — running on NVIDIA compute. No cluster plumbing (Kafka,
 * namespaces, Grafana creds) — that stays in the operator (non-kiosk) view.
 *
 * Server component: the page's OverviewAutoRefresh island calls router.refresh()
 * every 5s, so these values update live without an island of their own.
 */

type H = "ok" | "warn" | "fail";
const RANK: Record<H, number> = { ok: 0, warn: 1, fail: 2 };
const worst = (hs: H[]): H => hs.reduce<H>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

const SEVERITY_BADGE: Record<Incident["severity"], string> = {
  low: "bg-blue-50 text-blue-700 border-blue-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-red-50 text-red-700 border-red-200",
};

/** "NVIDIA RTX PRO 6000 Blackwell Server Edition" → "RTX PRO 6000 Blackwell". */
function shortGpuName(name: string): string {
  return name
    .replace(/^NVIDIA\s+/i, "")
    .replace(/\s+Server Edition$/i, "")
    .trim();
}

/** Kiosk verdict — worst-of the audience-meaningful signals only (no plumbing). */
function heroVerdict(overview: OverviewSnapshot): H {
  const signals: H[] = [];
  signals.push(overview.nim.ready ? "ok" : "warn");
  if (overview.gpus.length > 0) {
    const maxTemp = Math.max(...overview.gpus.map((g) => g.tempC));
    signals.push(maxTemp >= 85 ? "fail" : maxTemp >= 70 ? "warn" : "ok");
  }
  const { pathsReady, pathsTotal } = overview.cameraSim;
  if (pathsTotal > 0) {
    signals.push(pathsReady === 0 ? "fail" : pathsReady < pathsTotal ? "warn" : "ok");
  }
  return worst(signals);
}

const VERDICT: Record<H, { dot: string; text: string; word: string }> = {
  ok: { dot: "bg-emerald-500", text: "text-emerald-700", word: "All systems operational" },
  warn: { dot: "bg-amber-500", text: "text-amber-700", word: "Running — some signals degraded" },
  fail: { dot: "bg-red-500", text: "text-brand-red", word: "Attention needed" },
};

function num(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

interface HeroTileProps {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  value: string;
  label: string;
  sub?: string;
  href: string;
}

function HeroTile({ icon: Icon, eyebrow, value, label, sub, href }: HeroTileProps) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-2xl border border-border bg-card p-6 transition-colors hover:border-brand-teal/50"
    >
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-4 w-4 text-brand-teal" />
        {eyebrow}
      </div>
      <div className="mt-4 text-5xl font-bold leading-none tracking-tight tabular-nums">
        {value}
      </div>
      <div className="mt-2 text-sm font-medium text-foreground">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </Link>
  );
}

export function KioskHero({
  overview,
  extras,
}: {
  overview: OverviewSnapshot;
  extras: HeroExtras;
}) {
  const { pathsReady, pathsTotal, cameras } = overview.cameraSim;
  const ingesting = overview.cameraSim.ingestingCount;
  const gpu = overview.gpus[0];
  const verdict = VERDICT[heroVerdict(overview)];
  // Snapshot time is the server's "now" — a stable prop, so incident ages stay
  // pure across renders and advance when the snapshot refreshes (every 5s).
  const nowMs = new Date(overview.takenAt).getTime();

  const camSub =
    typeof ingesting === "number" && ingesting > 0
      ? `${ingesting} feeding the AI now`
      : `${cameras?.length ?? pathsTotal} registered`;

  // Only show the 24h delta when it's a genuine subset of the archive — if it
  // equals the all-time total (fresh archive) it just duplicates the headline.
  const incidentsSub =
    extras.last24h !== null &&
    extras.archiveTotal !== null &&
    extras.last24h > 0 &&
    extras.last24h < extras.archiveTotal
      ? `+${num(extras.last24h)} in the last 24h`
      : extras.archiveTotal !== null
        ? "since deployment"
        : "archive unavailable";

  // GPU util is bursty (frame-sampled VLM reads 0% between batches), so lead the
  // compute tile with the stable "model resident in VRAM" signal, not util.
  const vramPct = gpu ? Math.round((gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100) : 0;

  const storageSub =
    overview.s3.growth24h > 0
      ? `+${formatBytes(overview.s3.growth24h)} in the last 24h`
      : overview.s3.objectCount > 0
        ? `${overview.s3.objectCount.toLocaleString()} objects`
        : "on-premises";

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      {/* Brand + live */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-teal">
            ARTESCA × Pyramid × NVIDIA VSS
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
            Sovereign video AI — nothing leaves the store
          </h1>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          LIVE
        </span>
      </div>

      {/* Pipeline narrative */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium text-muted-foreground">
        <span>Cameras watched</span>
        <ArrowRight className="h-4 w-4 text-brand-teal" />
        <span>AI detection</span>
        <ArrowRight className="h-4 w-4 text-brand-teal" />
        <span>Sovereign memory on ARTESCA</span>
        <ArrowRight className="h-4 w-4 text-brand-teal" />
        <span>NVIDIA compute</span>
      </div>

      {/* Story tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HeroTile
          icon={Camera}
          eyebrow="Cameras watched"
          value={`${pathsReady}/${pathsTotal}`}
          label="Live camera feeds"
          sub={camSub}
          href="/cameras"
        />
        <HeroTile
          icon={AlertTriangle}
          eyebrow="Incidents detected"
          value={num(extras.archiveTotal)}
          label="Events flagged by the video AI"
          sub={incidentsSub}
          href="/incidents"
        />
        <HeroTile
          icon={HardDrive}
          eyebrow="Stored on ARTESCA"
          value={formatBytes(overview.s3.bytesTotal)}
          label="On-premises object storage"
          sub={storageSub}
          href="/storage"
        />
        <HeroTile
          icon={Cpu}
          eyebrow="NVIDIA compute"
          value={gpu ? `${vramPct}%` : "—"}
          label={gpu ? shortGpuName(gpu.name) : "GPU"}
          sub={
            gpu
              ? `VRAM resident · ${Math.round(gpu.utilGpu)}% compute · ${Math.round(gpu.tempC)}°C`
              : "no GPU detected"
          }
          href="/topology"
        />
      </div>

      {/* Verdict */}
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-5 py-3">
        <span className={`h-2.5 w-2.5 rounded-full ${verdict.dot} animate-pulse`} />
        <span className={`text-base font-semibold ${verdict.text}`}>{verdict.word}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          Updated {new Date(overview.takenAt).toLocaleTimeString()}
        </span>
      </div>

      {/* Recent incidents peek */}
      <div className="rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-brand-teal" />
            Latest incidents
          </h2>
          <Link href="/incidents" className="text-xs font-medium text-brand-teal hover:underline">
            See all ↗
          </Link>
        </div>
        {extras.recent.length === 0 ? (
          <p className="px-5 py-6 text-center text-sm text-muted-foreground">
            No incidents detected yet — the AI is watching.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {extras.recent.map((inc, i) => {
              const ageS = Math.max(0, Math.floor((nowMs - new Date(inc.ts).getTime()) / 1000));
              return (
                <li key={`${inc.ts}-${inc.sensorId}-${i}`}>
                  <Link
                    href="/incidents"
                    className="flex items-center gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-muted/50"
                  >
                    <span
                      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${SEVERITY_BADGE[inc.severity]}`}
                    >
                      {inc.severity}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{inc.scenarioName}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{inc.sensorId || "—"}</span>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {formatAge(ageS)} ago
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
