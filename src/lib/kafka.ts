import { Kafka, type Consumer, type EachMessagePayload } from "kafkajs";
import { createLogger } from "@/lib/logger";

const log = createLogger("kafka");

const globalForKafka = globalThis as unknown as { __kafka?: Kafka | null };

export type KafkaStatus = "connected" | "disconnected";

interface KafkaShape {
  status: KafkaStatus;
  instance: Kafka | null;
}

export function getKafka(): KafkaShape {
  const brokers = process.env.KAFKA_BROKERS;
  if (!brokers) {
    return { status: "disconnected", instance: null };
  }

  if (!globalForKafka.__kafka) {
    globalForKafka.__kafka = new Kafka({
      clientId: "console",
      brokers: brokers.split(",").map((b) => b.trim()),
      retry: { retries: 3 },
    });
  }

  return { status: "connected", instance: globalForKafka.__kafka };
}

/**
 * Consume messages from a Kafka topic until the AbortSignal fires.
 * Each invocation gets its own consumer group so parallel connections
 * each receive all messages.
 */
export async function consumeTopic(
  topic: string,
  onMessage: (payload: EachMessagePayload) => Promise<void>,
  signal: AbortSignal
): Promise<void> {
  const { instance } = getKafka();
  if (!instance) {
    throw new Error("Kafka not configured — set KAFKA_BROKERS");
  }

  const groupId = `console-${topic}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const consumer: Consumer = instance.consumer({ groupId });

  await consumer.connect();

  consumer.on(consumer.events.CRASH, (event) => {
    log.error("consumer crashed", { err: event.payload?.error });
  });

  await consumer.subscribe({ topic, fromBeginning: false });

  signal.addEventListener("abort", () => {
    consumer.disconnect().catch((err) => log.warn("disconnect failed", { err }));
  });

  await consumer.run({ eachMessage: onMessage });
}
