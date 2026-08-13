import "server-only";

/**
 * error-bridge.ts — captures failures from the closed upstream NVIDIA VSS
 * services (vision-llm / vision-embed pipelines, VST/rtvi/agent pods) into
 * Sentry. We can't instrument those services directly (closed source, no
 * Sentry SDK inside), so this bridge taps two signals the console already has
 * network access to:
 *
 *  1. Kafka error topics (`vision-llm-errors`, `vision-embed-errors`) —
 *     the pipelines publish structured error events there on failure.
 *  2. K8s pod state in the watched VSS namespaces — restart-count deltas and
 *     CrashLoopBackOff/Error waiting reasons surface container crashes even
 *     when nothing reaches Kafka (e.g. the pod died before it could publish).
 *
 * Hardening (the console handles lab secrets — S3/objectstore keys, camera-sim
 * SSH PEM, Firestore SA key, ARTESCA Grafana/Keycloak passwords):
 *   - never attach raw env or full k8s Secret/ConfigMap objects
 *   - every string sent to Sentry is capped in length
 *   - values that look like a key/token/password are redacted before capture
 *   - identical (topic+signature) or (pod+reason) events are deduped within a
 *     window so a crashlooping service reports once per window, not a storm
 *
 * Disable entirely with VSS_ERROR_BRIDGE=0 (default on). Fail-soft throughout —
 * this must never crash the server process or block startup.
 */

import * as Sentry from "@/lib/telemetry";
import { serverTelemetryDsn } from "@/lib/telemetry-config";
import type { EachMessagePayload } from "kafkajs";
import { createLogger } from "@/lib/logger";
import { consumeTopic } from "@/lib/kafka";
import { CLUSTER } from "@/lib/cluster-refs";
import { coreV1, watchedNamespaces } from "@/lib/k8s";

const log = createLogger("error-bridge");

// ─── Pure helpers (unit-tested) ────────────────────────────────────────────

/** Cap applied to any single string value forwarded to Sentry context. */
export const MAX_CONTEXT_STRING_LEN = 2000;

/** Cap applied to the overall serialized context payload. */
export const MAX_CONTEXT_TOTAL_LEN = 4000;

/** Dedupe/rate-limit window, in ms — one capture per key per window. */
export const DEDUPE_WINDOW_MS = 60_000;

/**
 * Keys (or key fragments) that indicate a value likely holds a credential.
 * Matched case-insensitively against object keys during redaction.
 */
const SECRET_KEY_PATTERN =
  /(key|token|secret|password|passwd|pwd|authorization|auth[-_]?header|credential|private[-_]?key|pem|bearer)/i;

/** Heuristic for a bare string that looks like a credential/token value. */
const SECRET_VALUE_PATTERN =
  /^(sk-|ghp_|glpat-|AKIA|Bearer\s|Basic\s|eyJ[a-zA-Z0-9_-]{10,})/;

function truncate(s: string, max = MAX_CONTEXT_STRING_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

/**
 * Recursively redacts anything that looks like a secret from a JSON-ish
 * value, then caps string lengths. Returns a plain object/array/primitive
 * safe to attach as Sentry extra context. Depth-limited and size-limited so a
 * pathological payload can't blow up processing or the outbound event.
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

/**
 * Serializes a redacted context object to a string capped at
 * MAX_CONTEXT_TOTAL_LEN, so the overall payload attached to a Sentry event
 * stays bounded regardless of how deep/wide the source object was.
 */
export function safeContextString(value: unknown): string {
  const redacted = redactAndCap(value);
  let json: string;
  try {
    json = JSON.stringify(redacted);
  } catch {
    json = String(redacted);
  }
  return truncate(json, MAX_CONTEXT_TOTAL_LEN);
}

/** A best-effort "error class" extracted from a Kafka error-topic payload. */
export function errorSignatureFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const candidates = [p.error, p.error_type, p.errorType, p.code, p.reason, p.message, p.type];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return truncate(c.trim(), 200);
    }
  }
  if (typeof payload === "string") return truncate(payload.trim(), 200);
  return "unknown";
}

/** Fingerprint grouping Kafka errors by topic + error class. */
export function kafkaFingerprint(topic: string, signature: string): string[] {
  return ["vss-kafka", topic, signature];
}

