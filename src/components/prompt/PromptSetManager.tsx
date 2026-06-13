"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export interface PromptSet {
  id: string;
  name: string;
  text: string;
  model?: string;
  alertType?: string;
}

interface PromptSetManagerProps {
  sets: PromptSet[];
  activePromptId: string | null | undefined;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "set";
}

interface SetFormState {
  id: string;
  name: string;
  text: string;
  model: string;
  alertType: string;
}

const EMPTY_FORM: SetFormState = { id: "", name: "", text: "", model: "", alertType: "" };

export function PromptSetManager({ sets, activePromptId }: PromptSetManagerProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Form state: null = closed, populated = open (new or edit)
  const [formState, setFormState] = React.useState<SetFormState | null>(null);
  const [isNew, setIsNew] = React.useState(false);

  // Delete confirm state
  const [deleteTarget, setDeleteTarget] = React.useState<PromptSet | null>(null);

  // Collapsed state for the whole section
  const [collapsed, setCollapsed] = React.useState(false);

  // ── Activate mutation ───────────────────────────────────────────────────────
  const activateMutation = useMutation({
    mutationFn: async (setId: string) => {
      const res = await fetch("/api/prompt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activePromptId: setId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as { error?: string }).error ?? "Activate failed");
      }
    },
    onSuccess: (_data, setId) => {
      const name = sets.find((s) => s.id === setId)?.name ?? setId;
      queryClient.invalidateQueries({ queryKey: ["prompt"] });
      toast({ title: `Activated "${name}" — VLM restarting (~30 s)` });
    },
    onError: (err: Error) => {
      toast({ title: "Activate failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Upsert mutation ─────────────────────────────────────────────────────────
  const upsertMutation = useMutation({
    mutationFn: async (set: { id: string; name: string; text: string; model?: string; alertType?: string }) => {
      const res = await fetch("/api/prompt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as { error?: string }).error ?? "Save failed");
      }
    },
    onSuccess: (_data, set) => {
      queryClient.invalidateQueries({ queryKey: ["prompt"] });
      setFormState(null);
      toast({ title: `Prompt set "${set.name}" saved` });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Delete mutation ─────────────────────────────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: async (deleteSetId: string) => {
      const res = await fetch("/api/prompt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteSetId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as { error?: string }).error ?? "Delete failed");
      }
    },
    onSuccess: (_data, setId) => {
      const name = deleteTarget?.name ?? setId;
      queryClient.invalidateQueries({ queryKey: ["prompt"] });
      setDeleteTarget(null);
      toast({ title: `Prompt set "${name}" deleted` });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Form helpers ────────────────────────────────────────────────────────────
  const openNew = () => {
    setIsNew(true);
    setFormState({ ...EMPTY_FORM });
  };

  const openEdit = (set: PromptSet) => {
    setIsNew(false);
    setFormState({ id: set.id, name: set.name, text: set.text, model: set.model ?? "", alertType: set.alertType ?? "" });
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formState) return;
    const id = isNew ? slugify(formState.name) : formState.id;
    upsertMutation.mutate({
      id,
      name: formState.name,
      text: formState.text,
      ...(formState.model ? { model: formState.model } : {}),
      ...(formState.alertType ? { alertType: formState.alertType } : {}),
    });
  };

  const nameSlug = formState && isNew ? slugify(formState.name) : "";

  return (
    <div className="rounded-lg border border-border">
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <div>
          <span className="text-sm font-semibold">Prompt Library</span>
          <span className="ml-2 text-xs text-muted-foreground">
            {sets.length} set{sets.length !== 1 ? "s" : ""}
          </span>
        </div>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
          {/* Set list */}
          {sets.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No prompt sets yet. Create one to build a reusable library.
            </p>
          ) : (
            <ul className="space-y-2">
              {sets.map((set) => {
                const isActive = set.id === activePromptId;
                return (
                  <li
                    key={set.id}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{set.name}</span>
                        {isActive && (
                          <Badge
                            variant="default"
                            className="text-xs bg-emerald-500/20 text-emerald-400 border-emerald-500/30 border"
                          >
                            Active
                          </Badge>
                        )}
                        {set.model && (
                          <span className="text-xs text-muted-foreground font-mono">
                            {set.model}
                          </span>
                        )}
                        {set.alertType && (
                          <span className="text-xs text-muted-foreground">
                            alert: {set.alertType}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 pr-2">
                        {set.text.slice(0, 120)}
                        {set.text.length > 120 ? "…" : ""}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {!isActive && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => activateMutation.mutate(set.id)}
                          disabled={activateMutation.isPending}
                          title="Activate this prompt set (applies + restarts VLM)"
                        >
                          {activateMutation.isPending && activateMutation.variables === set.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3" />
                          )}
                          <span className="ml-1 text-xs">Activate</span>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(set)}
                        title="Edit this prompt set"
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteTarget(set)}
                        disabled={isActive}
                        title={isActive ? "Cannot delete the active set" : "Delete this prompt set"}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Add button */}
          <Button size="sm" variant="outline" onClick={openNew}>
            <Plus className="h-3 w-3 mr-1" />
            New set
          </Button>
        </div>
      )}

      {/* New / Edit form dialog */}
      <Dialog open={formState !== null} onOpenChange={(open) => { if (!open && !upsertMutation.isPending) setFormState(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{isNew ? "New Prompt Set" : "Edit Prompt Set"}</DialogTitle>
            <DialogDescription>
              {isNew
                ? "Create a named prompt set to save for later use."
                : `Editing "${formState?.name}".`}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ps-name">Name</Label>
              <Input
                id="ps-name"
                value={formState?.name ?? ""}
                onChange={(e) =>
                  setFormState((s) => s ? { ...s, name: e.target.value } : s)
                }
                placeholder="Retail Loss Prevention"
                required
                minLength={1}
              />
              {isNew && nameSlug && (
                <p className="text-xs text-muted-foreground">
                  ID: <code className="font-mono">{nameSlug}</code>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ps-model">Model override <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                id="ps-model"
                value={formState?.model ?? ""}
                onChange={(e) =>
                  setFormState((s) => s ? { ...s, model: e.target.value } : s)
                }
                placeholder="nvidia-nemotron-nano-9b-v2"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ps-alert-type">Alert type <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                id="ps-alert-type"
                value={formState?.alertType ?? ""}
                onChange={(e) =>
                  setFormState((s) => s ? { ...s, alertType: e.target.value } : s)
                }
                placeholder="Self-Checkout Shrink"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ps-text">Prompt text</Label>
              <textarea
                id="ps-text"
                className="flex min-h-[180px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y font-mono"
                value={formState?.text ?? ""}
                onChange={(e) =>
                  setFormState((s) => s ? { ...s, text: e.target.value } : s)
                }
                placeholder="You are a retail loss prevention assistant…"
                required
                minLength={1}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setFormState(null)}
                disabled={upsertMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={upsertMutation.isPending || !formState?.name || !formState?.text}>
                {upsertMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save set"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleteMutation.isPending) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete prompt set?</DialogTitle>
            <DialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.name}&rdquo;. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
