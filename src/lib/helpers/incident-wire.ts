/**
 * Transform an incident from the Python alert-worker's snake_case wire
 * format into the console's internal camelCase shape. Single source of
 * truth — used by /api/incidents (REST passthrough) and /api/incidents/live
 * (SSE re-broadcast). Unknown fields pass through unchanged.
 */
export function fromWire(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  const camel = (s: string): string =>
    s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Top-level only — don't recurse into `raw` (the nested original payload).
    out[camel(key)] = value;
  }
  return out;
}

/**
 * Map one realtime alert-bridge incident → the console's Incident shape.
 * The bridge emits {timestamp, category, type, isAnomaly, analyticsModule:{description},
 * info:{sensorId, streamId, reasoningDescription, triggerPhrase}}. `info.sensorId` is
 * the human camera name (e.g. "aisle-1"); `info.streamId` is the internal UUID — prefer
 * the name. Used by both /api/incidents (REST) and /api/incidents/live (SSE).
 */
export function fromAlertBridge(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const a = raw as Record<string, unknown>;
  const info = (a.info ?? {}) as Record<string, unknown>;
  const am = (a.analyticsModule ?? {}) as Record<string, unknown>;
  return {
    ts: a.timestamp ?? a.created_at ?? new Date().toISOString(),
    scenarioId: (a.category as string) ?? "alert",
    scenarioName: (am.description as string) ?? (a.category as string) ?? "Alert",
    severity: a.isAnomaly ? "high" : "medium",
    sensorId:
      (info.sensorId as string) ??
      (a.sensorId as string) ??
      (info.streamId as string) ??
      "",
    topic: (a.type as string) ?? "mdx-vlm-incidents",
    summary:
      (info.reasoningDescription as string) ??
      (info.reasoning as string) ??
      (info.triggerPhrase as string) ??
      "",
    raw: a,
  };
}

/** Stable key for an alert-bridge incident — used to dedup across SSE polls. */
export function alertBridgeIncidentKey(raw: unknown): string {
  const a = (raw ?? {}) as Record<string, unknown>;
  const info = (a.info ?? {}) as Record<string, unknown>;
  return String(
    a._id ??
      a.Id ??
      `${a.timestamp ?? ""}-${info.streamId ?? ""}-${info.chunkIdx ?? ""}`,
  );
}
