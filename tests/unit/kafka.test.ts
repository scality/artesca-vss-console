import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";

// ─── KafkaJS mock ────────────────────────────────────────────────────────────
//
// Defined at module scope so each test can reset individual fn implementations
// via vi.resetAllMocks() without losing the vi.mock() wiring.

const mockConsumer = {
  connect: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  events: {
    CRASH: "consumer.crash",
    GROUP_JOIN: "consumer.group_join",
  },
};

const MockKafka = vi.fn().mockImplementation(() => ({
  consumer: vi.fn(() => mockConsumer),
}));

vi.mock("kafkajs", () => ({ Kafka: MockKafka }));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Re-import kafka.ts with a clean module registry so each test starts with a
 * fresh globalThis.__kafka singleton and a fresh module-level state.
 */
async function freshImport() {
  vi.resetModules();
  return import("@/lib/kafka");
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();

  // Restore the default implementations that vi.resetAllMocks() clears.
  mockConsumer.connect.mockResolvedValue(undefined);
  mockConsumer.subscribe.mockResolvedValue(undefined);
  mockConsumer.run.mockResolvedValue(undefined);
  mockConsumer.disconnect.mockResolvedValue(undefined);
  MockKafka.mockImplementation(() => ({ consumer: vi.fn(() => mockConsumer) }));

  // Clear the HMR singleton between tests.
  (globalThis as Record<string, unknown>).__kafka = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── getKafka() ───────────────────────────────────────────────────────────────

describe("getKafka()", () => {
  it("returns { status: disconnected, instance: null } when KAFKA_BROKERS is unset", async () => {
    vi.stubEnv("KAFKA_BROKERS", "");
    // Also cover the actual-undefined path (delete the var).
    delete process.env.KAFKA_BROKERS;

    const { getKafka } = await freshImport();
    const result = getKafka();

    expect(result).toEqual({ status: "disconnected", instance: null });
    expect(MockKafka).not.toHaveBeenCalled();
  });

  it("constructs Kafka with split+trimmed brokers, clientId console, and retry { retries: 3 }", async () => {
    vi.stubEnv("KAFKA_BROKERS", "broker1:9092 , broker2:9092,broker3:9092");

    const { getKafka } = await freshImport();
    const result = getKafka();

    expect(result.status).toBe("connected");
    expect(result.instance).not.toBeNull();

    expect(MockKafka).toHaveBeenCalledOnce();
    expect(MockKafka).toHaveBeenCalledWith({
      clientId: "console",
      brokers: ["broker1:9092", "broker2:9092", "broker3:9092"],
      retry: { retries: 3 },
    });
  });

  it("returns the same instance on the second call (singleton — constructor called once)", async () => {
    vi.stubEnv("KAFKA_BROKERS", "broker1:9092");

    const { getKafka } = await freshImport();
    const first = getKafka();
    const second = getKafka();

    expect(first.instance).toBe(second.instance);
    // The Kafka constructor must have been called exactly once across both
    // getKafka() calls.
    expect(MockKafka).toHaveBeenCalledOnce();
  });
});

// ─── consumeTopic() ──────────────────────────────────────────────────────────

describe("consumeTopic()", () => {
  it("throws when KAFKA_BROKERS is not set", async () => {
    delete process.env.KAFKA_BROKERS;

    const { consumeTopic } = await freshImport();
    const controller = new AbortController();

    await expect(
      consumeTopic("my-topic", vi.fn(), controller.signal),
    ).rejects.toThrow("Kafka not configured");
  });

  it("calls connect, subscribe (fromBeginning false), and run in order", async () => {
    vi.stubEnv("KAFKA_BROKERS", "broker1:9092");

    const { consumeTopic } = await freshImport();
    const controller = new AbortController();
    const onMessage = vi.fn();

    const callOrder: string[] = [];
    mockConsumer.connect.mockImplementation(async () => {
      callOrder.push("connect");
    });
    mockConsumer.subscribe.mockImplementation(async () => {
      callOrder.push("subscribe");
    });
    mockConsumer.run.mockImplementation(async () => {
      callOrder.push("run");
    });

    await consumeTopic("events", onMessage, controller.signal);

    expect(callOrder).toEqual(["connect", "subscribe", "run"]);

    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topic: "events",
      fromBeginning: false,
    });

    expect(mockConsumer.run).toHaveBeenCalledWith({
      eachMessage: onMessage,
    });
  });

  it("calls consumer.disconnect() when the AbortSignal fires", async () => {
    vi.stubEnv("KAFKA_BROKERS", "broker1:9092");

    const { consumeTopic } = await freshImport();
    const controller = new AbortController();

    await consumeTopic("events", vi.fn(), controller.signal);

    expect(mockConsumer.disconnect).not.toHaveBeenCalled();

    controller.abort();

    // disconnect() is called inside a .catch(), so let the microtask queue
    // drain before asserting.
    await Promise.resolve();

    expect(mockConsumer.disconnect).toHaveBeenCalledOnce();
  });

  it("registers the CRASH handler via consumer.on and logs via console.error when it fires", async () => {
    vi.stubEnv("KAFKA_BROKERS", "broker1:9092");

    const { consumeTopic } = await freshImport();
    const controller = new AbortController();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => void 0);

    await consumeTopic("events", vi.fn(), controller.signal);

    // consumer.on must have been called with the CRASH event name.
    const crashCall = (mockConsumer.on as Mock).mock.calls.find(
      ([eventName]) => eventName === mockConsumer.events.CRASH,
    );
    expect(crashCall).toBeDefined();

    // Invoke the registered handler with a fake event and confirm console.error.
    const crashHandler = crashCall![1] as (event: unknown) => void;
    const fakeError = new Error("broker disconnected");
    crashHandler({ payload: { error: fakeError } });

    expect(errorSpy).toHaveBeenCalledWith(
      "[kafka] consumer crashed",
      fakeError,
    );

    errorSpy.mockRestore();
  });
});
