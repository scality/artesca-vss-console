"use client";

import { useCallback, useEffect, useState } from "react";
import { HardDrive, Film, ShieldCheck, Layers, Clock, Lock } from "lucide-react";
import { Shell } from "@/components/Shell";
import { formatBytes } from "@/lib/format-bytes";
import { formatAge } from "@/lib/format-age";

interface BucketSubstrate {
  key: string;
  label: string;
  bucket: string;
  objectCount: number;
  bytesTotal: number;
  bytesLast24h: number;
  truncated?: boolean;
}
interface RecentObject {
  key: string;
  size: number;
  lastModified: string;
  bucket: string;
  bucketLabel: string;
}
interface StorageSubstrate {
  configured: boolean;
  endpoint: string;
  region: string;
  capacityBytes: number;
  buckets: BucketSubstrate[];
  recent: RecentObject[];
  totals: { objectCount: number; bytesTotal: number; bytesLast24h: number };
  warnings: string[];
  ts: string;
}

const REFRESH_MS = 12_000;

const BUCKET_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  recordings: Film,
  evidence: Lock,
  alertClips: ShieldCheck,
  agentCorpus: Layers,
};

function ageOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 1000)) : 0;
}

export default function StoragePage() {
  const [data, setData] = useState<StorageSubstrate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Baseline captured on the first successful poll → "since you opened this view".
  const [baseline, setBaseline] = useState<{ objectCount: number; bytesTotal: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/storage/substrate", { cache: "no-store" });
      const j = (await r.json()) as StorageSubstrate;
      if (!r.ok) throw new Error((j as unknown as { error?: string }).error ?? `HTTP ${r.status}`);
      if (j.configured) {
        setBaseline((prev) => prev ?? { objectCount: j.totals.objectCount, bytesTotal: j.totals.bytesTotal });
      }
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer the first fetch off the effect's synchronous tick so load()'s
    // setState isn't a cascading in-effect update; the interval callback runs
    // async by nature.
    queueMicrotask(() => void load());
    const h = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(h);
  }, [load]);

  const capPct =
    data && data.capacityBytes > 0
      ? Math.min(100, (data.totals.bytesTotal / data.capacityBytes) * 100)
      : 0;
  const deltaObjects = data && baseline ? data.totals.objectCount - baseline.objectCount : 0;
  const deltaBytes = data && baseline ? data.totals.bytesTotal - baseline.bytesTotal : 0;

  return (
    <Shell>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <HardDrive className="h-6 w-6 text-brand-teal" />
            ARTESCA S3 — the AI&rsquo;s on-prem memory
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every frame, incident, and clip the video AI produces is written to ARTESCA object
            storage <span className="font-medium text-foreground">on-premises in the showroom</span> —
            the data never leaves the site.
          </p>
          {data?.configured && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
              <span
                className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-0.5"
                title={`S3 endpoint: ${data.endpoint || "(SDK default)"} · region ${data.region}`}
              >
                <HardDrive className="h-3 w-3" /> ARTESCA S3 · on-premises
              </span>
              <span className="rounded border border-border bg-muted px-2 py-0.5">
                S3-compatible object storage
              </span>
              <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                live
              </span>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {data && !data.configured && (
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            S3 is not configured for this console — set <code>OBJECTSTORE_ENDPOINT</code> +{" "}
            <code>OBJECTSTORE_ACCESS_KEY_ID</code> to show live storage.
          </div>
        )}

        {loading && !data && <div className="text-sm text-muted-foreground">Reading ARTESCA…</div>}

        {data?.configured && (
          <>
            {/* Totals */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Objects stored</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {data.totals.objectCount.toLocaleString()}
                </p>
                {deltaObjects > 0 && (
                  <p className="text-[11px] text-emerald-600">+{deltaObjects.toLocaleString()} since you opened this view</p>
                )}
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Stored on ARTESCA</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{formatBytes(data.totals.bytesTotal)}</p>
                {data.capacityBytes > 0 && (
                  <>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand-teal" style={{ width: `${capPct}%` }} />
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {capPct.toFixed(1)}% of {formatBytes(data.capacityBytes)}
                      {deltaBytes > 0 ? ` · +${formatBytes(deltaBytes)} live` : ""}
                    </p>
                  </>
                )}
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Written in last 24h</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{formatBytes(data.totals.bytesLast24h)}</p>
                <p className="text-[11px] text-muted-foreground">the AI&rsquo;s memory, growing</p>
              </div>
            </div>

            {/* Per-bucket */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {data.buckets.map((b) => {
                const Icon = BUCKET_ICON[b.key] ?? Layers;
                const empty = b.objectCount === 0;
                return (
                  <div
                    key={b.key}
                    className={`rounded-lg border border-border bg-card p-4 ${empty ? "opacity-55" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-brand-teal" />
                      <span className="text-sm font-semibold">{b.label}</span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{b.bucket}</p>
                    {empty ? (
                      <p className="mt-3 text-sm text-muted-foreground">No objects yet</p>
                    ) : (
                      <>
                        <div className="mt-3 flex items-baseline justify-between">
                          <span className="text-xl font-bold tabular-nums">{b.objectCount.toLocaleString()}</span>
                          <span className="text-xs text-muted-foreground">objects</span>
                        </div>
                        <div className="mt-1 flex items-baseline justify-between">
                          <span className="text-sm font-medium tabular-nums">{formatBytes(b.bytesTotal)}</span>
                          {b.bytesLast24h > 0 && (
                            <span className="text-[11px] text-muted-foreground">+{formatBytes(b.bytesLast24h)}/24h</span>
                          )}
                        </div>
                      </>
                    )}
                    {b.truncated && (
                      <p className="mt-1 text-[10px] text-amber-600">count capped (very large bucket)</p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Latest objects landing */}
            <div className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                <Clock className="h-4 w-4 text-brand-teal" />
                <span className="text-sm font-semibold">Latest objects landing in ARTESCA</span>
              </div>
              {data.recent.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">No recent objects.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.recent.map((r) => (
                    <li key={`${r.bucket}/${r.key}`} className="flex items-center gap-3 px-4 py-1.5 text-[12px]">
                      <span className="w-28 shrink-0 truncate text-muted-foreground">{r.bucketLabel}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-foreground">{r.key}</span>
                      <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">{formatBytes(r.size)}</span>
                      <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">{formatAge(ageOf(r.lastModified))} ago</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {data.warnings.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                {data.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
