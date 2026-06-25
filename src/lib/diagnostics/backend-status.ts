/** Short, color-independent status word so the state is legible as text. */
export function statusWord(b: { ok: boolean; detail: string }): string {
  if (b.ok) return "ok";
  const d = b.detail.toLowerCase();
  if (d.includes("not configured") || d.includes("unset")) return "not configured";
  if (d.includes("timed out") || d.includes("timeout")) return "timeout";
  return "unreachable";
}
