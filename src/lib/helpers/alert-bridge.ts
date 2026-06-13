import "server-only";
import { CLUSTER } from "../cluster-refs";
import { createLogger } from "@/lib/logger";

const log = createLogger("alert-bridge");

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RealtimeRule {
  id: string;
  live_stream_url: string;
  alert_type: string;
  prompt?: string;
  sensor_id?: string;
  sensor_name?: string;
}

// ─── listRealtimeRules ────────────────────────────────────────────────────────

/** List all realtime alert rules from the alert-bridge.
 *  Fail-soft: returns an empty array + warning string on any error; never throws. */
export async function listRealtimeRules(): Promise<{
  rules: RealtimeRule[];
  warning?: string;
}> {
  const url = CLUSTER.alertBridge.realtimeUrl;
  try {
    const resp = await fetch(url, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return {
        rules: [],
        warning: `alert-bridge returned HTTP ${resp.status} on GET ${url}`,
      };
    }

    const json = await resp.json();
    const rules: RealtimeRule[] = (json as { rules?: RealtimeRule[] }).rules ?? [];
    return { rules };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("unreachable", { err });
    return { rules: [], warning: `alert-bridge unreachable: ${msg}` };
  }
}

// ─── addRealtimeRule ──────────────────────────────────────────────────────────

/** Create a realtime alert rule. 409 is treated as success (idempotent).
 *  Returns the created rule's id on success.
 *  Fail-soft: returns ok:false + warning on any other error; never throws. */
export async function addRealtimeRule(input: {
  streamUrl: string;
  alertType: string;
  prompt: string;
  sensorName?: string;
  systemPrompt?: string;
  model?: string;
}): Promise<{ ok: boolean; id?: string; warning?: string }> {
  const url = CLUSTER.alertBridge.realtimeUrl;

  const body: Record<string, string> = {
    live_stream_url: input.streamUrl,
    alert_type: input.alertType,
    prompt: input.prompt,
  };
  if (input.sensorName !== undefined) body.sensor_name = input.sensorName;
  if (input.systemPrompt !== undefined) body.system_prompt = input.systemPrompt;
  if (input.model !== undefined) body.model = input.model;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });

    // 409 = already exists — treat as success (idempotent).
    if (resp.status === 409) return { ok: true };

    if (!resp.ok) {
      return {
        ok: false,
        warning: `alert-bridge returned HTTP ${resp.status} on POST`,
      };
    }

    const json = await resp.json();
    // The response shape is { status, rule: { id, ... } } but fall back to
    // a top-level id field in case the implementation differs.
    const id: string | undefined =
      (json as { rule?: { id?: string } }).rule?.id ??
      (json as { id?: string }).id;
    return { ok: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `alert-bridge add failed: ${msg}` };
  }
}

// ─── deleteRealtimeRule ───────────────────────────────────────────────────────

/** Delete a realtime alert rule by id. 404 is treated as success (idempotent).
 *  Fail-soft: returns ok:false + warning on any other error; never throws. */
export async function deleteRealtimeRule(
  id: string
): Promise<{ ok: boolean; warning?: string }> {
  const url = `${CLUSTER.alertBridge.realtimeUrl}/${encodeURIComponent(id)}`;
  try {
    const resp = await fetch(url, {
      method: "DELETE",
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(10_000),
    });

    // 404 = already gone — treat as success (idempotent).
    if (resp.status === 404) return { ok: true };

    if (!resp.ok) {
      return {
        ok: false,
        warning: `alert-bridge returned HTTP ${resp.status} on DELETE`,
      };
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `alert-bridge delete failed: ${msg}` };
  }
}
