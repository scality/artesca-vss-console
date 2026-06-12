"use client";

// src/components/topology/NodeDetailPanel.tsx
// Slide-in side panel (right edge) replacing NodeDetailDialog for the topology page.
// Hand-rolled with Tailwind — no shadcn Sheet available in this project.

import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { useKiosk } from "@/components/KioskProvider";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import type { NodeContent, NodeType } from "./registry";
import type { NodeRuntimeState, PipelineHealth, PipelineSnapshot } from "@/lib/types/pipeline";

// ─────────────────────────────────────────────────────────────────────────────
// Tab definition
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical display order for tabs. */
const ALL_TABS = ["status", "metrics", "config", "actions"] as const;
type TabKey = (typeof ALL_TABS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  status: "Status",
  metrics: "Metrics",
  config: "Config",
  actions: "Actions",
};

/** Tabs hidden in kiosk mode. */
const KIOSK_HIDDEN: Set<TabKey> = new Set(["config", "actions"]);

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton
// ─────────────────────────────────────────────────────────────────────────────

function TabSkeleton() {
  return (
    <div className="space-y-3 animate-pulse p-4">
      <div className="h-3 w-2/3 rounded bg-muted" />
      <div className="h-3 w-1/2 rounded bg-muted" />
      <div className="h-3 w-3/4 rounded bg-muted" />
      <div className="h-3 w-1/3 rounded bg-muted" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeDetailPanelProps {
  open: boolean;
  nodeId: string | null;
  nodeLabel: string;
  nodeType: NodeType;
  namespace?: string;
  content: NodeContent | undefined;
  runtimeState: NodeRuntimeState | undefined;
  snapshot: PipelineSnapshot | undefined;
  onClose: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function NodeDetailPanel({
  open,
  nodeId,
  nodeLabel,
  namespace,
  content,
  runtimeState,
  snapshot,
  onClose,
}: NodeDetailPanelProps) {
  const { kiosk } = useKiosk();

  // Build the list of visible tabs: only tabs that have a registered renderer
  // and are not hidden by kiosk mode.
  const visibleTabs = ALL_TABS.filter((key) => {
    if (kiosk && KIOSK_HIDDEN.has(key)) return false;
    return !!content?.[key];
  });

  // Default to "status" if present, otherwise the first available tab.
  const defaultTab: TabKey =
    visibleTabs.includes("status") ? "status" : (visibleTabs[0] ?? "status");

  const [activeTab, setActiveTab] = useState<TabKey>(defaultTab);

  // Reset to the default tab whenever the selected node changes.
  const prevNodeId = useRef<string | null>(null);
  useEffect(() => {
    if (nodeId !== prevNodeId.current) {
      prevNodeId.current = nodeId;
      setActiveTab(defaultTab);
    }
  }, [nodeId, defaultTab]);

  // Keyboard handling: Esc → close; ← / → → switch tabs.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const idx = visibleTabs.indexOf(activeTab);
      if (e.key === "ArrowLeft" && idx > 0) {
        setActiveTab(visibleTabs[idx - 1]);
      } else if (e.key === "ArrowRight" && idx < visibleTabs.length - 1) {
        setActiveTab(visibleTabs[idx + 1]);
      }
    },
    [open, onClose, visibleTabs, activeTab],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Health for the header badge — fall back to "unknown" when state not loaded yet.
  const health: PipelineHealth = runtimeState?.health ?? "unknown";

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Backdrop (click-to-close, semi-transparent) */}
      <div
        aria-hidden
        className={[
          "fixed inset-0 z-30 transition-opacity duration-200",
          open ? "pointer-events-auto bg-black/30" : "pointer-events-none opacity-0",
        ].join(" ")}
        onClick={onClose}
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Node detail: ${nodeLabel}`}
        className={[
          "fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col",
          "bg-background border-l border-border shadow-xl",
          "transition-transform duration-200 ease-in-out",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {/* ── Header ── */}
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge health={health} />
              <span className="font-mono text-sm font-semibold truncate">{nodeLabel}</span>
            </div>
            {namespace && (
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                ns: {namespace}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto">
          {visibleTabs.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No detail panels registered for this node.
            </div>
          ) : (
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as TabKey)}
              className="flex h-full flex-col"
            >
              <TabsList className="mx-4 mt-3 justify-start rounded-md h-9 gap-0.5">
                {visibleTabs.map((key) => (
                  <TabsTrigger key={key} value={key} className="text-xs px-3 py-1">
                    {TAB_LABELS[key]}
                  </TabsTrigger>
                ))}
              </TabsList>

              {visibleTabs.map((key) => {
                const renderer = content?.[key];
                return (
                  <TabsContent key={key} value={key} className="flex-1 mt-0 p-4">
                    {runtimeState === undefined ? (
                      <TabSkeleton />
                    ) : renderer && nodeId ? (
                      // Render as a component element (not a bare function call) so
                      // each tab renderer gets its own fiber + hook scope. Several
                      // renderers call hooks (useToast, useState); invoking them as
                      // `renderer(props)` leaked those into NodeDetailPanel's hook
                      // sequence, which changed order per node type (Rules of Hooks).
                      createElement(renderer, { nodeId, runtimeState, snapshot })
                    ) : (
                      <TabSkeleton />
                    )}
                  </TabsContent>
                );
              })}
            </Tabs>
          )}
        </div>
      </aside>
    </>
  );
}
