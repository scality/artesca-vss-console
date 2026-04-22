"use client";

import { useRef, useState } from "react";
import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PodPicker } from "@/components/logs/PodPicker";
import { LogStream } from "@/components/logs/LogStream";
import { LogFilterBar } from "@/components/logs/LogFilterBar";

interface Selection {
  namespace: string;
  pod: string;
  container: string;
}

export default function LogsPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const [selection, setSelection] = useState<Selection | null>(null);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [tailN, setTailN] = useState(100);
  const linesRef = useRef<string[]>([]);

  function handleDownload() {
    const content = linesRef.current.slice(-tailN).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = selection
      ? `${selection.pod}-${selection.container}.log`
      : "console.log";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Shell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live log streaming from any pod container, plus the camera-sim journal.
          </p>
        </div>

        <Tabs defaultValue="pods">
          <TabsList>
            <TabsTrigger value="pods">Pod logs</TabsTrigger>
            <TabsTrigger value="camera-sim">Camera-sim journal</TabsTrigger>
          </TabsList>

          <TabsContent value="pods" className="space-y-4 mt-4">
            <PodPicker onSelect={setSelection} />

            <LogFilterBar
              filter={filter}
              onFilterChange={setFilter}
              paused={paused}
              onPauseToggle={() => setPaused((p) => !p)}
              tailN={tailN}
              onTailNChange={setTailN}
              onDownload={handleDownload}
              disabled={!selection}
            />

            {selection ? (
              <LogStream
                namespace={selection.namespace}
                pod={selection.pod}
                container={selection.container}
                filter={filter}
                paused={paused}
                tailN={tailN}
              />
            ) : (
              <div className="rounded-md border border-border bg-black/70 text-muted-foreground font-mono text-xs h-[520px] flex items-center justify-center">
                Select a pod to start streaming logs.
              </div>
            )}
          </TabsContent>

          <TabsContent value="camera-sim" className="space-y-4 mt-4">
            <LogFilterBar
              filter={filter}
              onFilterChange={setFilter}
              paused={paused}
              onPauseToggle={() => setPaused((p) => !p)}
              tailN={tailN}
              onTailNChange={setTailN}
              onDownload={handleDownload}
            />
            <CameraSimJournal filter={filter} paused={paused} tailN={tailN} />
          </TabsContent>
        </Tabs>
      </div>
    </Shell>
  );
}

// Inline component — same LogStream pattern but for camera-sim SSE
function CameraSimJournal({
  filter,
  paused,
  tailN,
}: {
  filter: string;
  paused: boolean;
  tailN: number;
}) {
  // Reuse LogStream with a synthetic selection pointing to /api/camera-sim/journal
  // Rendered as a simple scrollable SSE consumer
  return (
    <LogStream
      namespace="camera-sim"
      pod="journal"
      container="systemd"
      filter={filter}
      paused={paused}
      tailN={tailN}
    />
  );
}
