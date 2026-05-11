"use client";

// src/components/topology/node-content/compute.tsx
// Compute-node status, config, and metrics tab renderers.
// Owned by Agent 5.

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
} from "recharts";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { NodeContentMap } from "../registry";
import type {
  NodeRuntimeState,
  PodState,
  GpuStateShort,
  NimState,
  KafkaTopicState,
} from "@/lib/types/pipeline";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatAge(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sparkline ring buffer — module-level Map persists across panel open/close.
// Key: "<nodeId>:<metricName>", value: array of { i, v } (capped at 60).
// ─────────────────────────────────────────────────────────────────────────────

const SPARKLINE_CAPACITY = 60;

interface SparkSample {
  i: number;  // sequential index for recharts
  v: number;
}

// Module-level map: survives panel close/reopen as long as the page is mounted.
const sparklineStore = new Map<string, SparkSample[]>();

function pushSample(key: string, value: number): SparkSample[] {
  const arr = sparklineStore.get(key) ?? [];
  const next: SparkSample = { i: arr.length, v: value };
  const updated = arr.length >= SPARKLINE_CAPACITY
    ? [...arr.slice(1).map((s, idx) => ({ ...s, i: idx })), { ...next, i: SPARKLINE_CAPACITY - 1 }]
    : [...arr, next];
  sparklineStore.set(key, updated);
  return updated;
}

function getSamples(key: string): SparkSample[] {
  return sparklineStore.get(key) ?? [];
}

/** Drop every sparkline series for a node id. Call when its node is removed
 *  from the topology (e.g. camera de-registered) to prevent unbounded growth
 *  of the module-level store over long-running sessions. */
export function clearNodeSparklines(nodeId: string): void {
  const prefix = `${nodeId}:`;
  for (const key of sparklineStore.keys()) {
    if (key.startsWith(prefix)) sparklineStore.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared sub-components
// ─────────────────────────────────────────────────────────────────────────────

function PodStatusBlock({ pod }: { pod?: PodState }) {
  if (!pod) {
    return <p className="text-sm text-muted-foreground">No pod data.</p>;
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      <dt className="text-muted-foreground">Phase</dt>
      <dd>
        {pod.phase}{" "}
        <span className={pod.ready ? "text-green-400" : "text-yellow-400"}>
          {pod.ready ? "· ready" : "· not ready"}
        </span>
      </dd>
      <dt className="text-muted-foreground">Restarts</dt>
      <dd className={pod.restarts > 0 ? "text-yellow-400" : ""}>{pod.restarts}</dd>
      <dt className="text-muted-foreground">Age</dt>
      <dd>{formatAge(pod.ageSecs)}</dd>
      <dt className="text-muted-foreground">Namespace</dt>
      <dd className="font-mono text-xs">{pod.namespace}</dd>
    </dl>
  );
}

/** Minimal GPU util + VRAM bar for a single GPU. */
function GpuBlock({ gpu, label }: { gpu?: GpuStateShort; label: string }) {
  if (!gpu) {
    return (
      <p className="text-sm text-muted-foreground mt-3">
        {label}: no GPU data.
      </p>
    );
  }
  const vramPct = gpu.memTotalGiB > 0
    ? Math.round((gpu.memUsedGiB / gpu.memTotalGiB) * 100)
    : 0;
  const vramColor =
    vramPct > 90 ? "[&>div]:bg-red-500" : vramPct > 70 ? "[&>div]:bg-yellow-500" : "[&>div]:bg-primary";

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <span className="text-muted-foreground">Util</span>
        <span>{gpu.utilPct}%</span>
        <span className="text-muted-foreground">VRAM</span>
        <span>{gpu.memUsedGiB.toFixed(1)} / {gpu.memTotalGiB.toFixed(1)} GiB</span>
      </div>
      <Progress value={vramPct} className={`h-1.5 ${vramColor}`} />
    </div>
  );
}

/** Minimal sparkline — no axes, no grid, no tooltip. */
function Sparkline({
  samples,
  color = "hsl(var(--primary))",
  gradientId,
}: {
  samples: SparkSample[];
  color?: string;
  gradientId: string;
}) {
  if (samples.length < 3) {
    return (
      <p className="text-xs text-muted-foreground italic mt-1">collecting…</p>
    );
  }
  return (
    <div className="mt-1 h-10 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={samples} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** GPU util + VRAM sparklines — used by multiple nodes. */
function GpuSparklines({
  nodeId,
  gpu,
  label,
}: {
  nodeId: string;
  gpu?: GpuStateShort;
  label: string;
}) {
  const utilKey = `${nodeId}:gpu-util`;
  const vramKey = `${nodeId}:gpu-vram`;

  // Push current values into ring buffer on each render driven by snapshot refresh.
  const utilSamples = React.useMemo(() => {
    if (gpu == null) return getSamples(utilKey);
    return pushSample(utilKey, gpu.utilPct);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu?.utilPct]);

  const vramSamples = React.useMemo(() => {
    if (gpu == null) return getSamples(vramKey);
    const pct = gpu.memTotalGiB > 0
      ? (gpu.memUsedGiB / gpu.memTotalGiB) * 100
      : 0;
    return pushSample(vramKey, pct);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu?.memUsedGiB]);

  if (!gpu) {
    return <p className="text-sm text-muted-foreground mt-2">No GPU metrics available.</p>;
  }

  return (
    <div className="space-y-4 mt-1">
      <div>
        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
          {label} — GPU utilisation
        </p>
        <Sparkline samples={utilSamples} gradientId={`${nodeId}-util-grad`} />
        <p className="text-xs text-muted-foreground mt-0.5">{gpu.utilPct}% current</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
          {label} — VRAM usage
        </p>
        <Sparkline
          samples={vramSamples}
          color="hsl(var(--destructive))"
          gradientId={`${nodeId}-vram-grad`}
        />
        <p className="text-xs text-muted-foreground mt-0.5">
          {gpu.memUsedGiB.toFixed(1)} / {gpu.memTotalGiB.toFixed(1)} GiB
        </p>
      </div>
    </div>
  );
}

/** "Open in route" link button. */
function RouteLink({ href, label }: { href: string; label: string }) {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-start text-xs"
      onClick={() => router.push(href)}
    >
      {label}
    </Button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// sensor-ms
// ─────────────────────────────────────────────────────────────────────────────

function SensorMsStatus({ runtimeState, snapshot }: { runtimeState?: NodeRuntimeState; snapshot?: ReturnType<typeof Object.values>[0] }) {
  const registeredFeeds = React.useMemo(() => {
    if (!snapshot?.nodes) return null;
    return Object.entries(snapshot.nodes as Record<string, NodeRuntimeState>).filter(
      ([id, n]) => id.startsWith("feed:") && n.feed?.vstRegistered
    ).length;
  }, [snapshot]);

  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <GpuBlock gpu={runtimeState?.gpu} label="GPU 3 (shared with streamprocessing-ms)" />
      {registeredFeeds !== null && (
        <p className="text-sm">
          Registered feeds: <span className="font-mono">{registeredFeeds}</span>
        </p>
      )}
    </div>
  );
}

function SensorMsConfig() {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground mb-3">Recording settings live in /tuning.</p>
      <RouteLink href="/tuning#vst" label="Edit recording settings in /tuning" />
    </div>
  );
}

function SensorMsMetrics({ nodeId, runtimeState }: { nodeId: string; runtimeState?: NodeRuntimeState }) {
  return <GpuSparklines nodeId={nodeId} gpu={runtimeState?.gpu} label="GPU 3" />;
}

// ─────────────────────────────────────────────────────────────────────────────
// streamprocessing-ms
// ─────────────────────────────────────────────────────────────────────────────

function StreamProcessingStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <GpuBlock gpu={runtimeState?.gpu} label="GPU 3 (shared with sensor-ms)" />
      <p className="text-sm text-muted-foreground">
        Stream count: <span className="font-mono">—</span>
      </p>
    </div>
  );
}

function StreamProcessingMetrics({ nodeId, runtimeState }: { nodeId: string; runtimeState?: NodeRuntimeState }) {
  return <GpuSparklines nodeId={nodeId} gpu={runtimeState?.gpu} label="GPU 3" />;
}

// ─────────────────────────────────────────────────────────────────────────────
// rtvi-vlm
// ─────────────────────────────────────────────────────────────────────────────

function RtviVlmStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <GpuBlock gpu={runtimeState?.gpu} label="GPU 1" />
      <p className="text-xs text-muted-foreground mt-1">
        Pulls RTSP frames from sensor-ms on localhost.
      </p>
    </div>
  );
}

