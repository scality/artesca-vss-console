"use client";

import { useEffect, useState } from "react";
import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { DiagnosticCard, type DiagnosticTest } from "@/components/diagnostics/DiagnosticCard";
import { DiagnosticOutputDrawer } from "@/components/diagnostics/DiagnosticOutputDrawer";
import { VstStoragePanel } from "@/components/diagnostics/VstStoragePanel";
import { useToast } from "@/hooks/use-toast";

const AVAILABLE_TESTS: Array<{ id: string; label: string; description: string }> = [
  {
    id: "validate-manifests",
    label: "Validate manifests",
    description: "Runs scripts/validate-manifests.sh — checks all k8s YAML for correctness.",
  },
  {
    id: "smoke-phase1",
    label: "Phase 1 smoke test",
    description: "ARTESCA storage reachability + VST pod health.",
  },
  {
    id: "smoke-phase2",
    label: "Phase 2 smoke test",
    description: "Camera-sim RTSP paths + mediamtx path list.",
  },
  {
    id: "smoke-phase3",
    label: "Phase 3 smoke test",
    description: "VLM (vss-rtvi-vlm) liveness + NIM /health probe.",
  },
  {
    id: "smoke-phase4",
    label: "Phase 4 smoke test",
    description: "Kafka topic existence + consumer group lag.",
  },
  {
    id: "smoke-phase5",
    label: "Phase 5 smoke test",
    description: "Alert worker Redis connectivity + scenario processing.",
  },
  {
    id: "kubectl-events",
    label: "kubectl get events -A",
    description: "Cluster-wide events — surfaces recent warnings or errors.",
  },
  {
    id: "nvidia-smi",
    label: "nvidia-smi",
    description: "GPU state via kubectl exec — memory, utilization, temperature.",
  },
  {
    id: "kubectl-top",
    label: "kubectl top pod -A",
    description: "CPU and memory usage per pod across all namespaces.",
  },
];

interface RunRecord {
  testId: string;
  lastRun: string;
  lastResult: "pass" | "fail";
  output: string;
}

export default function DiagnosticsPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const [runs, setRuns] = useState<Map<string, RunRecord>>(new Map());
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<{ id: string; label: string } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    // Load last 20 runs from API
    fetch("/api/diagnostics")
      .then((r) => r.json())
      .then((data: RunRecord[]) => {
        const map = new Map<string, RunRecord>();
        for (const r of data) map.set(r.testId, r);
        setRuns(map);
      })
      .catch(() => {});
  }, []);

  async function runTest(id: string) {
    setRunning((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/diagnostics/${id}`, { method: "POST" });
      const data = await res.json();
      const record: RunRecord = {
        testId: id,
        lastRun: new Date().toISOString(),
        lastResult: data.exit === 0 ? "pass" : "fail",
        output: data.output ?? "",
      };
      setRuns((m) => new Map(m).set(id, record));
      toast({
        title: `${AVAILABLE_TESTS.find((t) => t.id === id)?.label} — ${record.lastResult}`,
        variant: record.lastResult === "fail" ? "destructive" : "default",
      });
    } catch (err) {
      toast({ title: "Test run failed", description: String(err), variant: "destructive" });
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  const tests: DiagnosticTest[] = AVAILABLE_TESTS.map((t) => {
    const run = runs.get(t.id);
    return {
      id: t.id,
      label: t.label,
      description: t.description,
      lastRun: run?.lastRun ?? null,
      lastResult: run?.lastResult ?? null,
    };
  });

  const activeDrawer = drawer
    ? {
        test: AVAILABLE_TESTS.find((t) => t.id === drawer.id)!,
        run: runs.get(drawer.id),
      }
    : null;

  return (
    <Shell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Diagnostics</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            On-demand cluster health checks and smoke tests.
          </p>
        </div>

        {/* VST Storage panel */}
        <div className="rounded-lg border border-border p-5">
          <h2 className="text-lg font-semibold mb-4">VST Storage</h2>
          <VstStoragePanel />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tests.map((t) => (
            <DiagnosticCard
              key={t.id}
              test={t}
              running={running.has(t.id)}
              onRun={() => runTest(t.id)}
              onShowOutput={() => setDrawer({ id: t.id, label: t.label })}
            />
          ))}
        </div>

        {activeDrawer && (
          <DiagnosticOutputDrawer
            open={drawer !== null}
            label={activeDrawer.test.label}
            result={activeDrawer.run?.lastResult ?? null}
            output={activeDrawer.run?.output ?? ""}
            onOpenChange={(o) => { if (!o) setDrawer(null); }}
          />
        )}
      </div>
    </Shell>
  );
}
