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

  // Kafka topic depth (messages retained) — null means "unreachable", not 0.
  // Informational: depth is not consumer lag, so a non-zero value isn't "bad".
  const kafkaEntries = Object.values(data.kafka);
  const measuredDepth = kafkaEntries
    .map((k) => k.retainedMsgs)
    .filter((v): v is number => v !== null);
  const kafkaUnreachable = kafkaEntries.length > 0 && measuredDepth.length === 0;
  const kafkaDepthSum = measuredDepth.reduce((s, v) => s + v, 0);

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

      <KpiCard
        label="NIM Warmup"
        value={`${data.nim.warmupPct}%`}
        footer={
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
        }
      />

      <KpiCard
        label="GPU Util (avg)"
        value={`${gpuAvg}%`}
        sub={`${data.gpus.length} GPU${data.gpus.length !== 1 ? "s" : ""}`}
        trend={gpuAvg > 80 ? "up" : gpuAvg < 20 ? "down" : "flat"}
      />

      <KpiCard
        label="Kafka Depth"
        value={kafkaUnreachable ? "—" : kafkaDepthSum.toLocaleString()}
        sub={kafkaUnreachable ? "brokers unreachable" : "msgs retained across topics"}
        trend="flat"
      />

      <KpiCard
        label="S3 Objects"
        value={data.s3.objectCount.toLocaleString()}
        sub={`+${growthMBps} MB/s (24h)`}
        trend="up"
      />

      <KpiCard
        label="Camera Sim"
        value={`${data.cameraSim.pathsReady}/${data.cameraSim.pathsTotal}`}
        footer={
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
        }
      />
    </div>
  );
}
