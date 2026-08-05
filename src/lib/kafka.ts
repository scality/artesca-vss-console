import { Kafka, logLevel as KafkaLogLevel, type Consumer, type EachMessagePayload } from "kafkajs";
import { createLogger } from "@/lib/logger";

const log = createLogger("kafka");

// kafkajs's default logger writes connection failures straight to console.error,
// which Next.js dev surfaces as a disruptive red "Console Error" overlay — even
// though the overview Kafka probe handles an unreachable broker fail-soft
// (warnings[] + the ConnectivityStrip) and consumeTopic has its own CRASH handler.
// Route kafkajs's internal logs through the app logger at debug so they never hit
// console.error/.warn; Kafka health is reported through those proper channels.
function kafkaLogCreator() {
  return ({
    namespace,
    label,
    log: entry,
  }: {
    namespace: string;
    level: number;
    label: string;
    log: { message: string; [key: string]: unknown };
  }) => {
    const { message, timestamp: _t, logger: _l, ...rest } = entry;
    log.debug(`kafkajs ${label}${namespace ? ` ${namespace}` : ""}: ${message}`, rest);
  };
}

const globalForKafka = globalThis as unknown as { __kafka?: Kafka | null };

/** Consecutive consumer crashes tolerated before a topic is abandoned. Enough
 *  to ride out a broker restart, few enough that an unreachable broker stops
 *  producing log noise within seconds. */
const MAX_CONSUMER_RESTARTS = 5;

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
      // Fail fast when the broker is unreachable: without a connectionTimeout
      // the admin probe in the overview collector retried for minutes and hung
      // the whole page. Bounded connect + few retries keep it snappy.
      connectionTimeout: 3_000,
      requestTimeout: 5_000,
      retry: { retries: 2, initialRetryTime: 300, maxRetryTime: 3_000 },
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

  // Give up after a few consecutive crashes instead of reconnecting forever.
  // kafkajs restarts a crashed consumer by default, so a broker that can never
  // be reached — e.g. one advertising an address this namespace cannot resolve
  // (ISVD-506) — produced a ~300ms restart loop that ran for the pod's lifetime
  // and buried every other line in the log. A consumer that cannot connect is
  // not something retrying will fix; report it once and stop.
  let crashes = 0;
  const consumer: Consumer = instance.consumer({
    groupId,
    retry: {
      restartOnFailure: async (err: Error) => {
        crashes += 1;
        if (crashes <= MAX_CONSUMER_RESTARTS) return true;
        log.error(
          `consumer for ${topic} gave up after ${crashes} restarts — not retrying`,
          { err: err.message },
        );
        return false;
      },
    },
  });

  await consumer.connect();

  consumer.on(consumer.events.CRASH, (event) => {
    log.error("consumer crashed", { topic, restarts: crashes, err: event.payload?.error });
  });

  await consumer.subscribe({ topic, fromBeginning: false });

  signal.addEventListener("abort", () => {
    consumer.disconnect().catch((err) => log.warn("disconnect failed", { err }));
  });

  await consumer.run({ eachMessage: onMessage });
}
