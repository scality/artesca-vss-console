"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface FeatureFlags {
  enablePreviewNim: boolean;
  enableRehearsalBigButton: boolean;
  enableSlack: boolean;
}

const FLAG_LABELS: Record<keyof FeatureFlags, string> = {
  enablePreviewNim: "Enable preview NIM (NVILA-Lite-2B on GPU 1)",
  enableRehearsalBigButton: "Enable rehearsal mode big button on demo-data page",
  enableSlack: "Enable Slack alert channel",
};

export function FeatureFlagsCard() {
  const [flags, setFlags] = useState<FeatureFlags>({
    enablePreviewNim: false,
    enableRehearsalBigButton: true,
    enableSlack: false,
  });
  const { toast } = useToast();

  useEffect(() => {
    fetch("/api/settings/flags")
      .then((r) => r.json())
      .then((data: Partial<FeatureFlags>) => setFlags((f) => ({ ...f, ...data })))
      .catch(() => {});
  }, []);

  async function toggle(key: keyof FeatureFlags, value: boolean) {
    const next = { ...flags, [key]: value };
    setFlags(next);
    const res = await fetch("/api/settings/flags", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    if (!res.ok) {
      toast({ title: "Failed to update flag", variant: "destructive" });
      setFlags(flags); // rollback
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Feature flags</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {(Object.keys(FLAG_LABELS) as Array<keyof FeatureFlags>).map((key) => (
          <div key={key} className="flex items-center gap-3">
            <Switch
              id={`flag-${key}`}
              checked={flags[key]}
              onCheckedChange={(v) => toggle(key, v)}
            />
            <Label htmlFor={`flag-${key}`} className="text-sm">
              {FLAG_LABELS[key]}
            </Label>
          </div>
        ))}
        <p className="text-xs text-muted-foreground pt-2">
          Flags are persisted in SQLite but not yet wired to runtime behavior.
        </p>
      </CardContent>
    </Card>
  );
}
