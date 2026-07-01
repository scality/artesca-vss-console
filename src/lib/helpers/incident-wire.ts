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

// Chain-of-thought lead-in phrases stripped from the chosen sentence.
const LEAD_INS =
  /^(?:okay[^.]*\.\s*|so[,]?\s*|therefore[,]?\s*|thus[,]?\s*|in conclusion[,]?\s*|in summary[,]?\s*|to summari[sz]e[,]?\s*|putting (?:it all|this) together[,]?\s*|overall[,]?\s*|first[,]?\s*|finally[,]?\s*|ultimately[,]?\s*)/i;

// Meta / self-deliberation sentences that aren't a finding.
const META_SENTENCE =
  /^(?:i\b|i'?ll|i'?m|let me|let's|we need|the user|the task|the question|okay|so the task|looking at|to determine|to identify|to check|to assess|considering|now,|next,|then,|the key points?|the main focus|the description|the camera|the video (?:shows|is|appears|description))/i;

// Cue words that mark an actual conclusion / finding.
const CONCLUSION_CUE =
  /(?:main concern|primary issue|key issue|most likely|conclusion|indicat|suggest|appears? to|attempt(?:ing)? to|evidence of|consistent with|risk of|unsafe|hazard|theft|conceal|intrusion|restock|empty shelves|out of stock|this (?:is|behavior|behaviour|action|activity|scene))/i;

/** Extract a concise finding from the VLM's chain-of-thought reasoning:
 *  prefer the last substantive sentence that states a conclusion, skipping
 *  self-deliberation ("I should check…") and setup ("The video shows…"). */
function concludeFromReasoning(reasoning: string): string {
  const sentences = reasoning
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
  if (sentences.length === 0) return "";

  const substantive = sentences.filter((s) => !META_SENTENCE.test(s));
  const pool = substantive.length ? substantive : sentences;
  // Prefer the LAST sentence carrying a conclusion cue; else the last
  // substantive sentence.
  const cued = pool.filter((s) => CONCLUSION_CUE.test(s));
  let c = (cued.length ? cued[cued.length - 1] : pool[pool.length - 1]).trim();

  const marker = c.match(/(?:most likely conclusion is that|conclusion is that)\s+(.+)/i);
  if (marker) c = marker[1];

  let prev = "";
  while (c !== prev) {
    prev = c;
    c = c.replace(LEAD_INS, "");
  }
  c = c.trim();
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : "";
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
    const clean = concludeFromReasoning(reasoning);
    if (clean) return clean.slice(0, 500);
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
