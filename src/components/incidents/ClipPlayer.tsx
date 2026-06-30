"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { Incident } from "@/lib/types";

/** Maximum number of automatic HLS retry attempts before giving up. */
const MAX_RETRIES = 3;

/** Delay (ms) between retry attempts. */
const RETRY_DELAY_MS = 4_000;

interface ClipPlayerProps {
  src: string; // HLS playlist URL e.g. /api/clips/:sensor/:ts/index.m3u8
  seekOffset?: number; // seconds into clip to seek on load
  /** Pre-computed clip availability from the alert-worker. When "failed" the
   *  player skips HLS entirely and renders the data-only fallback card. When
   *  "pending" the component still attempts HLS load (clip may have just
   *  materialised) but renders the "preparing" spinner on error instead of the
   *  permanent fallback. */
  clipStatus?: Incident["clipStatus"];
  /** Incident metadata surfaced in the fallback card so the operator still has
   *  something meaningful to show during a demo when the clip is unavailable. */
  fallbackMeta?: {
    ts: string;
    sensorId: string;
    severity: Incident["severity"];
    summary: string;
    scenarioName: string;
  };
}

// ─── Severity badge colours (matches IncidentDetail palette) ─────────────────
const SEVERITY_BADGE: Record<Incident["severity"], string> = {
  low: "bg-blue-50 text-blue-700 border-blue-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-red-50 text-red-700 border-red-200",
};

// ─── Fallback card — data-only view when clip is unavailable ──────────────────

