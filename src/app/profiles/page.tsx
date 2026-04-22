"use client";

import { useEffect, useRef, useState } from "react";
import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { ProfileTable } from "@/components/profiles/ProfileTable";
import { SaveProfileDialog } from "@/components/profiles/SaveProfileDialog";
import { LoadProfileDialog } from "@/components/profiles/LoadProfileDialog";
import { useToast } from "@/hooks/use-toast";
import type { DemoProfile } from "@/lib/types";

interface ProfileMeta {
  name: string;
  savedAt: string;
  savedBy: string;
  numScenarios: number;
  numCameras: number;
  nimModel: string;
}

export default function ProfilesPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [activeProfile, setActiveProfile] = useState<string | undefined>();
  const [saveOpen, setSaveOpen] = useState(false);
  const [loadTarget, setLoadTarget] = useState<DemoProfile | null>(null);
  const [importError, setImportError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  async function fetchProfiles() {
    const res = await fetch("/api/profiles");
    if (!res.ok) return;
    const data = await res.json();
    setProfiles(data.profiles ?? []);
    setActiveProfile(data.activeProfile);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchProfiles(); }, []);

  async function handleSave(name: string, _description: string) {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      toast({ title: "Save failed", description: await res.text(), variant: "destructive" });
      return;
    }
    toast({ title: `Profile "${name}" saved` });
    fetchProfiles();
  }

  async function handleLoadConfirm() {
    if (!loadTarget) return;
    const res = await fetch(`/api/profiles/${encodeURIComponent(loadTarget.name)}`, {
      method: "PUT",
    });
    if (!res.ok) {
      toast({ title: "Load failed", description: await res.text(), variant: "destructive" });
      return;
    }
    toast({ title: `Profile "${loadTarget.name}" loaded` });
    setActiveProfile(loadTarget.name);
    fetchProfiles();
  }

  async function openLoad(name: string) {
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`);
    if (!res.ok) {
      toast({ title: "Failed to fetch profile", variant: "destructive" });
      return;
    }
    const profile: DemoProfile = await res.json();
    setLoadTarget(profile);
  }

  async function handleDuplicate(name: string) {
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const profile: DemoProfile = await res.json();
    const newName = `${name}-copy`;
    await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...profile, name: newName }),
    });
    toast({ title: `Duplicated as "${newName}"` });
    fetchProfiles();
  }

  async function handleExport(name: string) {
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const profile = await res.json();
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete profile "${name}"?`)) return;
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) {
      toast({ title: "Delete failed", variant: "destructive" });
      return;
    }
    toast({ title: `Profile "${name}" deleted` });
    fetchProfiles();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      toast({ title: `Profile "${payload.name}" imported` });
      fetchProfiles();
    } catch (err) {
      setImportError(String(err));
      toast({ title: "Import failed", description: String(err), variant: "destructive" });
    }
    e.target.value = "";
  }

  return (
    <Shell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Profiles</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Save and load named demo configurations (scenarios + prompt + cameras + tuning + model).
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="file"
              accept=".json"
              ref={fileInputRef}
              onChange={handleImportFile}
              className="hidden"
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              Import JSON
            </Button>
            <Button onClick={() => setSaveOpen(true)}>Save current config</Button>
          </div>
        </div>

        <ProfileTable
          profiles={profiles}
          activeProfile={activeProfile}
          onLoad={openLoad}
          onDuplicate={handleDuplicate}
          onExport={handleExport}
          onDelete={handleDelete}
        />

        <SaveProfileDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          onSave={handleSave}
        />

        <LoadProfileDialog
          open={loadTarget !== null}
          profile={loadTarget}
          onOpenChange={(o) => { if (!o) setLoadTarget(null); }}
          onConfirm={handleLoadConfirm}
        />
      </div>
    </Shell>
  );
}
