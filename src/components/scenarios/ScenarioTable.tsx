"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Scenario } from "@/lib/types";
import { ScenarioSchema } from "@/lib/schemas";
import { z } from "zod";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, Save, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ScenarioRow } from "./ScenarioRow";
import { ScenarioDiffDialog } from "./ScenarioDiffDialog";

const ScenarioListSchema = z.object({
  scenarios: z.array(ScenarioSchema),
});

function generateId() {
  return `scenario-${Date.now().toString(36)}`;
}

export function ScenarioTable() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [localScenarios, setLocalScenarios] = React.useState<Scenario[] | null>(null);
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [conflictBanner, setConflictBanner] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["scenarios"],
    queryFn: async () => {
      const res = await fetch("/api/scenarios");
      if (!res.ok) throw new Error("Failed to fetch scenarios");
      const raw = await res.json();
      return ScenarioListSchema.parse(raw);
    },
    staleTime: 60_000,
  });

  // Sync local state from server on first load
  React.useEffect(() => {
    if (data && localScenarios === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializing local edit copy from server data
      setLocalScenarios(data.scenarios);
    }
  }, [data, localScenarios]);

  const isDirty = React.useMemo(() => {
    if (!data || !localScenarios) return false;
    return JSON.stringify(data.scenarios) !== JSON.stringify(localScenarios);
  }, [data, localScenarios]);

  const addScenario = () => {
    const newScenario: Scenario = {
      id: generateId(),
      name: "New Scenario",
      severity: "medium",
      channels: ["ui"],
      sensorFilter: "*",
      keywords: [],
      enabled: true,
    };
    setLocalScenarios((prev) => (prev ? [newScenario, ...prev] : [newScenario]));
  };

  const updateScenario = (updated: Scenario) => {
    setLocalScenarios((prev) =>
      prev ? prev.map((s) => (s.id === updated.id ? updated : s)) : [updated]
    );
  };

  const deleteScenario = (id: string) => {
    setLocalScenarios((prev) => (prev ? prev.filter((s) => s.id !== id) : []));
  };

  const duplicateScenario = (scenario: Scenario) => {
    const dup: Scenario = {
      ...scenario,
      id: generateId(),
      name: `${scenario.name} (copy)`,
    };
    setLocalScenarios((prev) => {
      if (!prev) return [dup];
      const idx = prev.findIndex((s) => s.id === scenario.id);
      const next = [...prev];
      next.splice(idx + 1, 0, dup);
      return next;
    });
  };

  const doSave = async () => {
    if (!localScenarios) return;
    setSaving(true);
    try {
      const res = await fetch("/api/scenarios", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarios: localScenarios }),
      });

      if (res.status === 409) {
        setConflictBanner(true);
        setSaving(false);
        setDiffOpen(false);
        await queryClient.invalidateQueries({ queryKey: ["scenarios"] });
        return;
      }

      if (!res.ok) {
        throw new Error("Save failed");
      }

      await queryClient.invalidateQueries({ queryKey: ["scenarios"] });
      setDiffOpen(false);
      toast({ title: "Scenarios saved" });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const scenarios = localScenarios ?? data?.scenarios ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Scenarios</h2>
          <p className="text-sm text-muted-foreground">
            Configure alert rules. Changes are staged locally until you save.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={addScenario}>
            <Plus className="h-4 w-4 mr-1" />
            Add Scenario
          </Button>
          <Button
            size="sm"
            onClick={() => setDiffOpen(true)}
            disabled={!isDirty}
          >
            <Save className="h-4 w-4 mr-1" />
            Save
          </Button>
        </div>
      </div>

      {conflictBanner && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-600/50 bg-yellow-600/10 p-3 text-sm text-yellow-400">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            Another operator changed scenarios — the server state has been
            reloaded. Review the updated state and retry.
            <button
              className="ml-2 underline text-xs"
              onClick={() => {
                setConflictBanner(false);
                setLocalScenarios(data?.scenarios ?? null);
              }}
            >
              Reset to server
            </button>
          </div>
        </div>
      )}

      {isDirty && (
        <div className="text-xs text-yellow-400 bg-yellow-400/10 rounded px-3 py-1.5 border border-yellow-400/20">
          Unsaved changes — click Save to review and apply.
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading scenarios...</span>
        </div>
      )}

      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load scenarios
        </div>
      )}

      <div className="rounded-md border border-border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">On</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Keywords</TableHead>
              <TableHead>Sensor Filter</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Channels</TableHead>
              <TableHead className="w-24">Cooldown (s)</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {scenarios.length === 0 && !isLoading && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-muted-foreground py-8"
                >
                  No scenarios. Add one to start alerting.
                </TableCell>
              </TableRow>
            )}
            {scenarios.map((scenario) => (
              <ScenarioRow
                key={scenario.id}
                scenario={scenario}
                onChange={updateScenario}
                onDelete={() => deleteScenario(scenario.id)}
                onDuplicate={() => duplicateScenario(scenario)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <ScenarioDiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        original={data?.scenarios ?? []}
        modified={localScenarios ?? []}
        onConfirm={doSave}
        saving={saving}
      />
    </div>
  );
}
