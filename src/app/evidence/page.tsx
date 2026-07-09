"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Lock, Play, Loader2, Check, X } from "lucide-react";
import { Shell } from "@/components/Shell";
import { ClipPlayer } from "@/components/incidents/ClipPlayer";
import { formatBytes } from "@/lib/format-bytes";

interface EvidenceItem {
  key: string;
  size: number;
  lastModified: string;
  versionId?: string;
  mode?: string;
  retainUntil?: string;
  sensor?: string;
  ts?: string;
  scenario?: string;
  incidentId?: string;
}
interface Incident {
  ts: string;
  sensorId: string;
  scenarioName?: string;
  severity?: string;
  summary?: string;
}
type VerifyState = { phase: "idle" } | { phase: "run" } | { phase: "denied"; msg: string } | { phase: "deleted" };

function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return null;
  return Math.max(0, Math.ceil((d - Date.now()) / 86_400_000));
}

export default function EvidencePage() {
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [pick, setPick] = useState("");
  const [retentionDays, setRetentionDays] = useState(365);
  const [mode, setMode] = useState<"COMPLIANCE" | "GOVERNANCE">("COMPLIANCE");
  const [sealing, setSealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<Record<string, VerifyState>>({});
  const [playing, setPlaying] = useState<string | null>(null);

  const loadEvidence = useCallback(async () => {
    try {
      const j = await fetch("/api/evidence", { cache: "no-store" }).then((r) => r.json());
      setItems(j.items ?? []);
      if (j.error) setError(j.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    }
  }, []);

  const [scenarios, setScenarios] = useState<
    Array<{ name: string; immutable?: { enabled: boolean; retentionDays: number; mode?: "GOVERNANCE" | "COMPLIANCE" } }>
  >([]);

  useEffect(() => {
    // Deferred off the effect's sync tick to avoid in-effect setState cascades.
    queueMicrotask(() => {
      void loadEvidence();
      fetch("/api/incidents?limit=50", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setIncidents(Array.isArray(j) ? j : j.incidents ?? []))
        .catch(() => {});
      fetch("/api/scenarios", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setScenarios(j.scenarios ?? []))
        .catch(() => {});
    });
  }, [loadEvidence]);

  // Pick an incident and prefill retention/mode from its scenario's immutable
  // config (the per-scenario option), if one is enabled — done in the handler,
  // not an effect, so it's a direct user action.
  const onPick = useCallback(
    (idx: string) => {
      setPick(idx);
      const inc = incidents[Number(idx)];
      const sc = inc && scenarios.find((s) => s.name === inc.scenarioName);
      if (sc && sc.immutable?.enabled) {
        setRetentionDays(sc.immutable.retentionDays);
        if (sc.immutable.mode) setMode(sc.immutable.mode);
      }
    },
    [incidents, scenarios],
  );

  const seal = useCallback(async () => {
    const inc = incidents[Number(pick)];
    if (!inc) return;
    setSealing(true);
    setError(null);
    try {
      const r = await fetch("/api/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sensor: inc.sensorId,
          ts: inc.ts,
          scenarioName: inc.scenarioName,
          retentionDays,
          mode,
        }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      await loadEvidence();
    } catch (e) {
      setError(e instanceof Error ? e.message : "seal failed");
    } finally {
      setSealing(false);
    }
  }, [incidents, pick, retentionDays, mode, loadEvidence]);

  const runVerify = useCallback(async (it: EvidenceItem) => {
    setVerify((v) => ({ ...v, [it.key]: { phase: "run" } }));
    try {
      const j = await fetch("/api/evidence/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: it.key, versionId: it.versionId }),
      }).then((r) => r.json());
      setVerify((v) => ({
        ...v,
        [it.key]: j.denied ? { phase: "denied", msg: j.error ?? "AccessDenied" } : { phase: "deleted" },
      }));
    } catch {
      setVerify((v) => ({ ...v, [it.key]: { phase: "idle" } }));
    }
  }, []);

  return (
    <Shell>
      <div className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ShieldCheck className="h-6 w-6 text-brand-teal" />
            Immutable evidence
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Incident clips sealed into ARTESCA with <span className="font-medium text-foreground">S3 Object Lock (WORM)</span> —
            write-once, tamper-proof, retained for legal hold. Not even an administrator can delete them until retention expires.
          </p>
        </div>

        {/* Seal a clip */}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Lock className="h-4 w-4 text-brand-teal" /> Seal an incident as evidence
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Incident</span>
              <select
                value={pick}
                onChange={(e) => onPick(e.target.value)}
                className="w-96 max-w-full rounded border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="">Select a recent incident…</option>
                {incidents.map((inc, i) => (
                  <option key={`${inc.sensorId}-${inc.ts}-${i}`} value={i}>
                    {inc.sensorId} · {inc.scenarioName ?? "alert"} · {new Date(inc.ts).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Retention (days)</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={retentionDays}
                onChange={(e) => setRetentionDays(Number(e.target.value))}
                className="w-24 rounded border border-input bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Lock mode</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "COMPLIANCE" | "GOVERNANCE")}
                className="rounded border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="COMPLIANCE">COMPLIANCE (un-deletable)</option>
                <option value="GOVERNANCE">GOVERNANCE (bypassable)</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void seal()}
              disabled={sealing || !pick}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
            >
              {sealing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
              Seal as evidence
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {/* Sealed evidence */}
        <div className="space-y-3">
          <p className="text-sm font-semibold">Sealed evidence ({items.length})</p>
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground">No sealed evidence yet — seal an incident above.</p>
          )}
          {items.map((it) => {
            const vs = verify[it.key] ?? { phase: "idle" };
            const days = daysUntil(it.retainUntil);
            return (
              <div key={it.key} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                    <Lock className="h-3 w-3" /> {it.mode ?? "LOCKED"}
                  </span>
                  <span className="font-mono text-xs">{it.sensor ?? it.key}</span>
                  {it.scenario && <span className="text-xs text-muted-foreground">· {it.scenario}</span>}
                  <span className="text-xs text-muted-foreground">· {formatBytes(it.size)}</span>
                  {days !== null && (
                    <span className="text-xs text-muted-foreground">· retained {days} more day{days === 1 ? "" : "s"}</span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPlaying(playing === it.key ? null : it.key)}
                      className="inline-flex items-center gap-1 rounded border border-input bg-card px-2 py-1 text-[11px] hover:text-foreground"
                    >
                      <Play className="h-3 w-3" /> {playing === it.key ? "Hide" : "Play"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runVerify(it)}
                      disabled={vs.phase === "run"}
                      className="inline-flex items-center gap-1 rounded border border-input bg-card px-2 py-1 text-[11px] hover:text-foreground disabled:opacity-50"
                      title="Attempt to permanently delete this evidence — ARTESCA should refuse"
                    >
                      {vs.phase === "run" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                      Verify immutability
                    </button>
                  </span>
                </div>

                {vs.phase === "denied" && (
                  <div className="mt-2 flex items-start gap-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-700">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Delete <b>denied</b> by ARTESCA Object Lock — the evidence is immutable.{" "}
                      <span className="font-mono opacity-70">{vs.msg}</span>
                    </span>
                  </div>
                )}
                {vs.phase === "deleted" && (
                  <div className="mt-2 flex items-center gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                    <X className="h-3.5 w-3.5" /> Object was deleted — lock not enforced!
                  </div>
                )}

                {playing === it.key && it.sensor && it.ts && (
                  <div className="mt-3 max-w-lg">
                    <ClipPlayer
                      src={`/api/clips/${encodeURIComponent(it.sensor)}/${encodeURIComponent(it.ts)}/index.m3u8`}
                      fallbackMeta={{
                        ts: it.ts,
                        sensorId: it.sensor,
                        severity: "medium",
                        summary: it.scenario ?? "sealed evidence",
                        scenarioName: it.scenario ?? "",
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}
