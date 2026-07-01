import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { vstListSensors } from "@/lib/helpers/vst";
import { probeRecording } from "@/lib/helpers/recording-health";

export const dynamic = "force-dynamic";

// Per-camera recording health, ground-truthed against VST storage (not the
// stale isTimelinePresent flag). Used by the UI, external monitors, and the
// post-deploy canary in validate-console.sh. `ok` is false when any online
// camera is not recording — the signal that would have caught this class of
// "registered but not recording" regression before a demo.
export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sensors, warning } = await vstListSensors();
  const online = sensors.filter((s) => s.status === "online" && s.name);

  const cameras = await Promise.all(
    online.map(async (s) => {
      const streamId = String((s as { streamId?: unknown }).streamId ?? "");
      const status = await probeRecording(streamId);
      return { name: s.name as string, streamId, status };
    }),
  );

  const notRecording = cameras.filter((c) => c.status === "not-recording").map((c) => c.name);
  const unknown = cameras.filter((c) => c.status === "unknown").map((c) => c.name);
  const recording = cameras.filter((c) => c.status === "recording").length;

  return NextResponse.json({
    ok: notRecording.length === 0 && cameras.length > 0,
    takenAt: new Date().toISOString(),
    total: cameras.length,
    recording,
    notRecording,
    unknown,
    cameras,
    ...(warning ? { warning } : {}),
  });
}
