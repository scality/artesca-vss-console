/**
 * redact.ts — the one definition of "this value looks like a credential".
 *
 * Pure, and imported by both consumers rather than copied into either:
 *   - [`error-bridge.ts`](./error-bridge.ts) redacts before a Sentry capture.
 *   - [`logger.ts`](./logger.ts) redacts before anything reaches stdout.
 *
 * It lives here because those two cannot share it any other way: `error-bridge`
 * imports `createLogger`, so the logger importing from `error-bridge` is a
 * cycle — and `error-bridge` additionally pulls in the Sentry SDK and kafkajs,
 * which the logger is imported by nearly every module to avoid.
 *
 * A second copy is the failure mode worth naming: a denylist that exists twice
 * gets extended once, and the half that was not extended is the half that
 * writes the credential to a log.
 */

/** Longest string kept in a redacted payload before truncation. */
export const MAX_CONTEXT_STRING_LEN = 2000;

/**
 * Keys (or key fragments) that indicate a value likely holds a credential.
 * Matched case-insensitively against object keys during redaction.
 *
 * Note `key` matches on its own, which is deliberate — `apiKey`, `accessKey`,
 * `ngcKey` and a bare `key` holding a secret are all more likely than a benign
 * field whose name contains those three letters. No logger call site or Sentry
 * context in this repository is affected by it.
 */
export const SECRET_KEY_PATTERN =
  /(key|token|secret|password|passwd|pwd|authorization|auth[-_]?header|credential|private[-_]?key|pem|bearer)/i;

/**
 * Heuristic for a bare string that looks like a credential value.
 *
 * ⚠ Anchored at the start, so it catches a value that *is* a credential and not
 * one that merely contains one. Widening it to match mid-string would also
 * match prose that quotes a token, so the key denylist above is the primary
 * defence and this is the backstop for a value under an innocuous key.
 */
export const SECRET_VALUE_PATTERN =
  /^(sk-|ghp_|glpat-|AKIA|Bearer\s|Basic\s|eyJ[a-zA-Z0-9_-]{10,})/;

export function truncate(s: string, max = MAX_CONTEXT_STRING_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

/**
 * Recursively redacts anything that looks like a secret from a JSON-ish value,
 * then caps string lengths. Returns a plain object/array/primitive safe to
 * attach as Sentry extra context or to serialize into a log line.
 * Depth-limited and size-limited so a pathological payload can't blow up
 * processing or the outbound event.
 */
export function redactAndCap(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[max depth]";

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERN.test(value)) return "[redacted]";
    return truncate(value);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactAndCap(v, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 50) {
        out["…"] = "[truncated: too many keys]";
        break;
      }
      count++;
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redactAndCap(v, depth + 1);
    }
    return out;
  }

  return String(value);
}
