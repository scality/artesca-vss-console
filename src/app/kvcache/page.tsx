"use client";

import { Gauge } from "lucide-react";
import { Shell } from "@/components/Shell";
import { ProblemSection, WhyArtescaSection } from "@/components/kvcache/ExplainerSections";
import { MechanismDiagram } from "@/components/kvcache/MechanismDiagram";
import { RaceBeat } from "@/components/kvcache/RaceBeat";
import { PersistenceBeat } from "@/components/kvcache/PersistenceBeat";
import { CostBeat } from "@/components/kvcache/CostBeat";

export default function KvCachePage() {
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
            <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
              Prototype · ISVD-331 · demo data
            </span>
          </div>
        </div>

        <ProblemSection />
        <MechanismDiagram />
        <RaceBeat />
        <PersistenceBeat />
        <CostBeat />
        <WhyArtescaSection />
      </div>
    </Shell>
  );
}
