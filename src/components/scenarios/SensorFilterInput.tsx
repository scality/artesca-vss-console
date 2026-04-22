"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { glob2regex } from "@/lib/utils";
import { z } from "zod";
import { CameraSchema } from "@/lib/schemas";

const CamerasResponseSchema = z.object({
  cameras: z.array(CameraSchema),
});

interface SensorFilterInputProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

export function SensorFilterInput({
  value,
  onChange,
  disabled,
}: SensorFilterInputProps) {
  const { data } = useQuery({
    queryKey: ["cameras"],
    queryFn: async () => {
      const res = await fetch("/api/cameras");
      if (!res.ok) return { cameras: [] };
      const raw = await res.json();
      return CamerasResponseSchema.parse(raw);
    },
    staleTime: 30_000,
  });

  const allSensorIds = React.useMemo(() => {
    if (!data) return [];
    return data.cameras.flatMap((c) => c.feeds.map((f) => f.sensorId));
  }, [data]);

  const matchCount = React.useMemo(() => {
    if (!value || allSensorIds.length === 0) return null;
    try {
      const patterns = value.split(",").map((p) => p.trim()).filter(Boolean);
      const regexes = patterns.map((p) => glob2regex(p));
      const matched = allSensorIds.filter((id) =>
        regexes.some((re) => re.test(id))
      );
      return matched.length;
    } catch {
      return null;
    }
  }, [value, allSensorIds]);

  return (
    <div className="space-y-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="checkout-* or checkout-1-a,aisle-*"
        className="h-8 text-xs font-mono"
      />
      {matchCount !== null && (
        <p className="text-xs text-muted-foreground">
          Matches {matchCount} of {allSensorIds.length} sensor
          {allSensorIds.length !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}
