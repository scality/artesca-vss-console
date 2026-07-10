import "server-only";
import { randomUUID } from "node:crypto";
import { CLUSTER } from "@/lib/cluster-refs";
import { s3Stats } from "@/lib/aws";

/**
 * kvcache.ts — Phase C live backend for the /kvcache page (ISVD-331).
 *
 * Two entry points, both fail-soft (never throw to the caller):
 *
 *   collectKvcacheSnapshot() — cheap, polled every ~5s by the page. Probes
 *     the vLLM+LMCache `/health` endpoint and lists the ARTESCA S3 KV-cache
 *     bucket (the same S3 client aws.ts/s3.ts already use for the
 *     objectstore-creds Secret) for a live object/byte counter.
 *
 *   runKvRace() — expensive (~10-30s), fired on demand by "Run the race".
 *     Sends the SAME uniquely-nonced, long-shared-prefix prompt twice through
 *     the real vLLM /v1/completions endpoint — once cold (a fresh nonce means
 *     this exact prefix has never been seen, so it's a guaranteed KV miss),
 *     once warm after a pause long enough for LMCache to finish asynchronously
 *     offloading the KV blocks it just computed to ARTESCA S3 (a guaranteed
 *     KV hit) — and measures real wall-clock time-to-first-token for both.
 *
 * `available: false` / `ok: false` is the expected, ordinary outcome whenever
 * the kvcache-demo namespace isn't deployed on the current cluster — the
 * /kvcache page falls back to its mock telemetry in that case, so a failure
 * here is not exceptional and must never throw up to the route handler.
 */

const HEALTH_TIMEOUT_MS = 2_000;
const SNAPSHOT_CACHE_MS = 30_000;

const WARMUP_TIMEOUT_MS = 10_000;
const COMPLETION_TIMEOUT_MS = 45_000;
const WARM_PAUSE_MS = 5_000;
const RACE_MAX_TOKENS = 48;

// A short prompt that shares NONE of the demo's long prefix — just proves the
// endpoint is actually serving before the timed race starts.
const WARMUP_PROMPT = "Reply with a single word: ready.";

const DEMO_QUESTION = "What's your return policy on opened electronics?";
const STORE_POLICY_PARAGRAPH =
  "Store policy on returns: opened electronics may be returned within 15 days " +
  "with a receipt for a full refund; after 15 days, store credit only. Extended " +
  "holiday returns run through January 31. Defective items are covered by the " +
  "manufacturer warranty and can be exchanged at any time within the warranty " +
  "period, no receipt required if the purchase can be verified via loyalty " +
  "account. Restocking fees of up to 15 percent may apply to opened but " +
  "resellable non-electronics items at the manager's discretion. Staff must " +
  "verify photo ID before issuing any refund over two hundred dollars, and " +
  "must log the transaction in the daily returns ledger before end of shift. ";
// ~90 words/repeat * 45 ≈ 4,000 words ≈ a few thousand tokens — long enough that
// a real KV-cache hit vs miss is a measurable difference even on a 1.5B model.
const PREFIX_REPEATS = 45;

/** A nonce prefix guarantees the shared prompt has never been tokenized before,
 *  so the COLD call below is a real KV miss, not an accidental hit off a prior run. */
function buildRacePrompt(nonce: string): string {
  return (
    `Reference session: ${nonce}\n\n` +
    STORE_POLICY_PARAGRAPH.repeat(PREFIX_REPEATS) +
    `\n\nQuestion: ${DEMO_QUESTION}\nAnswer:`
  );
}

async function probeVllmHealth(timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const resp = await fetch(`${CLUSTER.kvcache.vllmUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return resp.ok;
  } catch {
    return false;
  }
}

interface CompletionTiming {
  ttftMs: number;
  totalMs: number;
}

/**
 * Fires a streaming POST /v1/completions against the OpenAI-compatible vLLM
 * endpoint and measures wall-clock time to the first streamed chunk (TTFT)
 * plus total request time. The SSE payload itself doesn't need parsing —
 * draining the stream is enough to time it accurately.
 */
async function streamCompletion(
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<CompletionTiming> {
  const start = performance.now();
  const resp = await fetch(`${CLUSTER.kvcache.vllmUrl}/v1/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: CLUSTER.kvcache.model,
      prompt,
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`vLLM HTTP ${resp.status}: ${text.slice(0, 300) || "(empty body)"}`);
  }

  const reader = resp.body.getReader();
  let ttftMs: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttftMs === null && value && value.length > 0) {
      ttftMs = performance.now() - start;
    }
  }
  const totalMs = performance.now() - start;
  return { ttftMs: ttftMs ?? totalMs, totalMs };
}

