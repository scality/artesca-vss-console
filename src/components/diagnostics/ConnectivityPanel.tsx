"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { statusWord } from "@/lib/diagnostics/backend-status";

// contract: keep in sync with lib/diagnostics/connectivity.ts
interface BackendStatus {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  latencyMs: number;
}

interface ConnectivityResponse {
  takenAt: string;
  backends: BackendStatus[];
}

type FetchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; data: ConnectivityResponse }
  | { phase: "error"; message: string };

const AUTO_REFRESH_MS = 30_000;

async function loadConnectivity(): Promise<ConnectivityResponse> {
  const res = await fetch("/api/diagnostics/connectivity");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ConnectivityResponse;
}

export function ConnectivityPanel() {
  const [fetchState, setFetchState] = useState<FetchState>({ phase: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  const runFetch = useCallback((isManual: boolean) => {
    if (isManual) setRefreshing(true);
    setFetchState((prev) =>
      prev.phase === "ok" ? prev : { phase: "loading" }
    );

    loadConnectivity()
      .then((data) => {
        if (!mountedRef.current) return;
        setFetchState({ phase: "ok", data });
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setFetchState({ phase: "error", message: String(err) });
      })
      .finally(() => {
        if (!mountedRef.current) return;
        if (isManual) setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Kick off the initial fetch immediately; auto-refresh via interval.
    // setState calls happen inside .then()/.catch() callbacks, not synchronously
    // in the effect body — this is the correct external-subscription pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runFetch(false);
    const id = setInterval(() => runFetch(false), AUTO_REFRESH_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [runFetch]);

  const isWorking = fetchState.phase === "loading" || refreshing;

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          {fetchState.phase === "ok" && (
            <p className="text-xs text-muted-foreground">
              Checked at{" "}
              {new Date(fetchState.data.takenAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
              {" · "}auto-refreshes every 30 s
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => runFetch(true)}
          disabled={isWorking}
          className="h-7 gap-1.5 text-xs"
        >
          <RefreshCw className={`h-3 w-3 ${isWorking ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Loading skeleton on first fetch */}
      {fetchState.phase === "loading" && (
        <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Checking backend connectivity…</span>
        </div>
      )}

      {/* Fetch error */}
      {fetchState.phase === "error" && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Unable to reach /api/diagnostics/connectivity — {fetchState.message}
        </div>
      )}

      {/* Results table */}
      {fetchState.phase === "ok" && (
        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {fetchState.data.backends.map((b) => {
            const sev = statusWord(b);
            return (
            <div
              key={b.id}
              className="flex items-center gap-3 px-4 py-2.5 text-sm bg-muted/5 hover:bg-muted/20 transition-colors"
            >
              {/* Status dot */}
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${b.ok ? "bg-emerald-600" : "bg-red-600"}`}
                aria-label={sev}
              />

              {/* Label */}
              <span className="w-32 font-medium shrink-0">{b.label}</span>

              {/* Detail — grows to fill available space */}
              <span className="flex-1 text-muted-foreground truncate">{b.detail}</span>

              {/* Latency */}
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                {b.latencyMs} ms
              </span>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
