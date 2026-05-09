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

  consumer.on(consumer.events.CRASH, (event) => {
    console.error("[kafka-sse] consumer crash", event.payload.error, {
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
  let replayPhase = replayTarget > 0; // true = in replay window, forward up to N then switch to live

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
    consumer.disconnect().catch(() => undefined);
  };

  opts.signal.addEventListener("abort", disconnect, { once: true });

  return disconnect;
}
