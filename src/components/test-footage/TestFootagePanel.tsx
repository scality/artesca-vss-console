"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Play, Square, Trash2, Upload } from "lucide-react";

// Replay a local video file through the real pipeline so a VLM prompt and an
// alert scenario can be judged on actual frames. A run registers the file as a
// camera, so everything downstream — recording, captions, scenarios, incidents
// — behaves exactly as it does for a real one.

const FileSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  uploadedAt: z.string(),
});

const ProfileSchema = z.object({
  alertType: z.string(),
  prompt: z.string(),
  cameras: z.array(z.string()),
});

const ResponseSchema = z.object({
  files: z.array(FileSchema),
  runs: z.array(z.object({ cameraId: z.string(), streamId: z.string().optional() })),
  alertProfiles: z.array(ProfileSchema).default([]),
  pausedSensors: z.array(z.string()).default([]),
  maxUploadBytes: z.number(),
});

type Footage = z.infer<typeof FileSchema>;

/** Shown before the first API response lands; mirrors MAX_UPLOAD_BYTES. */
const MAX_UPLOAD_BYTES_FALLBACK = 2 * 1024 * 1024 * 1024;

function humanSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} kB`;
}

/** Camera id a file's run uses — mirrors footageCameraId() on the server. */
function cameraIdFor(name: string): string {
  return `test-${name.replace(/\.[^.]+$/, "")}`.slice(0, 32);
}

export function TestFootagePanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [mode, setMode] = React.useState<"loop" | "once">("loop");
  const [pauseLive, setPauseLive] = React.useState(true);
  /** "" = the generic default profile. */
  const [alertType, setAlertType] = React.useState("");
  const [uploadPct, setUploadPct] = React.useState<number | null>(null);
  // Live cameras the current run paused, echoed back so stopping can resume
  // exactly those and nothing else.
  const [paused, setPaused] = React.useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["test-footage"],
    queryFn: async () => {
      const res = await fetch("/api/test-footage");
      if (!res.ok) throw new Error("could not load test footage");
      return ResponseSchema.parse(await res.json());
    },
    refetchInterval: 10_000,
  });

  const running = new Set((data?.runs ?? []).map((r) => r.cameraId));
  const profiles = data?.alertProfiles ?? [];
  const selectedProfile = profiles.find((p) => p.alertType === alertType);
  // Cameras left paused with no run to explain it — an interrupted run.
  const orphanPaused = (data?.pausedSensors ?? []).filter((s) => !s.startsWith("test-"));
  const abandonedPause = orphanPaused.length > 0 && (data?.runs.length ?? 0) === 0;

  /** XHR rather than fetch: it reports upload progress, which matters for a
   *  file that can take a minute to transfer. */
  function upload(file: File) {
    setUploadPct(0);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/test-footage");
    xhr.setRequestHeader("x-footage-filename", file.name);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploadPct(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        toast({ title: `Uploaded ${file.name}` });
        queryClient.invalidateQueries({ queryKey: ["test-footage"] });
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          msg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? msg;
        } catch {
          /* non-JSON error body */
        }
        toast({ title: "Upload failed", description: msg, variant: "destructive" });
      }
    };
    xhr.onerror = () => {
      setUploadPct(null);
      toast({ title: "Upload failed", variant: "destructive" });
    };
    xhr.send(file);
  }

  const startRun = useMutation({
    mutationFn: async (fileName: string) => {
      const res = await fetch("/api/test-footage/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName,
          mode,
          pauseLive,
          ...(selectedProfile
            ? { alertType: selectedProfile.alertType, prompt: selectedProfile.prompt }
            : {}),
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        cameraId?: string;
        alertType?: string;
        pausedCameras?: string[];
        warnings?: string[];
      };
      if (!res.ok) throw new Error(body.error ?? "could not start the run");
      return body;
    },
    onSuccess: (body) => {
      setPaused(body.pausedCameras ?? []);
      queryClient.invalidateQueries({ queryKey: ["test-footage"] });
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      const paused = body.pausedCameras?.length
        ? `Paused ${body.pausedCameras.length} live camera(s) for the run.`
        : "Live cameras left running.";
      toast({
        title: `Running as ${body.cameraId} · ${body.alertType ?? "general-activity"}`,
        description: body.warnings?.length ? body.warnings.join("; ") : paused,
      });
    },
    onError: (err: Error) =>
      toast({ title: "Could not start", description: err.message, variant: "destructive" }),
  });

  const stopRun = useMutation({
    mutationFn: async (cameraId?: string) => {
      const res = await fetch("/api/test-footage/run", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraId, resume: paused }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "could not stop the run");
      }
      return (await res.json()) as { stopped: string[]; resumed: string[] };
    },
    onSuccess: (body) => {
      setPaused([]);
      queryClient.invalidateQueries({ queryKey: ["test-footage"] });
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({
        title: `Stopped ${body.stopped.join(", ") || "nothing"}`,
        description: body.resumed.length ? `Resumed ${body.resumed.join(", ")}.` : undefined,
      });
    },
    onError: (err: Error) =>
      toast({ title: "Could not stop", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/test-footage?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "delete failed");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["test-footage"] });
      toast({ title: "Deleted" });
    },
    onError: (err: Error) =>
      toast({ title: "Could not delete", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Test Footage</h2>
        <p className="text-sm text-muted-foreground">
          Replay a video file as a camera to test the VLM prompt and alert
          scenarios on real frames. The clip goes through the same path as a live
          camera — RTSP ingest, recording, VLM, scenarios — so incidents it
          raises are produced exactly as a real camera&apos;s would be.
        </p>
      </div>

      {/* An interrupted run leaves the live cameras paused with nothing running
          to explain it. Nothing else in the console shows this — the cameras
          just look quiet — so surface it here with the one-click repair. */}
      {abandonedPause && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
          <span>
            <strong>{orphanPaused.length} live camera(s) are paused</strong> with no test run to
            explain it — a run was interrupted before it could resume them. Nothing is being
            analysed on{" "}
            <span className="font-mono">{orphanPaused.join(", ")}</span>.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs ml-auto"
            onClick={() => stopRun.mutate(undefined)}
            disabled={stopRun.isPending}
          >
            Resume live cameras
          </Button>
        </div>
      )}

      {/* Upload */}
      <div className="rounded-md border border-border p-4 space-y-3">
        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,video/mp2t,video/x-matroska,video/quicktime,video/webm,.mp4,.ts,.mkv,.mov,.webm"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
          <Button
            onClick={() => inputRef.current?.click()}
            disabled={uploadPct !== null}
          >
            {uploadPct !== null ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            {uploadPct !== null ? `Uploading ${uploadPct}%` : "Upload video"}
          </Button>
          <span className="text-xs text-muted-foreground">
            mp4 · ts · mkv · mov · webm, up to{" "}
            {/* humanSize, not a raw divide: the limit is 2 GiB, which printed
                as "2.147483648 GB" in the byte count nobody wants to read. */}
            {humanSize(data?.maxUploadBytes ?? MAX_UPLOAD_BYTES_FALLBACK)}
          </span>
        </div>

        {/* Run options */}
        <div className="flex flex-wrap items-center gap-5 pt-1">
          <div className="flex items-center gap-2">
            <Label className="text-xs">Playback</Label>
            <div className="flex rounded border border-border overflow-hidden">
              {(["loop", "once"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-2 py-1 text-xs ${
                    mode === m ? "bg-brand-indigo text-white" : "text-muted-foreground"
                  }`}
                >
                  {m === "loop" ? "Loop" : "Play once"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-xs" htmlFor="tf-profile">
              Scenario
            </Label>
            <select
              id="tf-profile"
              value={alertType}
              onChange={(e) => setAlertType(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1 text-xs"
            >
              <option value="">general-activity (no scenario)</option>
              {profiles.map((p) => (
                <option key={p.alertType} value={p.alertType}>
                  {p.alertType}
                  {p.cameras.length ? ` — ${p.cameras.join(", ")}` : ""}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={pauseLive}
              onChange={(e) => setPauseLive(e.target.checked)}
            />
            Pause live cameras during the run
          </label>
        </div>

        <p className="text-xs text-muted-foreground">
          {selectedProfile ? (
            <>
              The VLM is given this camera prompt verbatim:{" "}
              <span className="italic">&ldquo;{selectedProfile.prompt}&rdquo;</span> — so the clip
              is judged exactly as {selectedProfile.cameras.join(", ") || "a live camera"} would
              judge it, and the scenario keywords match against the same captions.
            </>
          ) : (
            <>
              With no scenario chosen the VLM is asked only for &ldquo;anything notable&rdquo;.
              That confirms the pipeline runs, but it does not test a prompt or an alert rule —
              pick a scenario to do that.
            </>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {pauseLive
            ? "The live cameras stop being analysed while the clip runs, so the GPU is dedicated to it and results are repeatable. Their recording is unaffected, and they resume when you stop."
            : "The clip is analysed alongside the live cameras. No interruption, but VLM latency rises for everything and results vary run to run."}
        </p>
      </div>

      {/* Files */}
      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-6 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading footage…</span>
        </div>
      )}

      {data && data.files.length === 0 && (
        <p className="text-sm text-muted-foreground py-6 text-center">
          No footage uploaded yet.
        </p>
      )}

      {data && data.files.length > 0 && (
        <div className="rounded-md border border-border divide-y divide-border">
          {data.files.map((f: Footage) => {
            const isRunning = running.has(cameraIdFor(f.name));
            return (
              <div key={f.name} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="font-mono text-sm">{f.name}</span>
                <span className="text-xs text-muted-foreground">{humanSize(f.sizeBytes)}</span>
                {isRunning && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 bg-emerald-50 border-emerald-200 text-emerald-700"
                  >
                    ● RUNNING as {cameraIdFor(f.name)}
                  </Badge>
                )}
                <div className="ml-auto flex gap-1">
                  {isRunning ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => stopRun.mutate(cameraIdFor(f.name))}
                      disabled={stopRun.isPending}
                    >
                      <Square className="h-3 w-3 mr-1" />
                      Stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => startRun.mutate(f.name)}
                      disabled={startRun.isPending}
                    >
                      <Play className="h-3 w-3 mr-1" />
                      Run
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={() => remove.mutate(f.name)}
                    disabled={isRunning || remove.isPending}
                    title={isRunning ? "Stop the run before deleting" : "Delete this file"}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Abandoned-run cleanup: a run survives a page reload, so offer a way to
          clear one whose paused-camera list this session no longer knows. */}
      {data && data.runs.length > 0 && (
        <div className="flex items-center gap-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs">
          <span>
            {data.runs.length} test camera(s) registered:{" "}
            <span className="font-mono">
              {data.runs.map((r) => r.cameraId).join(", ")}
            </span>
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs ml-auto"
            onClick={() => stopRun.mutate(undefined)}
            disabled={stopRun.isPending}
          >
            Stop all
          </Button>
        </div>
      )}
    </div>
  );
}
