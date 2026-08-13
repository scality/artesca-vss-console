"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Cloud, HardDrive, Database, Zap } from "lucide-react";
import type { NodeRuntimeState, PipelineHealth } from "@/lib/types/pipeline";

export interface StorageNodeData {
  label: string;
  /** Merged health from topology API + pipeline snapshot (set by
   *  mergeTopologyData on the page). Used as fallback when `runtime`
   *  is undefined — the snapshot keys don't always match the topology
   *  node IDs (e.g. an ingress may emit `centralizedb-dev` while the
   *  snapshot probe emits `vst-postgres`). */
  health?: PipelineHealth;
  runtime?: NodeRuntimeState;
  subtype: "s3" | "cache" | "postgres" | "redis";
  namespace?: string;
  hasIncoming?: boolean;
  hasOutgoing?: boolean;
  /** Flow direction for this node's pipeline row: "lr" = left-to-right (even rows),
   *  "rl" = right-to-left (odd rows in the serpentine layout). Controls handle sides. */
  flowDir?: "lr" | "rl";
  [key: string]: unknown;
}

// ── Health ring / dot ──────────────────────────────────────────────────────

const HEALTH_RING: Record<PipelineHealth, string> = {
  ok: "ring-emerald-500 bg-emerald-50",
  warn: "ring-amber-500 bg-amber-50",
  fail: "ring-red-500 bg-red-50",
  unknown: "ring-border bg-muted/30",
};

const HEALTH_DOT: Record<PipelineHealth, string> = {
  ok: "bg-emerald-600",
  warn: "bg-amber-500",
  fail: "bg-red-600",
  unknown: "bg-muted-foreground",
};

// ── Format helpers ─────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  const GiB = 2 ** 30;
  const MiB = 2 ** 20;
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(1)} MiB`;
  return `${n} B`;
}

// ── Sub-label derivation by subtype ───────────────────────────────────────

function subLabel(subtype: StorageNodeData["subtype"], runtime?: NodeRuntimeState): string {
  if (!runtime) return "—";
  switch (subtype) {
    case "s3": {
      const s3 = runtime.s3;
      if (!s3) return "—";
      return `${s3.objectCount.toLocaleString()} obj · ${fmtBytes(s3.bytesTotal)}`;
    }
    case "cache": {
      const c = runtime.cache;
      if (!c || c.fillPct === null) return "—";
      return `${c.fillPct.toFixed(1)}% of ${c.sizeGiB} GiB`;
    }
    case "postgres": {
      const db = runtime.db;
      if (!db) return "—";
      return db.connections !== null ? `${db.connections} conn` : "—";
    }
    case "redis": {
      const r = runtime.redis;
      if (!r) return "—";
      return r.connectedClients !== null ? `${r.connectedClients} clients` : "—";
    }
    default: {
      const _exhaustive: never = subtype;
      return _exhaustive;
    }
  }
}

// ── Tier caption by subtype ────────────────────────────────────────────────
// One-word role so the tile conveys the two-tier story (hot cache → durable
// S3) without opening the detail panel.

function tierCaption(subtype: StorageNodeData["subtype"]): string | null {
  switch (subtype) {
    case "s3":
      return "durable tier";
    case "cache":
      return "hot buffer → S3";
    default:
      return null;
  }
}

// ── Icon by subtype ────────────────────────────────────────────────────────

function SubtypeIcon({ subtype }: { subtype: StorageNodeData["subtype"] }) {
  const cls = "h-4 w-4 shrink-0";
  switch (subtype) {
    case "s3":
      return (
        <span className="flex items-center gap-0.5">
          <Cloud className={cls} />
          <HardDrive className="h-3 w-3 shrink-0" />
        </span>
      );
    case "cache":
      return <HardDrive className={cls} />;
    case "postgres":
      return <Database className={cls} />;
    case "redis":
      return <Zap className={`${cls} text-amber-600`} />;
    default: {
      const _exhaustive: never = subtype;
      void _exhaustive;
      return null;
    }
  }
}

// ── Cache fill bar (inline, compact) ──────────────────────────────────────

function InlineFillBar({ pct }: { pct: number }) {
  const color = pct > 90 ? "bg-red-600" : pct > 75 ? "bg-amber-500" : "bg-emerald-600";
  return (
    <div className="mt-1 h-1 w-full rounded-full bg-secondary overflow-hidden">
      <div
        className={`h-full rounded-full ${color} transition-all`}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

// ── Main node ─────────────────────────────────────────────────────────────

export const StorageNode = memo(function StorageNode({ data, selected }: NodeProps) {
  const { label, runtime, subtype, namespace, health: dataHealth, hasIncoming, hasOutgoing, flowDir } =
    data as StorageNodeData;
  const health: PipelineHealth = runtime?.health ?? dataHealth ?? "unknown";
  const sub = subLabel(subtype as StorageNodeData["subtype"], runtime);
  const tier = tierCaption(subtype as StorageNodeData["subtype"]);
  const cacheData = (subtype === "cache" && runtime?.cache?.fillPct != null)
    ? runtime.cache
    : null;

  // Handle sides follow the row's flow direction:
  //   "lr" (even rows, default) — target on Left, source on Right
  //   "rl" (odd rows, serpentine return) — target on Right, source on Left
  const targetPos = flowDir === "rl" ? Position.Right : Position.Left;
  const sourcePos = flowDir === "rl" ? Position.Left  : Position.Right;

  return (
    <div
      className={[
        "rounded-lg border ring-1 px-3 py-2 min-w-[180px] max-w-[200px] cursor-pointer",
        "bg-card border-border text-foreground shadow-md",
        HEALTH_RING[health],
        selected ? "ring-2 ring-primary" : "",
        "transition-all",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {hasIncoming !== false && <Handle type="target" position={targetPos} className="!bg-border" />}

      {/* Header row: icon + label + health dot */}
      <div className="flex items-center gap-2">
        <SubtypeIcon subtype={subtype as StorageNodeData["subtype"]} />
        <span className="text-xs font-semibold truncate flex-1">{label}</span>
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${HEALTH_DOT[health]}`}
          title={health}
        />
      </div>

      {/* Tier caption — conveys the cache→S3 relationship at a glance */}
      {tier && (
        <p className="mt-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/70">
          {tier}
        </p>
      )}

      {/* Sub-label (metric, or "awaiting data" when the probe has no value) */}
      <p className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
        {sub !== "—" ? sub : <span className="text-muted-foreground/50">awaiting data</span>}
      </p>

      {/* Cache fill bar */}
      {cacheData && cacheData.fillPct !== null && (
        <InlineFillBar pct={cacheData.fillPct} />
      )}

      {/* Namespace */}
      {namespace && (
        <p className="mt-0.5 text-[10px] text-muted-foreground/60 font-mono truncate">
          {namespace}
        </p>
      )}

      {hasOutgoing !== false && <Handle type="source" position={sourcePos} className="!bg-border" />}
    </div>
  );
});

export type { NodeRuntimeState };
