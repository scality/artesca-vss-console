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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AddCidrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (cidr: string, label: string) => Promise<void>;
}

export function AddCidrDialog({ open, onOpenChange, onAdd }: AddCidrDialogProps) {
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const [fetchingIp, setFetchingIp] = useState(false);
  const [saving, setSaving] = useState(false);

  async function fetchMyIp() {
    setFetchingIp(true);
    try {
      const res = await fetch("https://api.ipify.org?format=json");
      const data = await res.json();
      setCidr(`${data.ip}/32`);
      if (!label) setLabel("My current IP");
    } catch {
      // ignore
    } finally {
      setFetchingIp(false);
    }
  }

  async function handleAdd() {
    if (!cidr.trim() || !label.trim()) return;
    setSaving(true);
    try {
      await onAdd(cidr.trim(), label.trim());
      setCidr("");
      setLabel("");
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add CIDR to SG allow-list</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label htmlFor="cidr-input">CIDR</Label>
            <div className="flex gap-2">
              <Input
                id="cidr-input"
                placeholder="203.0.113.0/29"
                value={cidr}
                onChange={(e) => setCidr(e.target.value)}
              />
              <Button variant="outline" onClick={fetchMyIp} disabled={fetchingIp} size="sm">
                {fetchingIp ? "…" : "My IP"}
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="label-input">Label</Label>
            <Input
              id="label-input"
              placeholder="Head office"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleAdd} disabled={!cidr.trim() || !label.trim() || saving}>
            {saving ? "Adding…" : "Add CIDR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