function RtviVlmConfig() {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground mb-3">
        Model and sampling settings are managed in /tuning.
      </p>
      <RouteLink href="/tuning#rtvi" label="Edit RTVI settings in /tuning" />
    </div>
  );
}

function RtviVlmMetrics({ nodeId, runtimeState }: { nodeId: string; runtimeState?: NodeRuntimeState }) {
  return <GpuSparklines nodeId={nodeId} gpu={runtimeState?.gpu} label="GPU 1" />;
}

// ─────────────────────────────────────────────────────────────────────────────
// rtvi-embed
// ─────────────────────────────────────────────────────────────────────────────

function RtviEmbedStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <GpuBlock gpu={runtimeState?.gpu} label="GPU 2" />
    </div>
  );
}

function RtviEmbedMetrics({ nodeId, runtimeState }: { nodeId: string; runtimeState?: NodeRuntimeState }) {
  return <GpuSparklines nodeId={nodeId} gpu={runtimeState?.gpu} label="GPU 2" />;
}

// ─────────────────────────────────────────────────────────────────────────────
// nim-cosmos-reason2
// ─────────────────────────────────────────────────────────────────────────────

function NimStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  const nim: NimState | undefined = runtimeState?.nim;
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <GpuBlock gpu={runtimeState?.gpu} label="GPU 0" />
      {nim && (
        <>
          {/* Primary: tokens/sec + P95 latency as large stat tiles */}
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div className="rounded-lg border border-border bg-muted/10 px-3 py-2.5">
              <p className="text-xs text-muted-foreground mb-1">Tokens / sec</p>
              <p className="text-3xl font-mono font-semibold leading-none">
                {nim.tokensPerSec != null ? nim.tokensPerSec.toFixed(1) : "—"}
                {nim.tokensPerSec != null && (
                  <span className="text-base font-normal text-muted-foreground ml-1">tok/s</span>
                )}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/10 px-3 py-2.5">
              <p className="text-xs text-muted-foreground mb-1">P95 latency</p>
              <p className="text-3xl font-mono font-semibold leading-none">
                {nim.inferenceLatencyP95Ms != null ? nim.inferenceLatencyP95Ms.toFixed(0) : "—"}
                {nim.inferenceLatencyP95Ms != null && (
                  <span className="text-base font-normal text-muted-foreground ml-1">ms</span>
                )}
              </p>
              {nim.queueDepth != null && (
                <p className="text-xs text-muted-foreground mt-1">
                  queue: {nim.queueDepth}
                </p>
              )}
            </div>
          </div>

          {/* Secondary: model context, warmup, P50 */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="font-mono text-xs truncate">{nim.model}</dd>
            <dt className="text-muted-foreground">Warmup</dt>
            <dd>
              <div className="flex items-center gap-2">
                <Progress value={nim.warmupPct} className="h-1.5 flex-1" />
                <span className="text-xs">{nim.warmupPct}%</span>
              </div>
            </dd>
            <dt className="text-muted-foreground">P50 lat</dt>
            <dd className="text-muted-foreground">
              {nim.inferenceLatencyP50Ms != null ? `${nim.inferenceLatencyP50Ms.toFixed(0)} ms` : "—"}
            </dd>
          </dl>

          {/* Muted supporting text */}
          <p className="text-xs text-muted-foreground">GPU 0 · swap model in /prompt</p>
        </>
      )}
      {!nim && <p className="text-sm text-muted-foreground">NIM metrics unavailable.</p>}
    </div>
  );
}

