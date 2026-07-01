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
/**
 * Severity per alert category. The realtime-rule incidents carry an
 * alert_type/category but no severity; map the known showroom categories to a
 * meaningful tier instead of flagging every anomaly "high". Unknown categories
 * fall back to isAnomaly (high) / medium so new scenarios still surface.
 */
const CATEGORY_SEVERITY: Record<string, "high" | "medium" | "low"> = {
  "self-checkout-theft": "high",
  "forklift-safety": "high",
  intrusion: "high",
  "shelf-restock": "low",
};

function severityForCategory(category: unknown, isAnomaly: unknown): "high" | "medium" | "low" {
  const c = typeof category === "string" ? category : "";
  return CATEGORY_SEVERITY[c] ?? (isAnomaly ? "high" : "medium");
}

// Friendly per-scenario names. The incident's `category` IS the matched
// scenario id — deriving the name from it gives each alert its real scenario
// name instead of the analyticsModule's single generic detector description.
const CATEGORY_NAME: Record<string, string> = {
  "self-checkout-theft": "Self-checkout theft",
  "forklift-safety": "Forklift safety",
  intrusion: "Intrusion / after-hours",
  "shelf-restock": "Shelf restocking",
};

function scenarioNameForCategory(category: unknown): string {
  const c = typeof category === "string" ? category : "";
  if (CATEGORY_NAME[c]) return CATEGORY_NAME[c];
  if (!c) return "Alert";
  // Prettify an unknown category: "some-new-thing" → "Some new thing".
  const pretty = c.replace(/[-_]/g, " ").trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

// The VLM emits chain-of-thought reasoning ("Okay, let's break this down…").
// Extract the concluding statement — the actual "what triggered this" — instead
// of surfacing the whole thinking trace. Falls back to the terse verdict fields.
function cleanTrigger(info: Record<string, unknown>): string {
  const reasoning =
    (typeof info.reasoningDescription === "string" && info.reasoningDescription) ||
    (typeof info.reasoning === "string" && info.reasoning) ||
    "";
  if (reasoning.trim()) {
    const paras = reasoning
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    let c = paras.length ? paras[paras.length - 1] : reasoning.trim();
    // Drop chain-of-thought lead-ins.
    c = c.replace(
      /^(?:okay,[^.]*\.\s*|so,\s*|therefore,\s*|in conclusion,\s*|putting this together,?\s*)+/i,
      "",
    );
    // Pull the clause after a conclusion marker when present.
    const m = c.match(/(?:most likely conclusion is that|conclusion is that|the person is|it (?:is|appears))\s+(.*)/i);
    if (m) c = (m[0].toLowerCase().startsWith("the person") || m[0].toLowerCase().startsWith("it ") ? m[0] : m[1]);
    c = c.trim();
    if (c) return (c.charAt(0).toUpperCase() + c.slice(1)).slice(0, 500);
  }
  const verdict = typeof info.verdict === "string" ? info.verdict : "";
  const trigger = typeof info.triggerPhrase === "string" ? info.triggerPhrase : "";
  if (verdict || trigger) return [verdict, trigger].filter(Boolean).join(" — ").slice(0, 500);
  return "";
}

export function fromAlertBridge(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const a = raw as Record<string, unknown>;
  const info = (a.info ?? {}) as Record<string, unknown>;
  return {
    ts: a.timestamp ?? a.created_at ?? new Date().toISOString(),
    scenarioId: (a.category as string) ?? "alert",
    scenarioName: scenarioNameForCategory(a.category),
    severity: severityForCategory(a.category, a.isAnomaly),
    sensorId:
      (info.sensorId as string) ??
      (a.sensorId as string) ??
      (info.streamId as string) ??
      "",
    topic: (a.type as string) ?? "mdx-vlm-incidents",
    summary: cleanTrigger(info),
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
