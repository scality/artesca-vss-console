/**
 * The bound on a full-bucket scan, and the states a bucket total can be in.
 *
 * Kept free of imports so client components can label a total with the same
 * figures the server scanned with — a label that names a different cap from the
 * one applied is how the diagnostics panel came to say "5000" after the scan it
 * described had changed.
 *
 * S3 has no O(1) object count, so a total is a paginated `ListObjectsV2` walk.
 * The walk is bounded so a runaway bucket cannot pin a background scan forever;
 * the bound is well above the largest recordings bucket measured on a lab
 * (395k objects), and a total that hits it is reported as a floor, never as a
 * count.
 */

/** Keys requested per `ListObjectsV2` page. The server may return fewer. */
export const BUCKET_SCAN_PAGE_SIZE = 1000;

/** Pages a full-bucket scan walks before it stops and reports `truncated`. */
export const BUCKET_SCAN_PAGE_LIMIT = 1000;

/** The most objects a full-bucket scan can count before it stops. */
export const BUCKET_SCAN_OBJECT_CAP = BUCKET_SCAN_PAGE_SIZE * BUCKET_SCAN_PAGE_LIMIT;

/**
 * What a bucket total shown on a page means.
 *
 * - `complete`    — the scan reached the end of the bucket; the figures are exact
 *                   as of the scan.
 * - `truncated`   — the scan stopped at BUCKET_SCAN_OBJECT_CAP; the figures are a floor.
 * - `pending`     — no scan has finished yet; the figures are not known (render
 *                   "counting", not 0).
 * - `unavailable` — the bucket could not be listed; the figures are not known.
 */
export type BucketTotalsState = "complete" | "truncated" | "pending" | "unavailable";

export const BUCKET_TOTALS_STATES = ["complete", "truncated", "pending", "unavailable"] as const;

export function bucketTotalsState(
  stats: { truncated?: boolean } | null,
  refreshing: boolean,
): BucketTotalsState {
  if (stats) return stats.truncated ? "truncated" : "complete";
  return refreshing ? "pending" : "unavailable";
}

/** True when the state carries figures worth showing (exact or a floor). */
export function hasBucketTotals(state: BucketTotalsState | undefined): boolean {
  return state === undefined || state === "complete" || state === "truncated";
}

/** "≥ " in front of a figure that is a floor, "" otherwise. */
export function floorPrefix(state: BucketTotalsState | undefined): string {
  return state === "truncated" ? "≥ " : "";
}

/** One-line operator-facing note for a truncated total. */
export const BUCKET_SCAN_TRUNCATED_NOTE =
  `the scan stopped at ${BUCKET_SCAN_OBJECT_CAP.toLocaleString("en-US")} objects, so the count and size are floors`;
