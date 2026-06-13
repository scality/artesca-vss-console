import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import type { CameraEntry, PromptSet } from "@/lib/config-store/types";

export interface RealtimeRefs {
  liveStreamUrlFor: (cam: CameraEntry) => string;
}

export interface RealtimeReconcileResult {
  applied: number;
  removed: number;
  errors: string[];
  skipped?: string;
}

/**
 * Converge realtime alert rules against the alert-bridge, driven by
 * per-camera prompt-set bindings. Idempotent. Never throws.
 *
 * Design constraints:
 * - Keyed by `live_stream_url` (NOT sensor_id) — upsert-style to coexist with
 *   the vlm-stream-reconciler keep-alive that may already hold ad-hoc rules.
 * - Only manages streams belonging to a console camera. Never deletes a rule
 *   whose stream is not in the console camera list (unmanaged streams are left
 *   alone).
 * - Change-driven: only POST/DELETE when the live rule differs from desired;
 *   steady-state = no-op.
 */
export async function reconcileRealtime(
  cameras: CameraEntry[],
  promptSets: PromptSet[],
  adapter: ClusterAdapter,
  refs: RealtimeRefs,
): Promise<RealtimeReconcileResult> {
  if (
    !adapter.listRealtimeRules ||
    !adapter.addRealtimeRule ||
    !adapter.deleteRealtimeRule
  ) {
    return { applied: 0, removed: 0, errors: [], skipped: "adapter cannot drive realtime" };
  }

  const errors: string[] = [];
  let applied = 0;
  let removed = 0;

  const setById = new Map(promptSets.map((s) => [s.id, s]));

  // Compute the full set of managed stream URLs (all console cameras).
  const managedStreams = new Set(cameras.map((c) => refs.liveStreamUrlFor(c)));

  // Build the desired map: streamUrl → desired rule config (only cameras with a binding).
  interface DesiredEntry {
    streamUrl: string;
    alertType: string;
    prompt: string;
    sensorName: string;
    model?: string;
  }
  const desired = new Map<string, DesiredEntry>();

  for (const cam of cameras) {
    if (!cam.promptId) continue;
    const set = setById.get(cam.promptId);
    if (!set) {
      errors.push(`camera ${cam.id}: prompt-set ${cam.promptId} not found`);
      continue;
    }
    const streamUrl = refs.liveStreamUrlFor(cam);
    desired.set(streamUrl, {
      streamUrl,
      alertType: set.alertType ?? set.name,
      prompt: set.text,
      sensorName: cam.id,
      model: set.model,
    });
  }

  // Fetch current rules and index by stream URL.
  let current: { id: string; liveStreamUrl: string; alertType: string; prompt?: string }[];
  try {
    current = await adapter.listRealtimeRules();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { applied, removed, errors };
  }

  const byStream = new Map(current.map((r) => [r.liveStreamUrl, r]));

  // Upsert desired rules.
  for (const [streamUrl, d] of desired) {
    const cur = byStream.get(streamUrl);
    try {
      if (!cur) {
        // New binding — add.
        const res = await adapter.addRealtimeRule(d);
        if (res.ok) {
          applied++;
        } else {
          errors.push(`camera ${d.sensorName}: add failed: ${res.warning ?? "unknown"}`);
        }
      } else if (cur.alertType !== d.alertType || cur.prompt !== d.prompt) {
        // Changed — replace: delete existing then add new.
        const delRes = await adapter.deleteRealtimeRule(cur.id);
        if (!delRes.ok) {
          errors.push(`camera ${d.sensorName}: delete-before-replace failed: ${delRes.warning ?? "unknown"}`);
          continue;
        }
        const addRes = await adapter.addRealtimeRule(d);
        if (addRes.ok) {
          applied++;
        } else {
          errors.push(`camera ${d.sensorName}: add-after-replace failed: ${addRes.warning ?? "unknown"}`);
        }
      }
      // If cur exists and matches — no-op.
    } catch (err) {
      errors.push(`camera ${d.sensorName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Remove rules for managed streams that are no longer bound.
  for (const cur of current) {
    if (!managedStreams.has(cur.liveStreamUrl)) continue; // unmanaged — leave alone
    if (desired.has(cur.liveStreamUrl)) continue; // still desired — already handled above
    try {
      const res = await adapter.deleteRealtimeRule(cur.id);
      if (res.ok) {
        removed++;
      } else {
        errors.push(`remove rule ${cur.id}: ${res.warning ?? "unknown"}`);
      }
    } catch (err) {
      errors.push(`remove rule ${cur.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { applied, removed, errors };
}
