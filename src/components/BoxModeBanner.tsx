"use client";

import { ExternalLink, CirclePause } from "lucide-react";
import { isBoxPaused, pausedHeadline, type BoxMode } from "@/lib/box-mode-shared";

/**
 * Shown on every page while the box is not in `vss` mode: the AI Factory's
 * GPU switch has the VSS GPU workloads scaled to 0, so live video, incidents
 * and the VLM are down by design and the console holds its writes to them.
 *
 * Operator view: a strip above the page. Kiosk: a full-screen notice, because
 * a showroom wall of empty panels reads as broken, not as "switched".
 */
export function BoxModeBanner({
  boxMode,
  aiFactoryUrl,
  kiosk,
}: {
  boxMode: BoxMode | null;
  aiFactoryUrl: string;
  kiosk: boolean;
}) {
  if (!boxMode || !isBoxPaused(boxMode)) return null;
  const headline = pausedHeadline(boxMode.mode);
  const since = boxMode.updatedAt ? new Date(boxMode.updatedAt) : null;
  const sinceText = since && !Number.isNaN(since.getTime()) ? since.toLocaleString() : null;
  const detail = [
    `mode ${boxMode.mode}`,
    boxMode.pinned ? "pinned" : null,
    sinceText ? `since ${sinceText}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (kiosk) {
    return (
      <div
        role="alert"
        data-testid="box-mode-kiosk-notice"
        className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-background/95 p-8 text-center backdrop-blur"
      >
        <CirclePause className="h-16 w-16 text-amber-600" aria-hidden />
        <h1 className="max-w-3xl text-4xl font-semibold text-foreground" style={{ fontFamily: "var(--font-display)" }}>
          {headline}
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Live video analysis resumes when the box is switched back to VSS.
        </p>
        <a
          href={aiFactoryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-3 text-base font-medium text-primary-foreground hover:opacity-90"
        >
          Open the AI Factory
          <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid="box-mode-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800"
    >
      <CirclePause className="h-4 w-4 shrink-0" aria-hidden />
      <span className="font-medium">{headline}</span>
      <span className="text-xs text-amber-700">
        {detail}. Restarts and tuning of the VSS GPU workloads are paused; reads stay live.
      </span>
      <a
        href={aiFactoryUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-amber-900"
      >
        Open the AI Factory
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    </div>
  );
}
