"use client";

import { useQuery } from "@tanstack/react-query";
import type { BackendStatus } from "@/lib/diagnostics/connectivity";

// Per-backend reachability, polled independently of the overview snapshot so it
// reflects the console→cluster path directly. The K8s-API dot goes green as
// soon as the API server is reachable (node Ready) — i.e. BEFORE Kafka, VLM,
// Prometheus, etc. come back — so during a recovery you can tell "cluster
// reachable, Kafka just not up yet" apart from "everything still down".

interface ConnectivityResponse {
  takenAt: string;
  backends: BackendStatus[];
}

// Short, color-independent status word so the state is legible as text (e.g.
// when pasted) and not conveyed by the dot colour alone.
function statusWord(b: BackendStatus): string {
  if (b.ok) return "ok";
  const d = b.detail.toLowerCase();
  if (d.includes("not configured") || d.includes("unset")) return "not configured";
  if (d.includes("timed out") || d.includes("timeout")) return "timeout";
  return "unreachable";
}

function Dot({ b }: { b: BackendStatus }) {
  const color = b.ok ? "bg-emerald-500" : "bg-red-500";
  const textColor = b.ok ? "text-emerald-700" : "text-brand-red";
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
      title={b.detail}
    >
      <span className={`h-2 w-2 rounded-full shrink-0 ${color}`} />
      <span>{b.label}</span>
      <span className={`font-medium ${textColor}`}>{statusWord(b)}</span>
    </span>
  );
}

export function ConnectivityStrip() {
  const { data, isLoading } = useQuery<ConnectivityResponse>({
    queryKey: ["connectivity"],
    queryFn: async () => {
      const res = await fetch("/api/diagnostics/connectivity");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ConnectivityResponse>;
    },
    refetchInterval: 5_000,
    staleTime: 4_000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40 animate-pulse" />
        checking reachability…
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        Reachability
      </span>
      {data.backends.map((b) => (
        <Dot key={b.id} b={b} />
      ))}
    </div>
  );
}
