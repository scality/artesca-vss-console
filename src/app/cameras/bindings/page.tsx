"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Check, Link } from "lucide-react";
import { z } from "zod";
import { CameraSchema, ScenarioSchema } from "@/lib/schemas";
import type { Camera, Scenario } from "@/lib/types";

// ─── Data fetching ─────────────────────────────────────────────────────────────

const CamerasResponseSchema = z.object({
  cameras: z.array(
    CameraSchema.extend({ gcsPersisted: z.boolean().optional() }),
  ),
  eip: z.string(),
});

const ScenarioListSchema = z.object({
  scenarios: z.array(ScenarioSchema),
});

function useCamerasQuery() {
  return useQuery({
    queryKey: ["cameras"],
    queryFn: async () => {
      const res = await fetch("/api/cameras");
      if (!res.ok) throw new Error("Failed to fetch cameras");
      const raw = await res.json();
      return CamerasResponseSchema.parse(raw);
    },
    staleTime: 30_000,
  });
}

function useScenariosQuery() {
  return useQuery({
    queryKey: ["scenarios"],
    queryFn: async () => {
      const res = await fetch("/api/scenarios");
      if (!res.ok) throw new Error("Failed to fetch scenarios");
      const raw = await res.json();
      return ScenarioListSchema.parse(raw).scenarios;
    },
    staleTime: 60_000,
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine whether a camera is effectively bound to a scenario.
 * Returns "explicit" when scenarioIds is an array and contains scenarioId,
 * "glob" when there is no override and the sensor_filter would match by glob,
 * "suppressed" when scenarioIds is an empty array (no override fires),
 * or false.
 */
function effectiveBinding(
  camera: Camera,
  scenario: Scenario,
): "explicit" | "glob" | "suppressed" | false {
  if (camera.scenarioIds !== undefined) {
    if (camera.scenarioIds.length === 0) return "suppressed";
    return camera.scenarioIds.includes(scenario.id) ? "explicit" : false;
  }
  // No override — check sensor_filter glob against camera id.
  const globMatch = sensorFilterMatches(scenario.sensorFilter, camera.id);
  return globMatch ? "glob" : false;
}

function sensorFilterMatches(filter: string, cameraId: string): boolean {
  if (!filter || filter === "*") return true;
  const parts = filter.split(",").map((p) => p.trim());
  return parts.some((part) => {
    if (part === "*") return true;
    if (part.endsWith("*")) return cameraId.startsWith(part.slice(0, -1));
    return cameraId === part;
  });
}

// ─── Cell ──────────────────────────────────────────────────────────────────────

interface CellProps {
  camera: Camera;
  scenario: Scenario;
  onToggle: () => void;
  pending: boolean;
}

function BindingCell({ camera, scenario, onToggle, pending }: CellProps) {
  const binding = effectiveBinding(camera, scenario);

  const base =
    "w-full h-full flex items-center justify-center cursor-pointer transition-colors rounded";

  if (binding === "suppressed") {
    return (
      <button
        className={`${base} text-muted-foreground/30`}
        onClick={onToggle}
        disabled={pending}
        title="All scenarios suppressed for this camera — toggle override to enable"
      >
        —
      </button>
    );
  }

  if (binding === "glob") {
    return (
      <button
        className={`${base} text-emerald-600 hover:bg-emerald-600/10`}
        onClick={onToggle}
        disabled={pending}
        title="Matched by sensor_filter glob — click to make explicit override"
      >
        <Check className="h-3.5 w-3.5 opacity-60" />
      </button>
    );
  }

  if (binding === "explicit") {
    return (
      <button
        className={`${base} text-emerald-400 hover:bg-emerald-400/10`}
        onClick={onToggle}
        disabled={pending}
        title="Explicit scenario binding — click to remove"
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
      </button>
    );
  }

  return (
    <button
      className={`${base} text-transparent hover:text-muted-foreground/40 hover:bg-muted/20`}
      onClick={onToggle}
      disabled={pending}
      title="Click to bind this scenario to this camera"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : (
        <Check className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function CameraBindingsPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const { data: camerasData, isLoading: camsLoading, isError: camsError } = useCamerasQuery();
  const { data: scenarios, isLoading: scenLoading, isError: scenError } = useScenariosQuery();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Track which (cameraId, scenarioId) pairs are pending.
  const [pending, setPending] = React.useState<Set<string>>(new Set());

  const toggleMutation = useMutation({
    mutationFn: async ({
      camera,
      scenario,
    }: {
      camera: Camera;
      scenario: Scenario;
    }) => {
      const key = `${camera.id}:${scenario.id}`;
      setPending((p) => new Set(p).add(key));

      // Compute the new scenarioIds array.
      let nextScenarioIds: string[] | null;
      const current = camera.scenarioIds;

      if (current === undefined) {
        // No override yet — create an explicit list from the glob match, then
        // toggle this scenario.
        const allScenarios = scenarios ?? [];
        const globMatched = allScenarios
          .filter((s) => sensorFilterMatches(s.sensorFilter, camera.id))
          .map((s) => s.id);
        const initialSet = new Set(globMatched);
        initialSet.delete(scenario.id); // We're toggling it on→ off since glob had it
        // Actually: if glob matches and user clicks, they want explicit list without this one.
        // If glob doesn't match and user clicks, they want explicit list with this one.
        const globMatch = sensorFilterMatches(scenario.sensorFilter, camera.id);
        if (globMatch) {
          // Remove it from effective set.
          initialSet.delete(scenario.id);
        } else {
          // Add it to effective set.
          initialSet.add(scenario.id);
        }
        nextScenarioIds = Array.from(initialSet);
      } else if (current.length === 0) {
        // Suppressed — toggling adds this one scenario.
        nextScenarioIds = [scenario.id];
      } else if (current.includes(scenario.id)) {
        // Remove it.
        nextScenarioIds = current.filter((id) => id !== scenario.id);
      } else {
        // Add it.
        nextScenarioIds = [...current, scenario.id];
      }

      const body: { scenarioIds: string[] | null; recording?: null } = {
        scenarioIds: nextScenarioIds,
      };

      const res = await fetch(`/api/cameras/${camera.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown" }));
        throw new Error((err as { error?: string }).error ?? "Toggle failed");
      }

      return res.json();
    },
    onSuccess: (_, { camera, scenario }) => {
      const key = `${camera.id}:${scenario.id}`;
      setPending((p) => {
        const next = new Set(p);
        next.delete(key);
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
    },
    onError: (err: Error, { camera, scenario }) => {
      const key = `${camera.id}:${scenario.id}`;
      setPending((p) => {
        const next = new Set(p);
        next.delete(key);
        return next;
      });
      toast({
        title: "Toggle failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const cameras = camerasData?.cameras ?? [];
  const scenarioList = scenarios ?? [];

  const isLoading = camsLoading || scenLoading;
  const isError = camsError || scenError;

  return (
    <Shell>
      <div className="max-w-full mx-auto space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <Link className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Camera × Scenario bindings</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Click a cell to toggle an explicit scenario binding for a camera.
            Greyed checkmarks are inherited from the scenario&apos;s sensor_filter glob.
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-emerald-400" />
            Explicit override
          </span>
          <span className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-emerald-600 opacity-60" />
            Glob match (no override)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground/40">—</span>
            Suppressed (all overridden)
          </span>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading...</span>
          </div>
        )}

        {isError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load cameras or scenarios.
          </div>
        )}

        {!isLoading && !isError && cameras.length > 0 && scenarioList.length > 0 && (
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground bg-muted/30 sticky left-0 min-w-[140px]">
                    Camera
                  </th>
                  {scenarioList.map((sc) => (
                    <th
                      key={sc.id}
                      className="px-2 py-2 font-medium text-muted-foreground bg-muted/30 max-w-[100px] min-w-[80px]"
                      title={sc.description ?? sc.name}
                    >
                      <div className="truncate text-center leading-tight">
                        {sc.name}
                      </div>
                      {!sc.enabled && (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 border-slate-600 text-slate-500 mt-0.5"
                        >
                          off
                        </Badge>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cameras.map((camera) => (
                  <tr key={camera.id} className="border-b border-border/50 last:border-0 hover:bg-muted/10">
                    <td className="px-3 py-1.5 sticky left-0 bg-background font-mono font-medium">
                      <div className="flex items-center gap-1.5">
                        {camera.id}
                        {camera.scenarioIds !== undefined && (
                          <Badge
                            variant="outline"
                            className="text-[9px] px-1 py-0 border-blue-600 text-blue-400"
                          >
                            override
                          </Badge>
                        )}
                      </div>
                    </td>
                    {scenarioList.map((sc) => {
                      const key = `${camera.id}:${sc.id}`;
                      return (
                        <td key={sc.id} className="py-1.5 px-1 text-center h-8">
                          <BindingCell
                            camera={camera}
                            scenario={sc}
                            onToggle={() =>
                              toggleMutation.mutate({ camera, scenario: sc })
                            }
                            pending={pending.has(key)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isLoading && !isError && cameras.length === 0 && (
          <div className="text-center text-muted-foreground py-8 text-sm">
            No cameras registered.
          </div>
        )}

        {!isLoading && !isError && scenarioList.length === 0 && (
          <div className="text-center text-muted-foreground py-8 text-sm">
            No scenarios defined.
          </div>
        )}
      </div>
    </Shell>
  );
}
