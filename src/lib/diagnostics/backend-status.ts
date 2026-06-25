/** Pure, client-safe view helpers over a BackendStatus. No server imports. */
export type Severity = "ok" | "warn" | "error";

interface StatusLike {
  ok: boolean;
  severity?: Severity;
  detail: string;
}

export function severityOf(b: StatusLike): Severity {
  return b.severity ?? (b.ok ? "ok" : "error");
}

export function statusWord(b: StatusLike): string {
  const sev = severityOf(b);
  if (sev === "ok") return "ok";
  if (sev === "warn") return "degraded";
  const d = b.detail.toLowerCase();
  if (d.includes("not configured") || d.includes("unset")) return "not configured";
  if (d.includes("timed out") || d.includes("timeout")) return "timeout";
  return "unreachable";
}
