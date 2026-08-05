// src/lib/streams/kafka-sse.ts
// Common Kafka consumer setup + JSON parsing + SSE wrapping for SSE routes.

import { type Consumer } from "kafkajs";
import { randomUUID } from "crypto";
import { createLogger } from "@/lib/logger";
import { getKafka } from "@/lib/kafka";

const log = createLogger("kafka-sse");

export const ALLOWED_TOPICS = new Set([
  "vision-llm-responses",
  // "incidents" is kept for backward compatibility — unused today, no harm.
  "incidents",
  "alerts.incidents",
] as const);

export type AllowedTopic =
  | "vision-llm-responses"
  | "incidents"
  | "alerts.incidents"
;

export interface KafkaSseOptions {
  topic: string;
  /** "earliest" (default) | "latest" */
  fromOffset?: "earliest" | "latest";
  /** Replay N most-recent messages before switching to live. */
  replayCount?: number;
  signal: AbortSignal;
  onMessage: (parsed: unknown) => void;
}

const MAX_ACTIVE_CONSUMERS = (() => {
  const raw = parseInt(process.env.KAFKA_SSE_MAX_CONSUMERS ?? "50", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
})();

interface ActiveEntry {
  consumer: Consumer;
  topic: string;
  groupId: string;
  disconnected: boolean;
}

const g = globalThis as unknown as {
  __kafkaSseActive?: Set<ActiveEntry>;
  __kafkaSseShutdownRegistered?: boolean;
};

if (!g.__kafkaSseActive) g.__kafkaSseActive = new Set<ActiveEntry>();
const activeConsumers = g.__kafkaSseActive;

if (!g.__kafkaSseShutdownRegistered) {
  g.__kafkaSseShutdownRegistered = true;
  const drain = () => {
    if (activeConsumers.size === 0) return;
    log.info("draining active consumers", { count: activeConsumers.size });
    for (const entry of [...activeConsumers]) {
      void disconnectEntry(entry);
    }
  };
  process.once("SIGTERM", drain);
  process.once("SIGINT", drain);
}

function disconnectEntry(entry: ActiveEntry): Promise<void> {
  if (entry.disconnected) return Promise.resolve();
  entry.disconnected = true;
  activeConsumers.delete(entry);
  return entry.consumer.disconnect().catch((err) => {
    log.warn("disconnect failed", { err, topic: entry.topic, groupId: entry.groupId });
  });
}

export class KafkaSseCapacityError extends Error {
  constructor(public readonly limit: number, public readonly active: number) {
    super(`kafka-sse: max active consumers reached (${active}/${limit})`);
    this.name = "KafkaSseCapacityError";
  }
}

/** Active consumer count — exposed for tests and capacity probes. */
export function getActiveConsumerCount(): number {
  return activeConsumers.size;
}

/**
 * Starts a dedicated Kafka consumer for a single SSE connection.
 * Reuses the process-wide Kafka client (one TCP pool) but assigns a
 * unique consumer group per call so parallel SSE clients each receive
 * all messages independently.
 *
 * Returns a cleanup function that disconnects the consumer; cleanup is
 * idempotent (safe to call multiple times).
 */
export async function startKafkaSseConsumer(
  opts: KafkaSseOptions
): Promise<() => void> {
  if (activeConsumers.size >= MAX_ACTIVE_CONSUMERS) {
    throw new KafkaSseCapacityError(MAX_ACTIVE_CONSUMERS, activeConsumers.size);
  }

  const { instance } = getKafka();
  if (!instance) {
    throw new Error("Kafka not configured — set KAFKA_BROKERS");
  }

  const groupId = `console-sse-${opts.topic}-${randomUUID()}`;
  const consumer: Consumer = instance.consumer({ groupId });
  const entry: ActiveEntry = { consumer, topic: opts.topic, groupId, disconnected: false };
  activeConsumers.add(entry);

  try {
    await consumer.connect();
  } catch (err) {
    activeConsumers.delete(entry);
    throw err;
  }

  consumer.on(consumer.events.CRASH, (event) => {
    log.error("consumer crash", {
      err: event.payload.error,
      groupId: event.payload.groupId,
      restart: event.payload.restart,
    });
  });

  // "replay N" requires reading from earliest so old messages are visible;
  // fromOffset is ignored when replayCount > 0.
  const replayTarget = opts.replayCount ?? 0;
  const fromBeginning = replayTarget > 0 ? true : opts.fromOffset !== "latest";

  await consumer.subscribe({ topic: opts.topic, fromBeginning });

  let replayed = 0;
  let replayPhase = replayTarget > 0;

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (opts.signal.aborted) return;

      const raw = message.value?.toString("utf8");
      if (!raw) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }

      if (replayPhase) {
        if (replayed < replayTarget) {
          replayed++;
          opts.onMessage(parsed);
          if (replayed >= replayTarget) {
            replayPhase = false;
          }
        }
      } else {
        opts.onMessage(parsed);
      }
    },
  });

  const disconnect = () => {
    void disconnectEntry(entry);
  };

  opts.signal.addEventListener("abort", disconnect, { once: true });

  return disconnect;
}
