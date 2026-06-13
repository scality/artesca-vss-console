"use client";

import { useEffect, useState } from "react";
import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SgWhitelistTable } from "@/components/settings/SgWhitelistTable";
import { AddCidrDialog } from "@/components/settings/AddCidrDialog";
import { KioskToggle } from "@/components/settings/KioskToggle";
import { FeatureFlagsCard } from "@/components/settings/FeatureFlagsCard";
import { RbacInspector } from "@/components/settings/RbacInspector";
import { RotationNagBanner } from "@/components/secrets/RotationNagBanner";
import { useToast } from "@/hooks/use-toast";
import type { SgWhitelistEntry } from "@/lib/types";

const NAG_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

export default function SettingsPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const [entries, setEntries] = useState<SgWhitelistEntry[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [rotations, setRotations] = useState<Record<string, number | null>>({});
  const { toast } = useToast();

  async function fetchSg() {
    const res = await fetch("/api/settings/sg");
    if (!res.ok) return;
    const data = await res.json();
    // GET /api/settings/sg returns { entries: [...] }; tolerate a bare array too.
    setEntries(Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : []);
  }

  async function fetchRotations() {
    const res = await fetch("/api/settings/rotations").catch(() => null);
    if (!res || !res.ok) return;
    const data = await res.json();
    setRotations(data);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchSg(); void fetchRotations(); }, []);

  async function handleAdd(cidr: string, label: string) {
    const res = await fetch("/api/settings/sg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cidr, label }),
    });
    if (!res.ok) {
      toast({ title: "Failed to add CIDR", description: await res.text(), variant: "destructive" });
      return;
    }
    toast({ title: `${cidr} added to SG allow-list` });
    fetchSg();
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this CIDR from the SG allow-list?")) return;
    const res = await fetch(`/api/settings/sg/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast({ title: "Failed to remove CIDR", variant: "destructive" });
      return;
    }
    toast({ title: "CIDR removed" });
    fetchSg();
  }

  const staleKeys = Object.entries(rotations)
    .filter(([, age]) => age !== null && age >= NAG_THRESHOLD_MS)
    .map(([key]) => key);

  return (
    <Shell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Console configuration — network access, kiosk mode, feature flags, RBAC.
          </p>
        </div>

        {staleKeys.length > 0 && (
          <div>
            <RotationNagBanner staleKeys={staleKeys} />
            <p className="mt-2 text-xs text-muted-foreground">
              Rotate overdue secrets at{" "}
              <a href="/secrets" className="underline text-primary">
                /secrets
              </a>
              .
            </p>
          </div>
        )}

        {/* Network access */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Network access — SG allow-list</CardTitle>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                Add CIDR
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <SgWhitelistTable entries={entries} onDelete={handleDelete} />
          </CardContent>
        </Card>

        {/* Kiosk mode */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kiosk mode</CardTitle>
          </CardHeader>
          <CardContent>
            <KioskToggle />
          </CardContent>
        </Card>

        {/* SSH key rotation notice */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Camera-sim SSH key</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {rotations["camera-sim-ssh-key"] !== undefined ? (
              <p>
                Last rotated:{" "}
                {rotations["camera-sim-ssh-key"] !== null
                  ? `${Math.floor((rotations["camera-sim-ssh-key"] as number) / (1000 * 60 * 60 * 24))} days ago`
                  : "never"}
              </p>
            ) : null}
            <p className="text-muted-foreground">
              Rotate the SSH key at{" "}
              <a href="/secrets" className="underline text-primary">
                /secrets → Camera-sim SSH Key
              </a>
              .
            </p>
          </CardContent>
        </Card>

        {/* Console auth password */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Console auth password</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-muted-foreground">
              Rotate at{" "}
              <a href="/secrets" className="underline text-primary">
                /secrets → Console Auth Password
              </a>
              .
            </p>
          </CardContent>
        </Card>

        {/* Feature flags */}
        <FeatureFlagsCard />

        {/* RBAC inspector */}
        <RbacInspector />
      </div>

      <AddCidrDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={handleAdd}
      />
    </Shell>
  );
}
