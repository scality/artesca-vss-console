import "server-only";
/**
 * artesca-reclamation.ts — is a delete actually returning space?
 *
 * A delete on ARTESCA frees space logically; the bytes come back to the pool
 * only after hyperdrive's relocation pass moves the surviving extents. Between
 * the two, "your delete worked, wait" and "reclamation is stuck" look the same
 * from S3, which is what cost hours on pyramid-showroom on 2026-09-10: 218,065
 * expiries had fired, the bucket still read full, and nothing said which of
 * the two it was. Hyperdrive's data servers export the answer to the
 * metalk8s-monitoring Prometheus this console already queries.
 *
 * Three signals, all cluster-wide (there is no per-bucket figure):
 *  - reclaimable bytes: freed logically, not yet returned. Falling = working.
 *  - the relocation queue: extents awaiting relocation, awaiting retry, and
 *    whether relocation is paused. A queue with paused=0 and a live sweeper
 *    is "wait"; paused=1 or a climbing retry count is "stuck".
 *  - the heartbeat: bytes reclaimed and sweeper passes over the last hour,
 *    which prove liveness when the queue reads 0 between passes.
 *
 * The reclaimable gauge is not in ARTESCA's documented external-integration
 * list, so an xcore bump can rename it without notice. An absent series is
 * rendered as unknown — never as zero, which would read as "nothing pending".
 */
import { promQuery } from "@/lib/helpers/prometheus";

export interface ArtescaReclamation {
  /** Bytes freed by deletes that a relocation pass has not yet returned. */
  reclaimableBytes: number | null;
  /** Extents queued for relocation. */
  awaitingRelocate: number | null;
  /** Relocations that failed and are queued for retry. */
  awaitingRetry: number | null;
  /** Relocation deliberately halted. */
  paused: boolean | null;
  /** Bytes physically reclaimed in the last hour. */
  reclaimedLastHourBytes: number | null;
  /** Sweeper passes in the last hour. */
  sweeperPassesLastHour: number | null;
  verdict: ReclamationVerdict;
}

export type ReclamationVerdict =
  | { state: "idle"; reason: string }
  | { state: "working"; reason: string }
  | { state: "stuck"; reason: string }
  | { state: "unknown"; reason: string };

const QUERIES = {
  reclaimableBytes: "sum(hyperdrive_http_bytes_reclaimable_free_space)",
  awaitingRelocate: "sum(hyperdrive_relocation_awaiting_relocate)",
  awaitingRetry: "sum(hyperdrive_relocation_awaiting_retry)",
  paused: "max(hyperdrive_relocation_paused)",
  reclaimedLastHourBytes: "sum(increase(hyperdrive_relocation_byte_reclaimed_total[1h]))",
  sweeperPassesLastHour: "sum(increase(hyperdrive_sweeper_pass_duration_milliseconds_count[1h]))",
} as const;

type Readings = { [K in keyof typeof QUERIES]: number | null };

/**
 * Pure: the verdict from the six readings. `null` anywhere that matters yields
 * "unknown" rather than a guess.
 */
export function classifyReclamation(r: Readings): ReclamationVerdict {
  if (r.reclaimableBytes === null) {
    return { state: "unknown", reason: "hyperdrive_http_bytes_reclaimable_free_space is not being scraped" };
  }
  if (r.paused === 1) {
    return { state: "stuck", reason: "relocation is paused — deletes will not return space until it is resumed" };
  }
  const queue = (r.awaitingRelocate ?? 0) + (r.awaitingRetry ?? 0);
  const heartbeat = (r.reclaimedLastHourBytes ?? 0) > 0 || (r.sweeperPassesLastHour ?? 0) > 0;
  if ((r.awaitingRetry ?? 0) > 0 && !heartbeat) {
    return { state: "stuck", reason: `${r.awaitingRetry} relocation(s) awaiting retry and no sweeper pass in the last hour` };
  }
  if (r.reclaimableBytes > 0 || queue > 0) {
    if (heartbeat) return { state: "working", reason: "relocation is passing and reclaiming; the pending figure should fall" };
    if (r.sweeperPassesLastHour === null && r.reclaimedLastHourBytes === null) {
      return { state: "unknown", reason: "space is pending but the heartbeat counters are not being scraped" };
    }
    return { state: "stuck", reason: "space is pending and no sweeper pass or reclaim landed in the last hour" };
  }
  return { state: "idle", reason: "nothing pending" };
}

function firstValue(results: { value: [number, string] }[]): number | null {
  if (!results.length) return null;
  const n = Number(results[0].value[1]);
  return Number.isFinite(n) ? n : null;
}

export async function readArtescaReclamation(): Promise<ArtescaReclamation> {
  const keys = Object.keys(QUERIES) as (keyof typeof QUERIES)[];
  const answers = await Promise.all(keys.map((k) => promQuery(QUERIES[k])));
  const r = Object.fromEntries(keys.map((k, i) => [k, firstValue(answers[i].results)])) as Readings;
  return {
    reclaimableBytes: r.reclaimableBytes,
    awaitingRelocate: r.awaitingRelocate,
    awaitingRetry: r.awaitingRetry,
    paused: r.paused === null ? null : r.paused === 1,
    reclaimedLastHourBytes: r.reclaimedLastHourBytes,
    sweeperPassesLastHour: r.sweeperPassesLastHour,
    verdict: classifyReclamation(r),
  };
}
