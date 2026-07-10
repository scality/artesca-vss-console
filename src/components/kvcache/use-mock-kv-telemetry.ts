"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Deterministic mock telemetry for the /kvcache showroom page (ISVD-331 Phase A).
 *
 * NOTHING here touches a network, the cluster, or Math.random() for the numbers
 * that matter — every headline figure is a fixed constant so the demo replays
 * identically every time. Timers drive the *animation* (stopwatch ticking,
 * tokens streaming, a bucket filling) but the destination values are pinned.
 *
 * Later phases (real telemetry) can swap this hook's internals for a live feed
 * without touching the components that consume it — the shape is deliberately
 * feed-agnostic (phase / elapsed / counters).
 */

// ---------------------------------------------------------------------------
// Fixed demo constants — the "plausible mock numbers" the spec calls for.
// ---------------------------------------------------------------------------

/** Cold (first-time visitor) time-to-first-token — full KV recompute. */
export const COLD_TTFT_MS = 1800;
/** Warm (returning visitor) time-to-first-token — KV reloaded from ARTESCA. */
export const WARM_TTFT_MS = 140;

/** Shared-prefix length of the store knowledge base baked into the prompt. */
export const SHARED_PREFIX_TOKENS = 12_288; // 12K tokens
/** vLLM/TensorRT-style KV block granularity. */
export const KV_BLOCK_TOKENS = 256;
export const KV_NUM_BLOCKS = SHARED_PREFIX_TOKENS / KV_BLOCK_TOKENS; // 48 blocks
/** Per-block bytes on the wire (K+V tensors across all layers, one block). */
export const KV_BLOCK_BYTES = 320 * 1024; // 320 KB/block
export const KV_TOTAL_BYTES = KV_NUM_BLOCKS * KV_BLOCK_BYTES; // ~15 MB

/** The question both visitors ask — same store-knowledge query, twice. */
export const DEMO_QUESTION = "What's your return policy on opened electronics?";
export const ANSWER_TOKENS = [
  "Opened", "electronics", "can", "be", "returned", "within", "15", "days",
  "with", "a", "receipt", "for", "a", "full", "refund.", "After", "15",
  "days,", "store", "credit", "only.", "Extended", "holiday", "returns",
  "run", "through", "January", "31.",
];
/** Streaming rate once the first token has landed. */
export const TOKEN_STREAM_MS = 55;

/** Cost-math batch size — "a batch of ~200 daily questions". */
export const DAILY_QUESTIONS = 200;
/** Mock GPU price used only for the illustrative $/query math. */
export const GPU_COST_PER_HOUR_USD = 3.0;
/** GPU-seconds actually *consumed* per query — cold pays for the full recompute. */
export const GPU_SECONDS_COLD = 1.8;
/** Warm hit still costs a sliver of GPU time (decode step), not zero. */
export const GPU_SECONDS_WARM = 0.02;

export interface CostTotals {
  n: number;
  coldCostPerQuery: number;
  warmCostPerQuery: number;
  savedCostPerQuery: number;
  gpuSecondsSavedPerQuery: number;
  totalGpuSecondsSaved: number;
  totalColdCostUsd: number;
  totalWarmCostUsd: number;
  totalSavedUsd: number;
  pctGpuTimeReduction: number;
  pctCostReduction: number;
}

/**
 * Pure — same inputs, same outputs, every time. Defaults to the fixed mock
 * GPU-seconds constants; a live caller (Phase C) overrides `coldSeconds` /
 * `warmSeconds` with the REAL measured cold/warm time-to-first-token from a
 * completed live race, so the exact same cost math renders from real inputs
 * instead of demo constants — the GPU-hour price stays illustrative either way.
 */
