import { Kafka, type Consumer, type EachMessagePayload } from "kafkajs";

let _kafka: Kafka | null = null;

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

  if (!_kafka) {
    _kafka = new Kafka({
      clientId: "console",
      brokers: brokers.split(",").map((b) => b.trim()),
      retry: { retries: 3 },
    });
  }

  return { status: "connected", instance: _kafka };
}

/**
 * Consume messages from a Kafka topic until the AbortSignal fires.
 * Each invocation gets its own consumer group so parallel connections
 * each receive all messages (design doc decision A).
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
  await consumer.subscribe({ topic, fromBeginning: false });

  signal.addEventListener("abort", () => {
    consumer.disconnect().catch(() => undefined);
  });

  await consumer.run({ eachMessage: onMessage });
}
