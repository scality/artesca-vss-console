/** Decide how a config-backed list page should render, distinguishing a failed
 *  config-store read (alert) from a genuinely empty list. Pure. */
export function classifyListState(
  warnings: string[] | undefined,
  itemCount: number,
): "error" | "empty" | "list" {
  if ((warnings ?? []).some((w) => /config store unavailable/i.test(w))) return "error";
  return itemCount === 0 ? "empty" : "list";
}
