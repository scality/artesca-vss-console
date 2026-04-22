"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatAge } from "@/lib/utils";

const NAG_THRESHOLD_DAYS = 90;

interface SecretRowProps {
  label: string;
  configured: boolean;
  ageMs: number | null; // null = never rotated / not configured
  onRotate: () => void;
}

export function SecretRow({ label, configured, ageMs, onRotate }: SecretRowProps) {
  const ageDays = ageMs !== null ? Math.floor(ageMs / (1000 * 60 * 60 * 24)) : null;
  const overdue = ageDays !== null && ageDays >= NAG_THRESHOLD_DAYS;

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-2">
          <Badge variant={configured ? "default" : "secondary"} className="text-[10px]">
            {configured ? "configured" : "not configured"}
          </Badge>
          {ageMs !== null && (
            <span className={`text-xs ${overdue ? "text-destructive font-medium" : "text-muted-foreground"}`}>
              Last rotated {formatAge(ageMs)} ago
              {overdue && " — overdue"}
            </span>
          )}
          {ageMs === null && configured && (
            <span className="text-xs text-muted-foreground">rotation not tracked</span>
          )}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onRotate}>
        Rotate
      </Button>
    </div>
  );
}
