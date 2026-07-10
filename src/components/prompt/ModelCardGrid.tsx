"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ModelCardSchema } from "@/lib/schemas";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { ModelCard } from "./ModelCard";

const ModelsResponseSchema = z.object({
  models: z.array(ModelCardSchema),
  currentModel: z.string(),
  previewModel: z.string().optional(),
  activeModel: z
    .object({
      image: z.string(),
      displayName: z.string(),
      tag: z.string(),
      modelId: z.string().optional(),
      runtime: z.string().optional(),
    })
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

  // Helm profiles: the VLM is chart-managed and not swapped from here. The active
  // model is shown compactly in the page header, so this panel renders nothing.
  if (!data.swappable) return null;

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
