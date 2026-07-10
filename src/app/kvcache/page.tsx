"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { Shell } from "@/components/Shell";
import { ProblemSection, WhyArtescaSection } from "@/components/kvcache/ExplainerSections";
import { MechanismDiagram } from "@/components/kvcache/MechanismDiagram";
import { RaceBeat, type LiveRaceResult } from "@/components/kvcache/RaceBeat";
import { PersistenceBeat } from "@/components/kvcache/PersistenceBeat";
import { CostBeat, type CostBeatLiveTimings } from "@/components/kvcache/CostBeat";

// Mirrors src/lib/kvcache.ts::KvcacheSnapshot — defined locally (not imported
// from the server-only collector) matching the console's convention of client
// pages owning their own mirrored response shapes (see storage/page.tsx).
interface KvcacheSnapshot {
  available: boolean;
  model: string;
  endpoint: string;
  bucket: { name: string; objects: number; bytes: number };
  warnings: string[];
  ts: string;
}

const POLL_MS = 5_000;

export default function KvCachePage() {
  const [snapshot, setSnapshot] = useState<KvcacheSnapshot | null>(null);
  const [liveTimings, setLiveTimings] = useState<CostBeatLiveTimings | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await fetch("/api/kvcache", { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = (await resp.json()) as KvcacheSnapshot;
        if (!cancelled) setSnapshot(json);
      } catch {
        // Fail-soft: no backend deployed (or a transient blip) — the page
        // keeps rendering the mock engine everywhere.
        if (!cancelled) setSnapshot((prev) => (prev ? { ...prev, available: false } : prev));
      }
    };
    void poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const live = snapshot?.available === true;

  function handleLiveResult(result: LiveRaceResult & { ok: true }) {
    setLiveTimings({ coldTtftMs: result.cold.ttftMs, warmTtftMs: result.warm.ttftMs });
  }

  return (
    <Shell>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Gauge className="h-6 w-6 text-brand-teal" />
            The AI&rsquo;s memory lives on ARTESCA
          </h1>
          <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
            Repeated visitor questions would recompute the whole store knowledge base every
            time — unless that computation, the model&rsquo;s{" "}
            <span className="font-medium text-foreground">KV cache</span>, is stored on ARTESCA
            and reused.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            {live ? (
              <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                ● live — {snapshot?.model} on vLLM+LMCache
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
                Prototype · ISVD-331 · demo data
              </span>
            )}
          </div>
        </div>

        <ProblemSection />
        <MechanismDiagram liveBucket={live ? snapshot?.bucket ?? null : null} />
        <RaceBeat live={live} onLiveResult={handleLiveResult} />
        <PersistenceBeat />
        <CostBeat live={live} liveTimings={liveTimings} />
        <WhyArtescaSection />
      </div>
    </Shell>
  );
}
