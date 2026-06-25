"use client";

import * as React from "react";
import type { ModelCard as ModelCardType } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Cpu, Zap, AlertCircle } from "lucide-react";
import { ModelSwapDialog, type SwapTarget } from "./ModelSwapDialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface ModelCardProps {
  model: ModelCardType;
  isPrimary: boolean;
  isPreview: boolean;
}

export function ModelCard({ model, isPrimary, isPreview }: ModelCardProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [swapOpen, setSwapOpen] = React.useState(false);
  const [swapTarget, setSwapTarget] = React.useState<SwapTarget>("primary");

  const swapMutation = useMutation({
    mutationFn: async ({ target, image }: { target: SwapTarget; image: string }) => {
      const body =
        target === "primary"
          ? { model: image }
          : { previewModel: image };
      const res = await fetch("/api/prompt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Swap failed");
    },
    onSuccess: (_, { target }) => {
      queryClient.invalidateQueries({ queryKey: ["prompt"] });
      toast({
        title: `Model swapped`,
        description: `${model.displayName} is now the ${target} model.`,
      });
    },
    onError: () => {
      toast({ title: "Swap failed", variant: "destructive" });
    },
  });

  const openSwap = (target: SwapTarget) => {
    setSwapTarget(target);
    setSwapOpen(true);
  };

  const doSwap = async () => {
    await swapMutation.mutateAsync({ target: swapTarget, image: model.image });
  };

  return (
    <div className={`rounded-lg border p-4 space-y-3 transition-colors ${isPrimary ? "border-primary/60 bg-primary/5" : "border-border bg-card"}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm">{model.displayName}</h3>
            {isPrimary && (
              <Badge className="text-xs bg-primary/20 text-primary border-primary/40">
                Primary
              </Badge>
            )}
            {isPreview && (
              <Badge variant="secondary" className="text-xs">
                Preview
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">
            {model.image}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Cpu className="h-3 w-3" />
          {model.parameterCount} · {model.precision}
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {model.minGpuMemoryGiB} GiB VRAM min
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <Zap className="h-3 w-3" />
          {model.warmupSeconds >= 60
            ? `~${Math.round(model.warmupSeconds / 60)} min warmup`
            : `~${model.warmupSeconds}s warmup`}
        </span>
        {model.l4Validated && (
          <Badge variant="outline" className="text-xs bg-emerald-50 border-emerald-200 text-emerald-700">
            L4 validated
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-muted-foreground font-medium mb-1">Strengths</p>
          <ul className="space-y-0.5">
            {model.strengths.map((s, i) => (
              <li key={i} className="flex gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-700 mt-0.5 shrink-0" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-muted-foreground font-medium mb-1">Limitations</p>
          <ul className="space-y-0.5">
            {model.limitations.map((l, i) => (
              <li key={i} className="flex gap-1">
                <AlertCircle className="h-3 w-3 text-amber-700 mt-0.5 shrink-0" />
                <span>{l}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="text-xs text-muted-foreground italic">{model.scalityUseCase}</p>

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant={isPrimary ? "secondary" : "default"}
          disabled={isPrimary}
          onClick={() => openSwap("primary")}
        >
          {isPrimary ? "Current Primary" : "Make Primary"}
        </Button>
        <Button
          size="sm"
          variant={isPreview ? "secondary" : "outline"}
          disabled={isPreview}
          onClick={() => openSwap("preview")}
        >
          {isPreview ? "Current Preview" : "Make Preview"}
        </Button>
      </div>

      <ModelSwapDialog
        open={swapOpen}
        onOpenChange={setSwapOpen}
        modelName={model.displayName}
        target={swapTarget}
        onConfirm={doSwap}
      />
    </div>
  );
}