function NimConfig() {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground mb-3">
        Swap the active model or tune KV-cache settings.
      </p>
      <RouteLink href="/prompt" label="Swap model in /prompt" />
      <RouteLink href="/tuning#nim" label="Tune KV cache in /tuning" />
    </div>
  );
}

function NimMetrics({ nodeId, runtimeState }: { nodeId: string; runtimeState?: NodeRuntimeState }) {
  const nim: NimState | undefined = runtimeState?.nim;
  const tpsKey = `${nodeId}:tps`;
  const latKey = `${nodeId}:p95-lat`;

  const tpsSamples = React.useMemo(() => {
    if (nim?.tokensPerSec == null) return getSamples(tpsKey);
    return pushSample(tpsKey, nim.tokensPerSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nim?.tokensPerSec]);

  const latSamples = React.useMemo(() => {
    if (nim?.inferenceLatencyP95Ms == null) return getSamples(latKey);
    return pushSample(latKey, nim.inferenceLatencyP95Ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nim?.inferenceLatencyP95Ms]);

  if (!nim) {
    return <p className="text-sm text-muted-foreground">No NIM metrics available yet.</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
          Tokens / sec (last 5 min)
        </p>
        <Sparkline samples={tpsSamples} gradientId={`${nodeId}-tps-grad`} />
        <p className="text-xs text-muted-foreground mt-0.5">
          {nim.tokensPerSec != null ? `${nim.tokensPerSec.toFixed(1)} tok/s` : "—"}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
          P95 inference latency
        </p>
        <Sparkline
          samples={latSamples}
          color="hsl(var(--destructive))"
          gradientId={`${nodeId}-lat-grad`}
        />
        <p className="text-xs text-muted-foreground mt-0.5">
          {nim.inferenceLatencyP95Ms != null
            ? `${nim.inferenceLatencyP95Ms.toFixed(0)} ms`
            : "—"}
        </p>
      </div>
      <GpuSparklines nodeId={nodeId} gpu={runtimeState?.gpu} label="GPU 0" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// kafka / redpanda
// ─────────────────────────────────────────────────────────────────────────────

function KafkaStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  const topics: KafkaTopicState[] = runtimeState?.kafka?.topics ?? [];
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      {topics.length > 0 ? (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Topics</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left pb-1 font-normal">Topic</th>
                <th className="text-right pb-1 font-normal">msg/s</th>
                <th className="text-right pb-1 font-normal">lag</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((t) => (
                <tr key={t.name} className="border-b border-border/40">
                  <td className="py-1 font-mono truncate max-w-[140px]" title={t.name}>
                    {t.name}
                  </td>
                  <td className="py-1 text-right">
                    {t.msgRatePerSec != null ? t.msgRatePerSec.toFixed(1) : "—"}
                  </td>
                  <td className="py-1 text-right">
                    {t.lagMsgs != null ? t.lagMsgs.toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No topic data available.</p>
      )}
    </div>
  );
}

function KafkaMetrics({ nodeId, runtimeState }: { nodeId: string; runtimeState?: NodeRuntimeState }) {
  const topics: KafkaTopicState[] = runtimeState?.kafka?.topics ?? [];
  const top4 = topics.slice(0, 4);

  if (top4.length === 0) {
    return <p className="text-sm text-muted-foreground">No data yet.</p>;
  }

  // Push samples for each topic
  top4.forEach((t) => {
    if (t.msgRatePerSec != null) {
      pushSample(`${nodeId}:topic:${t.name}`, t.msgRatePerSec);
    }
  });

  return (
    <div className="space-y-4">
      {top4.map((t, idx) => {
        const key = `${nodeId}:topic:${t.name}`;
        const samples = getSamples(key);
        const colors = [
          "hsl(var(--primary))",
          "hsl(142 76% 36%)",
          "hsl(38 92% 50%)",
          "hsl(0 84% 60%)",
        ];
        return (
          <div key={t.name}>
            <p className="text-xs text-muted-foreground truncate mb-1" title={t.name}>
              {t.name}
            </p>
            <Sparkline
              samples={samples}
              color={colors[idx] ?? "hsl(var(--primary))"}
              gradientId={`${nodeId}-kafka-${idx}-grad`}
            />
            <p className="text-xs text-muted-foreground mt-0.5">
              {t.msgRatePerSec != null ? `${t.msgRatePerSec.toFixed(1)} msg/s` : "No data yet"}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// alert-worker
// ─────────────────────────────────────────────────────────────────────────────

function AlertWorkerStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm mt-2">
        <dt className="text-muted-foreground">Cooldown cache</dt>
        <dd>—</dd>
        <dt className="text-muted-foreground">Slack configured</dt>
        <dd>—</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        Cooldown and Slack configuration details unavailable from snapshot.
      </p>
    </div>
  );
}

function AlertWorkerConfig() {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground mb-3">
        Alert scenarios and cooldown are configured in /scenarios and /tuning.
      </p>
      <RouteLink href="/scenarios" label="Edit scenarios in /scenarios" />
      <RouteLink href="/tuning#alerts" label="Tune cooldown in /tuning" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// agent (VSS agent + UI)
// ─────────────────────────────────────────────────────────────────────────────

function AgentStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm mt-2">
        <dt className="text-muted-foreground">Connected clients</dt>
        <dd>—</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        Client count unavailable from snapshot data.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// demo-data-producer
// ─────────────────────────────────────────────────────────────────────────────

interface DemoDataState {
  enabled: boolean;
  replicas: number;
  tickRate: number;
  matchProbability: number;
}

function DemoDataProducerStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <p className="text-xs text-muted-foreground">
        Scale and tick rate are managed in the Config tab.
      </p>
    </div>
  );
}

function DemoDataProducerConfig() {
  const [state, setState] = React.useState<DemoDataState | null>(null);
  const [saving, setSaving] = React.useState(false);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isLoading } = useQuery<DemoDataState>({
    queryKey: ["demo-data-config"],
    queryFn: async () => {
      const res = await fetch("/api/demo-data");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<DemoDataState>;
    },
    staleTime: 5_000,
  });

  // Derive the effective value: prefer local editable state, fall back to
  // the fresh query result before the first user interaction.
  const effective = state ?? data ?? null;

  async function patch(partial: Partial<DemoDataState>) {
    if (!effective) return;
    const next = { ...effective, ...partial };
    setState(next);
    setSaving(true);
    try {
      await fetch("/api/demo-data", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
    } finally {
      setSaving(false);
    }
  }

  function debouncedPatch(partial: Partial<DemoDataState>) {
    if (!effective) return;
    setState({ ...effective, ...partial });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => patch(partial), 600);
  }

  if (isLoading || !effective) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-5">
      {/* On/Off toggle */}
      <div className="flex items-center gap-3">
        <Switch
          id="demo-enabled"
          checked={effective.enabled}
          onCheckedChange={(checked) => patch({ enabled: checked })}
          disabled={saving}
        />
        <Label htmlFor="demo-enabled" className="text-sm">
          {effective.enabled ? "Running" : "Stopped"} ({effective.replicas} replica{effective.replicas !== 1 ? "s" : ""})
        </Label>
      </div>

      {/* Tick rate slider */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          Tick rate: {effective.tickRate.toFixed(1)} / sec
        </Label>
        <input
          type="range"
          min={0.1}
          max={10}
          step={0.1}
          value={effective.tickRate}
          onChange={(e) => debouncedPatch({ tickRate: parseFloat(e.target.value) })}
          className="w-full accent-primary"
          disabled={saving}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>0.1/s</span>
          <span>10/s</span>
        </div>
      </div>

      {/* Match probability slider */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          Match probability: {(effective.matchProbability * 100).toFixed(0)}%
        </Label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={effective.matchProbability}
          onChange={(e) => debouncedPatch({ matchProbability: parseFloat(e.target.value) })}
          className="w-full accent-primary"
          disabled={saving}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>0%</span>
          <span>100%</span>
        </div>
      </div>

      {saving && <p className="text-xs text-muted-foreground italic">Saving…</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// mediamtx
// ─────────────────────────────────────────────────────────────────────────────

function MediamtxStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  const health = runtimeState?.health ?? "unknown";
  const reachable =
    health === "ok" ? "Yes" : health === "fail" ? "No" : "Unknown";
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm mt-2">
        <dt className="text-muted-foreground">Path count</dt>
        <dd>—</dd>
        <dt className="text-muted-foreground">Reachable</dt>
        <dd>{reachable}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        Path count unavailable from snapshot data.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// camera-sim
// ─────────────────────────────────────────────────────────────────────────────

function CameraSimStatus({ runtimeState }: { runtimeState?: NodeRuntimeState }) {
  return (
    <div className="space-y-4">
      <PodStatusBlock pod={runtimeState?.pod} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm mt-2">
        <dt className="text-muted-foreground">EC2 state</dt>
        <dd>—</dd>
        <dt className="text-muted-foreground">Path count</dt>
        <dd>—</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        EC2 instance state and path count unavailable from snapshot data.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab renderer adapters — bridge NodeContent (props-based) to component types
// ─────────────────────────────────────────────────────────────────────────────

export const COMPUTE_CONTENT: NodeContentMap = {
  "sensor-ms": {
    status: ({ nodeId: _n, runtimeState, snapshot }) => (
      <SensorMsStatus runtimeState={runtimeState} snapshot={snapshot} />
    ),
    config: () => <SensorMsConfig />,
    metrics: ({ nodeId, runtimeState }) => (
      <SensorMsMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },

  "streamprocessing-ms": {
    status: ({ runtimeState }) => <StreamProcessingStatus runtimeState={runtimeState} />,
    metrics: ({ nodeId, runtimeState }) => (
      <StreamProcessingMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },

  "rtvi-vlm": {
    status: ({ runtimeState }) => <RtviVlmStatus runtimeState={runtimeState} />,
    config: () => <RtviVlmConfig />,
    metrics: ({ nodeId, runtimeState }) => (
      <RtviVlmMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },

  "rtvi-embed": {
    status: ({ runtimeState }) => <RtviEmbedStatus runtimeState={runtimeState} />,
    metrics: ({ nodeId, runtimeState }) => (
      <RtviEmbedMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },

  "nim-cosmos-reason2": {
    status: ({ runtimeState }) => <NimStatus runtimeState={runtimeState} />,
    config: () => <NimConfig />,
    metrics: ({ nodeId, runtimeState }) => (
      <NimMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },

  kafka: {
    status: ({ runtimeState }) => <KafkaStatus runtimeState={runtimeState} />,
    metrics: ({ nodeId, runtimeState }) => (
      <KafkaMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },

  redpanda: {
    status: ({ runtimeState }) => <KafkaStatus runtimeState={runtimeState} />,
    metrics: ({ nodeId, runtimeState }) => (
      <KafkaMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },

  "alert-worker": {
    status: ({ runtimeState }) => <AlertWorkerStatus runtimeState={runtimeState} />,
    config: () => <AlertWorkerConfig />,
  },

  agent: {
    status: ({ runtimeState }) => <AgentStatus runtimeState={runtimeState} />,
  },

  "demo-data-producer": {
    status: ({ runtimeState }) => <DemoDataProducerStatus runtimeState={runtimeState} />,
    config: () => <DemoDataProducerConfig />,
  },

  mediamtx: {
    status: ({ runtimeState }) => <MediamtxStatus runtimeState={runtimeState} />,
  },

  "camera-sim": {
    status: ({ runtimeState }) => <CameraSimStatus runtimeState={runtimeState} />,
  },

  // Helm node IDs — reuse the same component renderers
  "vss-vios-sensor": {
    status: ({ nodeId: _n, runtimeState, snapshot }) => (
      <SensorMsStatus runtimeState={runtimeState} snapshot={snapshot} />
    ),
    config: () => <SensorMsConfig />,
    metrics: ({ nodeId, runtimeState }) => (
      <SensorMsMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },
  "vss-vios-streamprocessing": {
    status: ({ runtimeState }) => <StreamProcessingStatus runtimeState={runtimeState} />,
    metrics: ({ nodeId, runtimeState }) => (
      <StreamProcessingMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },
  "vss-rtvi-vlm": {
    status: ({ runtimeState }) => <RtviVlmStatus runtimeState={runtimeState} />,
    config: () => <RtviVlmConfig />,
    metrics: ({ nodeId, runtimeState }) => (
      <RtviVlmMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },
  "nim-nemotron-nano": {
    status: ({ runtimeState }) => <NimStatus runtimeState={runtimeState} />,
    config: () => <NimConfig />,
    metrics: ({ nodeId, runtimeState }) => (
      <NimMetrics nodeId={nodeId} runtimeState={runtimeState} />
    ),
  },
  "vss-video-analytics-api": {
    status: ({ runtimeState }) => <AlertWorkerStatus runtimeState={runtimeState} />,
    config: () => <AlertWorkerConfig />,
  },
  "vss-agent": {
    status: ({ runtimeState }) => <AgentStatus runtimeState={runtimeState} />,
  },
  "vss-redis": {
    status: ({ runtimeState }) => (
      <div className="space-y-4">
        <PodStatusBlock pod={runtimeState?.pod} />
      </div>
    ),
  },
  "vss-vios-postgres": {
    status: ({ runtimeState }) => (
      <div className="space-y-4">
        <PodStatusBlock pod={runtimeState?.pod} />
      </div>
    ),
  },
};
