"use client";

import { KpiCard } from "@/components/KpiCard";
import { StatusBadge } from "@/components/StatusBadge";
import type { OverviewSnapshot } from "@/lib/types";

interface KpiGridProps {
  data: OverviewSnapshot;
}

export function KpiGrid({ data }: KpiGridProps) {
  // Aggregate pod counts across all namespaces
  const totalPods = Object.values(data.namespaces).reduce(
    (acc, ns) => ({ total: acc.total + ns.total, ready: acc.ready + ns.ready }),
    { total: 0, ready: 0 }
  );

  // GPU average utilization
  const gpuAvg =
    data.gpus.length > 0
      ? Math.round(
          data.gpus.reduce((s, g) => s + g.utilGpu, 0) / data.gpus.length
        )
      : 0;

  // Kafka lag sum
  const kafkaLagSum = Object.values(data.kafka).reduce(
    (s, k) => s + k.consumerLagMsgs,
    0
  );

  // S3 growth in MB/s from 24h bytes
  const growthMBps = (data.s3.growth24h / (24 * 3600 * 1024 * 1024)).toFixed(3);

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      <KpiCard
        label="Pods Ready"
        value={`${totalPods.ready}/${totalPods.total}`}
        sub={`across ${Object.keys(data.namespaces).length} namespaces`}
        trend={
          totalPods.ready === totalPods.total
            ? "up"
            : totalPods.ready < totalPods.total * 0.8
              ? "down"
              : "flat"
        }
      />

      <div className="rounded-lg border border-border bg-card p-4 space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          NIM Warmup
        </p>
        <div className="flex items-baseline gap-2">
          <p className="text-2xl font-bold tabular-nums">
            {data.nim.warmupPct}%
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusBadge
            health={data.nim.ready ? "ok" : "warn"}
            label={data.nim.ready ? "Ready" : "Warming"}
          />
          {data.nim.queueDepth > 0 && (
            <span className="text-xs text-muted-foreground">
              q:{data.nim.queueDepth}
            </span>
          )}
        </div>
      </div>

      <KpiCard
        label="GPU Util (avg)"
        value={`${gpuAvg}%`}
        sub={`${data.gpus.length} GPU${data.gpus.length !== 1 ? "s" : ""}`}
        trend={gpuAvg > 80 ? "up" : gpuAvg < 20 ? "down" : "flat"}
      />

      <KpiCard
        label="Kafka Lag"
        value={kafkaLagSum.toLocaleString()}
        sub="msgs across all topics"
        trend={kafkaLagSum > 1000 ? "down" : kafkaLagSum === 0 ? "up" : "flat"}
      />

      <KpiCard
        label="S3 Objects"
        value={data.s3.objectCount.toLocaleString()}
        sub={`+${growthMBps} MB/s (24h)`}
        trend="up"
      />

      <div className="rounded-lg border border-border bg-card p-4 space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Camera Sim
        </p>
        <div className="flex items-baseline gap-2">
          <p className="text-2xl font-bold tabular-nums">
            {data.cameraSim.pathsReady}/{data.cameraSim.pathsTotal}
          </p>
        </div>
        <StatusBadge
          health={
            data.cameraSim.instanceState === "running"
              ? "ok"
              : data.cameraSim.instanceState === "stopped"
                ? "warn"
                : "fail"
          }
          label={data.cameraSim.instanceState}
        />
      </div>
    </div>
  );
}
