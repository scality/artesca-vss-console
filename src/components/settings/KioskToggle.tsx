"use client";

import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useKiosk } from "@/components/KioskProvider";
import { useToast } from "@/hooks/use-toast";

export function KioskToggle() {
  const { kiosk } = useKiosk();
  const { toast } = useToast();

  async function toggle(checked: boolean) {
    const res = await fetch("/api/settings/kiosk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kiosk: checked }),
    });
    if (res.ok) {
      toast({
        title: checked
          ? "Kiosk mode enabled — reload to apply"
          : "Kiosk mode disabled — reload to apply",
      });
      window.location.reload();
    } else {
      toast({ title: "Failed to update kiosk mode", variant: "destructive" });
    }
  }

  return (
    <div className="flex items-start gap-4">
      <Switch id="kiosk-toggle" checked={kiosk} onCheckedChange={toggle} />
      <div className="space-y-0.5">
        <Label htmlFor="kiosk-toggle" className="text-sm font-medium">
          Kiosk mode
        </Label>
        <p className="text-xs text-muted-foreground">
          Hides operator pages (/cameras, /scenarios, /prompt, /logs, /settings, etc.).
          Only overview, topology, and incidents remain visible. Use for the showroom projector.
        </p>
      </div>
    </div>
  );
}
