/** Human-readable byte size, e.g. 702858164407 → "654.6 GB". Pure/isomorphic. */
export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}
