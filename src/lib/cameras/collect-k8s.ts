import type { CameraEntry, ReconcileStatus } from "@/lib/config-store/types";
import type { Camera, Feed } from "@/lib/types";

export interface K8sCamerasResponse {
  cameras: (Camera & { gcsPersisted?: boolean })[];
  reconcile: ReconcileStatus | null;
}

/** Assemble the cameras GET payload (k8s path) from the Firestore desired list
 *  + live runtime status. Pure — no I/O. `gcsPersisted` is named for response
 *  back-compat with the existing client schema; here it means "in Firestore". */
export function buildK8sCamerasResponse(
  desired: CameraEntry[],
  liveSensorNames: string[],
  mtxReady: Map<string, boolean>,
  status: ReconcileStatus | null,
  recordingByName?: Map<string, boolean | undefined>,
  ingestingNames?: Set<string>,
  recoveryByName?: Map<string, "recovering" | "degraded">,
): K8sCamerasResponse {
  const registered = new Set(liveSensorNames);
  const cameras = desired.map((c) => {
    const feed: Feed = {
      id: "default",
      sensorId: c.id,
      source: "rtsp",
      rtspUrl: c.rtspUrl,
      vstRegistered: registered.has(c.id),
      replayReady: mtxReady.get(c.id) ?? false,
      vstRecording: recordingByName?.get(c.id),
      vstIngesting: ingestingNames ? ingestingNames.has(c.id) : undefined,
      vstRecoveryState: recoveryByName?.get(c.id),
    };
    const cam: Camera & { gcsPersisted?: boolean } = {
      id: c.id,
      role: (c.role as Camera["role"]) ?? "other",
      description: c.description,
      feeds: [feed],
      gcsPersisted: true,
    };
    if (c.scenarioIds) cam.scenarioIds = c.scenarioIds;
    if (c.promptId) cam.promptId = c.promptId;
    if (c.recording) cam.recording = c.recording;
    return cam;
  });
  return { cameras, reconcile: status };
}
