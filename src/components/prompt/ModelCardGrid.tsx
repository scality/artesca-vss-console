"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ModelCardSchema } from "@/lib/schemas";
import { z } from "zod";
import { Loader2, Cpu, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ModelCard } from "./ModelCard";

const ModelsResponseSchema = z.object({
  models: z.array(ModelCardSchema),
  currentModel: z.string(),
  previewModel: z.string().optional(),
  activeModel: z
    .object({ image: z.string(), displayName: z.string(), tag: z.string() })
    .nullable()
    .optional(),
  swappable: z.boolean().optional(),
  reasoningModelHref: z.string().optional(),
});

export function ModelCardGrid() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const res = await fetch("/api/models");
      if (!res.ok) throw new Error("Failed to fetch models");
      const raw = await res.json();
      return ModelsResponseSchema.parse(raw);
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Loading model…</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load model info.
      </div>
    );
  }

  // Helm profiles: the VLM is chart-managed and not swapped from here — show the
  // live-deployed model read-only and route reasoning-model changes to /agent.
  if (!data.swappable) {
    const href = data.reasoningModelHref ?? "/agent";
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold">Vision-language model</h3>
          <p className="text-sm text-muted-foreground">
            The VLM is managed by the VSS deployment and isn&apos;t swapped from here.
          </p>
        </div>
        <div className="rounded-lg border border-primary/60 bg-primary/5 p-4">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-brand-teal" />
            <span className="text-sm font-semibold">
              {data.activeModel?.displayName ?? "VLM"}
            </span>
            <Badge className="text-xs bg-primary/20 text-primary border-primary/40">Active</Badge>
          </div>
          {data.activeModel?.image && (
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {data.activeModel.image}
            </p>
          )}
          {!data.activeModel && (
            <p className="mt-1 text-xs text-muted-foreground">
              Live model unavailable — the VLM deployment couldn&apos;t be read.
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            The reasoning model (e.g. Nemotron or Claude) is configured on{" "}
            <a href={href} className="inline-flex items-center gap-0.5 font-medium text-brand-teal hover:underline">
              Agent
              <ArrowUpRight className="h-3 w-3" />
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Model Catalog</h3>
        <p className="text-sm text-muted-foreground">
          Select the primary VLM for live inference, or the preview model for
          prompt testing.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.models.map((model) => (
          <ModelCard
            key={model.image}
            model={model}
            isPrimary={model.image === data.currentModel}
            isPreview={model.image === data.previewModel}
          />
        ))}
      </div>
    </div>
  );
}