/** Fingerprint grouping pod-crash events by pod identity + reason. */
export function podFingerprint(
  namespace: string,
  podBaseName: string,
  container: string,
  reason: string
): string[] {
  return ["vss-pod", namespace, podBaseName, container, reason];
}

/**
 * Strips a trailing generation suffix (ReplicaSet hash + random pod suffix)
 * so pods from the same Deployment/rollout fingerprint together instead of
 * fragmenting per-pod-instance. Conservative: only strips the last one or two
 * `-<alnum>` segments when they look like k8s-generated suffixes (5+ chars,
 * lowercase alnum, or purely numeric/hex-ish), keeping stable names intact.
 */
export function podBaseName(podName: string): string {
  const parts = podName.split("-");
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    const looksGenerated = /^[a-z0-9]{5,10}$/.test(last) && /[a-z]/.test(last) && /[0-9]/.test(last);
    if (!looksGenerated) break;
    parts.pop();
  }
  return parts.join("-") || podName;
}

/** In-memory rate limiter: true if `key` fired within the last `windowMs`. */
export class DedupeWindow {
  private lastSeen = new Map<string, number>();

  constructor(private windowMs: number = DEDUPE_WINDOW_MS) {}

  /** Returns true if this call should be SUPPRESSED (seen recently). */
  shouldSuppress(key: string, now: number = Date.now()): boolean {
    const last = this.lastSeen.get(key);
    const suppress = last !== undefined && now - last < this.windowMs;
    if (!suppress) this.lastSeen.set(key, now);
    return suppress;
  }

  /** Drops entries older than the window to bound memory over long uptimes. */
  sweep(now: number = Date.now()): void {
    for (const [key, ts] of this.lastSeen) {
      if (now - ts >= this.windowMs) this.lastSeen.delete(key);
    }
  }

  size(): number {
    return this.lastSeen.size;
  }
}

// ─── Kafka error tap ────────────────────────────────────────────────────────

const kafkaDedupe = new DedupeWindow();

async function handleKafkaMessage(topic: string, payload: EachMessagePayload): Promise<void> {
  const raw = payload.message.value?.toString("utf8");
  if (!raw) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }

  const signature = errorSignatureFromPayload(parsed);
  const dedupeKey = `${topic}:${signature}`;
  if (kafkaDedupe.shouldSuppress(dedupeKey)) return;

  const fingerprint = kafkaFingerprint(topic, signature);

  Sentry.captureMessage(`VSS pipeline error on ${topic}: ${signature}`, {
    level: "error",
    tags: { component: "vss-kafka", topic },
    fingerprint,
    contexts: {
      "vss-kafka-error": {
        topic,
        partition: payload.partition,
        offset: payload.message.offset,
        payload: safeContextString(parsed),
      },
    },
  });

  log.warn("captured kafka error", { topic, signature });
}

async function startKafkaErrorTap(signal: AbortSignal): Promise<void> {
  const topics = [CLUSTER.kafka.topics.visionLlmErrors, CLUSTER.kafka.topics.embedErrors];

  await Promise.all(
    topics.map(async (topic) => {
      try {
        await consumeTopic(topic, (payload) => handleKafkaMessage(topic, payload), signal);
      } catch (err) {
        // consumeTopic throws if KAFKA_BROKERS is unset — expected in some
        // environments (e.g. no Kafka configured). Fail-soft.
        log.warn("kafka error tap not started", { topic, err });
      }
    })
  );
}

// ─── Pod-crash watch ────────────────────────────────────────────────────────

const POD_POLL_INTERVAL_MS = 45_000;

interface ContainerCrashKey {
  namespace: string;
  pod: string;
  container: string;
}

/** Tracks last-seen restartCount per (namespace, pod, container) to detect deltas. */
const lastRestartCounts = new Map<string, number>();

function containerKey(k: ContainerCrashKey): string {
  return `${k.namespace}/${k.pod}/${k.container}`;
}

const podDedupe = new DedupeWindow();

