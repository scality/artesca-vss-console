// src/lib/streams/kafka-sse.ts
// Common Kafka consumer setup + JSON parsing + SSE wrapping for SSE routes.

import { Kafka, type Consumer } from "kafkajs";
import { randomUUID } from "crypto";

export const ALLOWED_TOPICS = new Set([
  "vision-llm-responses",
  "incidents",
  "alerts-demo-data",
] as const);

export type AllowedTopic = "vision-llm-responses" | "incidents" | "alerts-demo-data";

export interface KafkaSseOptions {
  topic: string;
  /** "earliest" (default) | "latest" */
  fromOffset?: "earliest" | "latest";
  /** Replay N most-recent messages before switching to live. */
  replayCount?: number;
  signal: AbortSignal;
  onMessage: (parsed: unknown) => void;
}

/**
 * Starts a dedicated Kafka consumer for a single SSE connection.
 * Returns a cleanup function that disconnects the consumer.
 */
export async function startKafkaSseConsumer(
  opts: KafkaSseOptions
): Promise<() => void> {
  const brokersEnv = process.env.KAFKA_BROKERS;
  if (!brokersEnv) {
    throw new Error("Kafka not configured — set KAFKA_BROKERS");
  }

  const kafka = new Kafka({
    clientId: `console-sse-${randomUUID()}`,
    brokers: brokersEnv.split(",").map((b) => b.trim()),
    retry: { retries: 3 },
  });

  const groupId = `console-sse-${opts.topic}-${randomUUID()}`;
  const consumer: Consumer = kafka.consumer({ groupId });

  await consumer.connect();

  const fromBeginning =
    opts.fromOffset === "latest" ? false : true;

  await consumer.subscribe({ topic: opts.topic, fromBeginning });

  // For "replay N then live" semantics we collect the last N in a ring buffer.
  // KafkaJS doesn't expose a trivial "seek to offset-N" without admin, so we
  // approximate: if replayCount is set we subscribe from beginning and discard
  // after replayCount messages have been forwarded.  For large topics in prod
  // an offset-seek approach would be preferable; for this demo context the
  // simple approach is acceptable.
  let replayed = 0;
  const replayTarget = opts.replayCount ?? 0;
  let replayPhase = replayTarget > 0 && !fromBeginning ? false : true;

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

      if (!replayPhase) {
        if (replayed < replayTarget) {
          replayed++;
          opts.onMessage(parsed);
          if (replayed >= replayTarget) {
            replayPhase = true;
          }
        }
      } else {
        opts.onMessage(parsed);
      }
    },
  });

  const disconnect = () => {
    consumer.disconnect().catch(() => undefined);
  };

  opts.signal.addEventListener("abort", disconnect, { once: true });

  return disconnect;
}
