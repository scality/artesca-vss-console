"use client";

import { useEffect, useState } from "react";
import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SecretRow } from "@/components/secrets/SecretRow";
import { RotateSecretDialog } from "@/components/secrets/RotateSecretDialog";
import { RotationNagBanner } from "@/components/secrets/RotationNagBanner";
import { useToast } from "@/hooks/use-toast";

interface SecretStatus {
  key: string;
  label: string;
  configured: boolean;
  ageMs: number | null;
  multiField?: boolean;
}

const SECRET_KEYS: Array<{ key: string; label: string; multiField?: boolean }> = [
  { key: "ngc-key", label: "NGC Key" },
  { key: "nvidia-api-key", label: "NVIDIA API Key" },
  { key: "huggingface-token", label: "HuggingFace Token" },
  { key: "slack-webhook-url", label: "Slack Webhook URL" },
  { key: "console-auth-password", label: "Console Auth Password" },
  { key: "camera-sim-ssh-key", label: "Camera-sim SSH Key (PEM)" },
  { key: "aws-creds", label: "AWS Credentials", multiField: true },
];

const NAG_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

export default function SecretsPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const [statuses, setStatuses] = useState<SecretStatus[]>([]);
  const [rotateTarget, setRotateTarget] = useState<SecretStatus | null>(null);
  const { toast } = useToast();

  async function fetchStatuses() {
    const results = await Promise.all(
      SECRET_KEYS.map(async ({ key, label, multiField }) => {
        try {
          const res = await fetch(`/api/secrets/${key}`);
          const data = await res.json();
          return {
            key,
            label,
            configured: data.configured ?? false,
            ageMs: data.ageMs ?? null,
            multiField,
          };
        } catch {
          return { key, label, configured: false, ageMs: null, multiField };
        }
      })
    );
    setStatuses(results);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchStatuses(); }, []);

  async function handleRotate(values: Record<string, string>) {
    if (!rotateTarget) return;
    const res = await fetch(`/api/secrets/${rotateTarget.key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rotateTarget.multiField ? values : { value: values.value }),
    });
    if (!res.ok) {
      toast({
        title: "Rotation failed",
        description: await res.text(),
        variant: "destructive",
      });
      return;
    }
    toast({ title: `${rotateTarget.label} rotated successfully` });
    fetchStatuses();
  }

  const staleKeys = statuses
    .filter((s) => s.ageMs !== null && s.ageMs >= NAG_THRESHOLD_MS)
    .map((s) => s.label);

  return (
    <Shell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Secrets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rotate credentials. Values are never displayed — only status and age.
          </p>
        </div>

        <RotationNagBanner staleKeys={staleKeys} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rotatable secrets</CardTitle>
          </CardHeader>
          <CardContent className="px-4 py-0">
            {statuses.map((s) => (
              <SecretRow
                key={s.key}
                label={s.label}
                configured={s.configured}
                ageMs={s.ageMs}
                onRotate={() => setRotateTarget(s)}
              />
            ))}
          </CardContent>
        </Card>

        {rotateTarget && (
          <RotateSecretDialog
            open={rotateTarget !== null}
            secretKey={rotateTarget.key}
            secretLabel={rotateTarget.label}
            multiField={rotateTarget.multiField}
            onOpenChange={(o) => { if (!o) setRotateTarget(null); }}
            onConfirm={handleRotate}
          />
        )}
      </div>
    </Shell>
  );
}
