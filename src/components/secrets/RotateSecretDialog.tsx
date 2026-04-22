"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface RotateSecretDialogProps {
  open: boolean;
  secretKey: string;
  secretLabel: string;
  multiField?: boolean; // AWS has multiple fields
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: Record<string, string>) => Promise<void>;
}

const AWS_FIELDS = [
  { key: "accessKeyId", label: "AWS Access Key ID", placeholder: "AKIA…" },
  { key: "secretAccessKey", label: "AWS Secret Access Key", placeholder: "…", secret: true },
  { key: "sessionToken", label: "Session Token (optional)", placeholder: "Leave blank if not using STS", optional: true },
  { key: "securityGroupId", label: "Security Group ID", placeholder: "sg-…", optional: true },
];

export function RotateSecretDialog({
  open,
  secretKey,
  secretLabel,
  multiField,
  onOpenChange,
  onConfirm,
}: RotateSecretDialogProps) {
  const [value, setValue] = useState("");
  const [awsValues, setAwsValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    setSaving(true);
    try {
      const values = multiField ? awsValues : { value };
      await onConfirm(values);
      setValue("");
      setAwsValues({});
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  const isValid = multiField
    ? Boolean(awsValues.accessKeyId?.trim() && awsValues.secretAccessKey?.trim())
    : Boolean(value.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Rotate: {secretLabel}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            Paste the new value below. The current value is never shown.
          </p>

          {multiField ? (
            <div className="space-y-3">
              {AWS_FIELDS.map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={`aws-${field.key}`}>
                    {field.label}
                    {field.optional && <span className="ml-1 text-muted-foreground">(optional)</span>}
                  </Label>
                  <textarea
                    id={`aws-${field.key}`}
                    rows={field.secret ? 3 : 1}
                    placeholder={field.placeholder}
                    value={awsValues[field.key] ?? ""}
                    onChange={(e) => setAwsValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="secret-value">New value</Label>
              <textarea
                id="secret-value"
                rows={5}
                placeholder="Paste new secret here…"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!isValid || saving} variant="destructive">
            {saving ? "Rotating…" : "Confirm rotation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