function UnavailableFallback({
  meta,
  technical,
}: {
  meta?: ClipPlayerProps["fallbackMeta"];
  /** Raw technical detail — shown only in a muted line so it's invisible to
   *  the showroom audience but still legible if an operator scrolls. */
  technical?: string;
}) {
  return (
    <div
      data-testid="clip-unavailable"
      className="flex flex-col gap-3 rounded border border-border bg-muted/40 p-4"
    >
      <div className="flex items-center gap-2">
        {/* Neutral camera-off icon */}
        <svg
          className="h-5 w-5 shrink-0 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z"
          />
          <line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" strokeWidth={1.5} />
        </svg>
        <span className="text-sm font-medium text-foreground">Video unavailable</span>
      </div>

      {meta && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Camera / sensor</p>
            <p className="font-mono text-xs">{meta.sensorId}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Detected at</p>
            <p className="text-xs">{new Date(meta.ts).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Severity</p>
            <span
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${SEVERITY_BADGE[meta.severity]}`}
            >
              {meta.severity}
            </span>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Scenario</p>
            <p className="text-xs">{meta.scenarioName}</p>
          </div>
          {meta.summary && (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Description</p>
              <p className="text-xs leading-relaxed">{meta.summary}</p>
            </div>
          )}
        </div>
      )}

      {technical && (
        <p className="text-[10px] text-muted-foreground/50 font-mono leading-relaxed">
          {technical}
        </p>
      )}
    </div>
  );
}

// ─── Materialising spinner — transient "clip not yet ready" state ─────────────

function MaterialisingFallback() {
  return (
    <div
      data-testid="clip-materialising"
      className="flex items-center justify-center gap-2 rounded border border-border bg-muted/40 p-4"
    >
      <svg
        className="h-4 w-4 animate-spin text-muted-foreground"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
        />
      </svg>
      <span className="text-sm text-muted-foreground">Preparing clip…</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ClipPlayer({ src, seekOffset, clipStatus, fallbackMeta }: ClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [hlsError, setHlsError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  // Backend reason for an unavailable clip, fetched from the clip route's 404
  // JSON body when HLS load gives up (the player itself only sees a generic
  // "manifestLoadError"). Surfaces VST's real reason — no recording, clock
  // skew, sensor name not in VST, etc.
  const [serverDiag, setServerDiag] = useState<string | null>(null);

  // If the alert-worker already says the clip has permanently failed, skip HLS
  // entirely and go straight to the data-only fallback.
  const permanentlyFailed = clipStatus === "failed";

  // Whether a HLS error should be treated as transient (still materialising)
  // vs permanent.  "pending" status or early retries = transient.
  const isTransient =
    (clipStatus === "pending" || clipStatus == null) && retryCount < MAX_RETRIES;

  useEffect(() => {
    if (permanentlyFailed) return;

    const video = videoRef.current;
    if (!video) return;

    setHlsError(null);
    setReady(false);

    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        backBufferLength: 30,
      });
      hlsRef.current = hls;

      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setReady(true);
        setHlsError(null);
        if (seekOffset !== undefined && seekOffset > 0) {
          video.currentTime = seekOffset;
        }
        video.play().catch(() => { /* autoplay may be blocked */ });
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setHlsError(data.details ?? "network error");
        }
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      video.src = src;
      video.addEventListener("loadedmetadata", () => {
        setReady(true);
        if (seekOffset !== undefined && seekOffset > 0) {
          video.currentTime = seekOffset;
        }
        video.play().catch(() => { /* autoplay may be blocked */ });
      });
      video.addEventListener("error", () => {
        setHlsError("native HLS error");
      });
    } else {
      setHlsError("HLS not supported in this browser.");
    }
  }, [src, seekOffset, permanentlyFailed, retryCount]);

  // Auto-retry after a delay when a transient HLS error is detected.
  useEffect(() => {
    if (!hlsError || !isTransient) return;
    const timer = setTimeout(() => {
      setRetryCount((n) => n + 1);
    }, RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hlsError, isTransient]);

  // When the clip is permanently unavailable (alert-worker said "failed", or
  // HLS exhausted its retries), pull the clip route's 404 JSON body so the
  // fallback card can explain why — VST's diagnostics instead of a bare error.
  const showingFallback =
    permanentlyFailed || (hlsError != null && !isTransient);
  useEffect(() => {
    if (!showingFallback || serverDiag != null) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(src, { cache: "no-store" });
        if (resp.ok) return; // clip actually exists — nothing to explain
        const body = (await resp.json()) as {
          error?: string;
          resolvedStreamId?: string | null;
          window?: { start?: string; end?: string };
          diagnostics?: string[];
        };
        const parts = [
          `HTTP ${resp.status}`,
          body.error,
          body.resolvedStreamId
            ? `stream ${body.resolvedStreamId}`
            : "stream unresolved",
          body.window?.start && body.window?.end
            ? `window ${body.window.start} → ${body.window.end}`
            : null,
          ...(body.diagnostics ?? []),
        ].filter(Boolean);
        if (!cancelled) setServerDiag(parts.join(" · "));
      } catch (e) {
        if (!cancelled)
          setServerDiag(
            `clip route unreachable: ${e instanceof Error ? e.message : String(e)}`
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showingFallback, src, serverDiag]);

  // Keyboard shortcuts
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready) return;

    function onKey(e: KeyboardEvent) {
      if (!video) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (video.paused) {
          video.play();
        } else {
          video.pause();
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 2);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        video.currentTime = video.currentTime + 2;
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          video.requestFullscreen?.();
        }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready]);

  // ── Render: permanent failure (alert-worker says "failed") ────────────────
  if (permanentlyFailed) {
    return <UnavailableFallback meta={fallbackMeta} technical={serverDiag ?? undefined} />;
  }

  // ── Render: HLS error ─────────────────────────────────────────────────────
  if (hlsError) {
    if (isTransient) {
      // Clip is still materialising or early retry — show spinner.
      return <MaterialisingFallback />;
    }
    // Exhausted retries → data-only fallback. Prefer the backend's diagnostic
    // (VST reason) over the generic HLS error string.
    return (
      <UnavailableFallback meta={fallbackMeta} technical={serverDiag ?? hlsError} />
    );
  }

  // ── Render: normal player ─────────────────────────────────────────────────
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded bg-black">
      <video
        ref={videoRef}
        className="h-full w-full"
        controls
        playsInline
        muted
      />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-muted-foreground animate-pulse">
            Loading clip…
          </span>
        </div>
      )}
      <div className="absolute bottom-1 right-2 text-[10px] text-white/40 pointer-events-none">
        Space=play/pause · ←/→=seek 2s · F=fullscreen
      </div>
    </div>
  );
}