function captureContainerCrash(
  namespace: string,
  podName: string,
  containerName: string,
  reason: string,
  detail: Record<string, unknown>,
  level: "error" | "warning" = "error"
): void {
  const base = podBaseName(podName);
  const dedupeKey = `${namespace}:${base}:${containerName}:${reason}`;
  if (podDedupe.shouldSuppress(dedupeKey)) return;

  const fingerprint = podFingerprint(namespace, base, containerName, reason);

  Sentry.captureMessage(`VSS pod crash: ${namespace}/${podName} [${containerName}] ${reason}`, {
    level,
    tags: { component: "vss-pod", namespace, pod: base, container: containerName },
    fingerprint,
    contexts: {
      "vss-pod-crash": {
        namespace,
        pod: podName,
        container: containerName,
        reason,
        detail: safeContextString(detail),
      },
    },
  });

  log.warn("captured pod crash", { namespace, pod: podName, container: containerName, reason });
}

const CRASHLOOP_REASONS = new Set(["CrashLoopBackOff", "Error", "ImagePullBackOff", "ErrImagePull"]);

async function pollNamespaceOnce(namespace: string): Promise<void> {
  const pods = await coreV1().listNamespacedPod({ namespace });

  for (const pod of pods.items ?? []) {
    const podName = pod.metadata?.name;
    if (!podName) continue;

    for (const cs of pod.status?.containerStatuses ?? []) {
      const containerName = cs.name;
      const key = containerKey({ namespace, pod: podName, container: containerName });
      const restartCount = cs.restartCount ?? 0;
      const prev = lastRestartCounts.get(key);
      lastRestartCounts.set(key, restartCount);

      if (prev !== undefined && restartCount > prev) {
        const terminated = cs.lastState?.terminated;
        captureContainerCrash(
          namespace,
          podName,
          containerName,
          "RestartCountIncreased",
          {
            restartCount,
            previousRestartCount: prev,
            lastTerminatedReason: terminated?.reason,
            lastTerminatedExitCode: terminated?.exitCode,
          },
          "error"
        );
      }

      const waitingReason = cs.state?.waiting?.reason;
      if (waitingReason && CRASHLOOP_REASONS.has(waitingReason)) {
        captureContainerCrash(
          namespace,
          podName,
          containerName,
          waitingReason,
          {
            waitingMessage: cs.state?.waiting?.message,
            restartCount,
          },
          waitingReason === "CrashLoopBackOff" || waitingReason === "Error" ? "error" : "warning"
        );
      }
    }
  }
}

async function startPodCrashWatch(): Promise<() => void> {
  const namespaces = watchedNamespaces();

  const tick = async () => {
    for (const ns of namespaces) {
      try {
        await pollNamespaceOnce(ns);
      } catch (err) {
        log.warn("pod poll failed", { namespace: ns, err });
      }
    }
    podDedupe.sweep();
  };

  await tick();
  const interval = setInterval(() => {
    void tick();
  }, POD_POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}

// ─── Entry point ────────────────────────────────────────────────────────────

const globalForErrorBridge = globalThis as unknown as { __errorBridgeStarted?: boolean };

function hasSentryDsn(): boolean {
  // Delegated rather than read from the environment here: this is the fourth
  // place that would otherwise answer "is telemetry configured", and the three
  // Sentry.init calls already guard on the same function.
  //
  // `process.env.SENTRY_DSN !== ""` was the previous test, and it is true when
  // the variable is UNSET — so an unconfigured console started the Kafka
  // consumers and the pod-poll loop and pushed captures into an SDK that was
  // never initialised. It read as correct only while a DSN was compiled in.
  return serverTelemetryDsn() !== undefined;
}

/**
 * Starts the console-side error bridge (Kafka error tap + pod-crash watch).
 * Node-only, idempotent, fail-soft — never throws.
 */
export async function startErrorBridge(): Promise<void> {
  try {
    if (process.env.VSS_ERROR_BRIDGE === "0") {
      log.info("disabled via VSS_ERROR_BRIDGE=0");
      return;
    }
    if (!hasSentryDsn()) {
      log.info("no Sentry DSN configured — skipping");
      return;
    }
    if (globalForErrorBridge.__errorBridgeStarted) return;
    globalForErrorBridge.__errorBridgeStarted = true;

    const controller = new AbortController();
    void startKafkaErrorTap(controller.signal).catch((err) =>
      log.warn("kafka error tap crashed", { err })
    );

    await startPodCrashWatch();

    log.info("started", {
      topics: [CLUSTER.kafka.topics.visionLlmErrors, CLUSTER.kafka.topics.embedErrors],
      namespaces: watchedNamespaces(),
    });
  } catch (err) {
    // Never let bridge startup take down the server.
    log.warn("failed to start", { err });
  }
}