/** Best-effort object count of the KV-cache bucket. Fail-soft to 0 — never throws. */
async function countBucketObjects(): Promise<number> {
  try {
    const stats = await s3Stats(CLUSTER.kvcache.bucket);
    return stats.objectCount;
  } catch {
    return 0;
  }
}

// ─── Snapshot (cheap, polled every ~5s by the page) ────────────────────────

export interface KvcacheBucketStats {
  name: string;
  objects: number;
  bytes: number;
}

export interface KvcacheSnapshot {
  available: boolean;
  model: string;
  endpoint: string;
  bucket: KvcacheBucketStats;
  warnings: string[];
  ts: string;
}

let snapshotCache: { ts: number; snapshot: KvcacheSnapshot } | null = null;

export async function collectKvcacheSnapshot(): Promise<KvcacheSnapshot> {
  if (snapshotCache && Date.now() - snapshotCache.ts < SNAPSHOT_CACHE_MS) {
    return snapshotCache.snapshot;
  }

  const warnings: string[] = [];
  const available = await probeVllmHealth();

  let objects = 0;
  let bytes = 0;
  try {
    const stats = await s3Stats(CLUSTER.kvcache.bucket);
    objects = stats.objectCount;
    bytes = stats.bytesTotal;
    if (stats.truncated) warnings.push("bucket listing truncated at the page cap");
  } catch (e) {
    warnings.push(
      `could not list bucket ${CLUSTER.kvcache.bucket}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const snapshot: KvcacheSnapshot = {
    available,
    model: CLUSTER.kvcache.model,
    endpoint: CLUSTER.kvcache.vllmUrl,
    bucket: { name: CLUSTER.kvcache.bucket, objects, bytes },
    warnings,
    ts: new Date().toISOString(),
  };
  snapshotCache = { ts: Date.now(), snapshot };
  return snapshot;
}

// ─── Race (expensive, on-demand via "Run the race") ────────────────────────

export type KvRaceResult =
  | {
      ok: true;
      model: string;
      cold: CompletionTiming;
      warm: CompletionTiming;
      speedup: number;
      bucketObjectsBefore: number;
      bucketObjectsAfter: number;
    }
  | { ok: false; error: string };

export async function runKvRace(): Promise<KvRaceResult> {
  try {
    const healthy = await probeVllmHealth();
    if (!healthy) {
      return {
        ok: false,
        error: `vLLM+LMCache backend not reachable at ${CLUSTER.kvcache.vllmUrl}/health`,
      };
    }

    // 1. Short, unrelated warmup — proves the endpoint is actually serving
    //    before we start timing the real race; not part of the shared prefix.
    await streamCompletion(WARMUP_PROMPT, 4, WARMUP_TIMEOUT_MS);

    const bucketObjectsBefore = await countBucketObjects();

    // 2. COLD — a fresh nonce guarantees this exact prefix has never been
    //    seen before, so vLLM/LMCache cannot have it cached: a guaranteed miss.
    const nonce = randomUUID();
    const prompt = buildRacePrompt(nonce);
    const cold = await streamCompletion(prompt, RACE_MAX_TOKENS, COMPLETION_TIMEOUT_MS);

    // 3. Pause so LMCache finishes asynchronously offloading the KV blocks it
    //    just computed to ARTESCA S3 before we ask for them back.
    await new Promise((resolve) => setTimeout(resolve, WARM_PAUSE_MS));

    const bucketObjectsAfter = await countBucketObjects();

    // 4. WARM — the IDENTICAL prompt (same nonce): a guaranteed KV hit.
    const warm = await streamCompletion(prompt, RACE_MAX_TOKENS, COMPLETION_TIMEOUT_MS);

    const speedup = warm.ttftMs > 0 ? cold.ttftMs / warm.ttftMs : 0;

    return {
      ok: true,
      model: CLUSTER.kvcache.model,
      cold,
      warm,
      speedup,
      bucketObjectsBefore,
      bucketObjectsAfter,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
