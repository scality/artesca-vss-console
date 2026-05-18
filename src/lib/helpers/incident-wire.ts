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