export function computeCostTotals(
  n: number = DAILY_QUESTIONS,
  coldSeconds: number = GPU_SECONDS_COLD,
  warmSeconds: number = GPU_SECONDS_WARM,
): CostTotals {
  const rate = GPU_COST_PER_HOUR_USD / 3600;
  const coldCostPerQuery = coldSeconds * rate;
  const warmCostPerQuery = warmSeconds * rate;
  const savedCostPerQuery = coldCostPerQuery - warmCostPerQuery;
  const gpuSecondsSavedPerQuery = coldSeconds - warmSeconds;
  return {
    n,
    coldCostPerQuery,
    warmCostPerQuery,
    savedCostPerQuery,
    gpuSecondsSavedPerQuery,
    totalGpuSecondsSaved: gpuSecondsSavedPerQuery * n,
    totalColdCostUsd: coldCostPerQuery * n,
    totalWarmCostUsd: warmCostPerQuery * n,
    totalSavedUsd: savedCostPerQuery * n,
    pctGpuTimeReduction: coldSeconds > 0 ? (1 - warmSeconds / coldSeconds) * 100 : 0,
    pctCostReduction: coldCostPerQuery > 0 ? (1 - warmCostPerQuery / coldCostPerQuery) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Shared lane state — one "visitor asking a question" lifecycle.
// ---------------------------------------------------------------------------

export type LanePhase = "idle" | "ttft" | "streaming" | "done";

export interface LaneState {
  phase: LanePhase;
  elapsedMs: number;
  tokensShown: number;
  kvBlocksRead: number;
  kvBytesRead: number;
}

export const IDLE_LANE: LaneState = {
  phase: "idle",
  elapsedMs: 0,
  tokensShown: 0,
  kvBlocksRead: 0,
  kvBytesRead: 0,
};

/** Bag of timer ids so a single cleanup clears every in-flight tick/timeout. */
function useTimerBag() {
  const ids = useRef<number[]>([]);
  const add = useCallback((id: number) => {
    ids.current.push(id);
  }, []);
  const clearAll = useCallback(() => {
    ids.current.forEach((id) => {
      window.clearTimeout(id);
      window.clearInterval(id);
    });
    ids.current = [];
  }, []);
  useEffect(() => clearAll, [clearAll]);
  return { add, clearAll };
}

const TICK_MS = 20;

/**
 * Drives one lane end-to-end: ttft stopwatch → (kv counters, if withKv) →
 * token-by-token streaming → done. Pure timer-driven, no I/O.
 */
function runLane(
  setLane: React.Dispatch<React.SetStateAction<LaneState>>,
  addTimer: (id: number) => void,
  ttftTargetMs: number,
  withKv: boolean
) {
  setLane({ ...IDLE_LANE, phase: "ttft" });
  const startedAt = performance.now();

  const tickId = window.setInterval(() => {
    const elapsed = performance.now() - startedAt;
    if (elapsed >= ttftTargetMs) {
      window.clearInterval(tickId);
      setLane((prev) => ({
        ...prev,
        elapsedMs: ttftTargetMs,
        kvBlocksRead: withKv ? KV_NUM_BLOCKS : 0,
        kvBytesRead: withKv ? KV_TOTAL_BYTES : 0,
        phase: "streaming",
      }));

      let tokenIdx = 0;
      const streamId = window.setInterval(() => {
        tokenIdx += 1;
        setLane((prev) => ({ ...prev, tokensShown: tokenIdx }));
        if (tokenIdx >= ANSWER_TOKENS.length) {
          window.clearInterval(streamId);
          setLane((prev) => ({ ...prev, phase: "done" }));
        }
      }, TOKEN_STREAM_MS);
      addTimer(streamId);
      return;
    }
    const kvFrac = withKv ? Math.min(1, elapsed / ttftTargetMs) : 0;
    setLane((prev) => ({
      ...prev,
      elapsedMs: elapsed,
      kvBlocksRead: Math.round(KV_NUM_BLOCKS * kvFrac),
      kvBytesRead: Math.round(KV_TOTAL_BYTES * kvFrac),
    }));
  }, TICK_MS);
  addTimer(tickId);
}

// ---------------------------------------------------------------------------
// Beat 1 — the race: cold lane (GPU recompute) vs warm lane (ARTESCA reload).
// ---------------------------------------------------------------------------

export function useKvRace() {
  const [cold, setCold] = useState<LaneState>(IDLE_LANE);
  const [warm, setWarm] = useState<LaneState>(IDLE_LANE);
  const [running, setRunning] = useState(false);
  const { add, clearAll } = useTimerBag();

  const reset = useCallback(() => {
    clearAll();
    setCold(IDLE_LANE);
    setWarm(IDLE_LANE);
    setRunning(false);
  }, [clearAll]);

  const start = useCallback(() => {
    clearAll();
    setRunning(true);
    runLane(setCold, add, COLD_TTFT_MS, false);
    runLane(setWarm, add, WARM_TTFT_MS, true);

    // Cold is always the longer lane — flip `running` off once it would be done.
    const totalMs = COLD_TTFT_MS + ANSWER_TOKENS.length * TOKEN_STREAM_MS + 100;
    const doneId = window.setTimeout(() => setRunning(false), totalMs);
    add(doneId);
  }, [add, clearAll]);

  return { cold, warm, running, start, reset };
}

// ---------------------------------------------------------------------------
// Beat 2 — persistence: restart the GPU pod, first post-restart query is warm.
// ---------------------------------------------------------------------------

export type RestartPhase = "idle" | "terminating" | "creating" | "running" | "querying" | "done";

const RESTART_TERMINATING_MS = 900;
const RESTART_CREATING_MS = 1300;
const RESTART_RUNNING_MS = 500;

export function useKvRestart() {
  const [phase, setPhase] = useState<RestartPhase>("idle");
  const [lane, setLane] = useState<LaneState>(IDLE_LANE);
  const { add, clearAll } = useTimerBag();

  const reset = useCallback(() => {
    clearAll();
    setPhase("idle");
    setLane(IDLE_LANE);
  }, [clearAll]);

  const start = useCallback(() => {
    clearAll();
    setLane(IDLE_LANE);
    setPhase("terminating");

    const t1 = window.setTimeout(() => {
      setPhase("creating");
      const t2 = window.setTimeout(() => {
        setPhase("running");
        const t3 = window.setTimeout(() => {
          setPhase("querying");
          runLane(setLane, add, WARM_TTFT_MS, true);
          const totalMs = WARM_TTFT_MS + ANSWER_TOKENS.length * TOKEN_STREAM_MS + 100;
          const t4 = window.setTimeout(() => setPhase("done"), totalMs);
          add(t4);
        }, RESTART_RUNNING_MS);
        add(t3);
      }, RESTART_CREATING_MS);
      add(t2);
    }, RESTART_TERMINATING_MS);
    add(t1);
  }, [add, clearAll]);

  return { phase, lane, start, reset };
}

// ---------------------------------------------------------------------------
// Beat 3 — cost: animate a day of questions filling the "savings bucket".
// ---------------------------------------------------------------------------

const COST_SIM_STEPS = 50;
const COST_SIM_STEP_MS = 60; // ~3s total

export function useKvCostSim(totals: CostTotals) {
  const [queriesDone, setQueriesDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const { add, clearAll } = useTimerBag();

  const reset = useCallback(() => {
    clearAll();
    setQueriesDone(0);
    setRunning(false);
    setDone(false);
  }, [clearAll]);

  const start = useCallback(() => {
    clearAll();
    setDone(false);
    setRunning(true);
    setQueriesDone(0);

    const perStep = totals.n / COST_SIM_STEPS;
    let step = 0;
    const id = window.setInterval(() => {
      step += 1;
      const next = Math.min(totals.n, Math.round(step * perStep));
      setQueriesDone(next);
      if (step >= COST_SIM_STEPS) {
        window.clearInterval(id);
        setQueriesDone(totals.n);
        setRunning(false);
        setDone(true);
      }
    }, COST_SIM_STEP_MS);
    add(id);
  }, [add, clearAll, totals.n]);

  const gpuSecondsSaved = queriesDone * totals.gpuSecondsSavedPerQuery;
  const dollarsSaved = queriesDone * totals.savedCostPerQuery;

  return { queriesDone, running, done, gpuSecondsSaved, dollarsSaved, start, reset };
}
