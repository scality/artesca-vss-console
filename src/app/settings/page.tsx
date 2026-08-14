"use client";

import { useEffect, useState } from "react";
import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { KioskToggle } from "@/components/settings/KioskToggle";
import { RbacInspector } from "@/components/settings/RbacInspector";
import { RotationNagBanner } from "@/components/secrets/RotationNagBanner";

const NAG_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

export default function SettingsPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const [rotations, setRotations] = useState<Record<string, number | null>>({});

  async function fetchRotations() {
    const res = await fetch("/api/settings/rotations").catch(() => null);
    if (!res || !res.ok) return;
    const data = await res.json();
    setRotations(data);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchRotations(); }, []);

  const staleKeys = Object.entries(rotations)
    .filter(([, age]) => age !== null && age >= NAG_THRESHOLD_MS)
    .map(([key]) => key);

  return (
    <Shell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Console configuration — kiosk mode, feature flags, RBAC.
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

        {/* RBAC inspector */}
        <RbacInspector />
      </div>
    </Shell>
  );
}
