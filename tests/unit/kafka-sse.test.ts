import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// vi.resetModules() reimports kafka-sse.ts each test, which registers fresh
// SIGTERM/SIGINT handlers — without lifting the cap, Node warns at >10.
process.setMaxListeners(50);

const mockConsumer = {
  connect: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  events: { CRASH: "consumer.crash" },
};

const mockKafkaInstance = {
  consumer: vi.fn((_args: { groupId: string }): typeof mockConsumer => mockConsumer),
};

vi.mock("@/lib/kafka", () => ({
  getKafka: vi.fn(() => ({ status: "connected", instance: mockKafkaInstance })),
}));

describe("kafka-sse", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
  let stderrWrites: string[];

  beforeEach(() => {
    vi.resetModules();
    mockConsumer.connect.mockReset().mockResolvedValue(undefined);
    mockConsumer.subscribe.mockReset().mockResolvedValue(undefined);
    mockConsumer.run.mockReset().mockResolvedValue(undefined);
    mockConsumer.disconnect.mockReset().mockResolvedValue(undefined);
    mockConsumer.on.mockReset();
    mockKafkaInstance.consumer.mockClear();

    stderrWrites = [];
    stderrSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrWrites.push(String(args[0]));
    });
    vi.stubEnv("LOG_PRETTY", "0");

    const g = globalThis as Record<string, unknown>;
    delete g.__kafkaSseActive;
    delete g.__kafkaSseShutdownRegistered;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("reuses the shared Kafka client (does not construct its own Kafka)", async () => {
    const { startKafkaSseConsumer, getActiveConsumerCount } = await import("@/lib/streams/kafka-sse");
    const { getKafka } = await import("@/lib/kafka");
    const ctrl = new AbortController();

    await startKafkaSseConsumer({
      topic: "incidents",
      fromOffset: "latest",
      signal: ctrl.signal,
      onMessage: () => undefined,
    });

    expect(getKafka).toHaveBeenCalled();
    expect(mockKafkaInstance.consumer).toHaveBeenCalledTimes(1);
    expect(getActiveConsumerCount()).toBe(1);
    ctrl.abort();
  });

  it("assigns a unique consumer group per call", async () => {
    const { startKafkaSseConsumer } = await import("@/lib/streams/kafka-sse");
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();

    await startKafkaSseConsumer({ topic: "incidents", signal: ctrl1.signal, onMessage: () => undefined });
    await startKafkaSseConsumer({ topic: "incidents", signal: ctrl2.signal, onMessage: () => undefined });

    const g1 = mockKafkaInstance.consumer.mock.calls[0][0].groupId;
    const g2 = mockKafkaInstance.consumer.mock.calls[1][0].groupId;
    expect(g1).toMatch(/^console-sse-incidents-/);
    expect(g2).toMatch(/^console-sse-incidents-/);
    expect(g1).not.toBe(g2);
    ctrl1.abort();
    ctrl2.abort();
  });

  it("throws KafkaSseCapacityError when MAX_ACTIVE_CONSUMERS is reached", async () => {
    vi.stubEnv("KAFKA_SSE_MAX_CONSUMERS", "2");
    const { startKafkaSseConsumer, KafkaSseCapacityError, getActiveConsumerCount } = await import("@/lib/streams/kafka-sse");
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const ctrl3 = new AbortController();

    await startKafkaSseConsumer({ topic: "incidents", signal: ctrl1.signal, onMessage: () => undefined });
    await startKafkaSseConsumer({ topic: "incidents", signal: ctrl2.signal, onMessage: () => undefined });
    expect(getActiveConsumerCount()).toBe(2);

    await expect(
      startKafkaSseConsumer({ topic: "incidents", signal: ctrl3.signal, onMessage: () => undefined })
    ).rejects.toBeInstanceOf(KafkaSseCapacityError);

    ctrl1.abort();
    ctrl2.abort();
  });

  it("throws when KAFKA_BROKERS is not configured (getKafka returns no instance)", async () => {
    const { getKafka } = await import("@/lib/kafka");
    vi.mocked(getKafka).mockReturnValueOnce({ status: "disconnected", instance: null });

    const { startKafkaSseConsumer } = await import("@/lib/streams/kafka-sse");
    const ctrl = new AbortController();

    await expect(
      startKafkaSseConsumer({ topic: "incidents", signal: ctrl.signal, onMessage: () => undefined })
    ).rejects.toThrow(/Kafka not configured/);
  });

  it("removes the entry from active set when connect() throws", async () => {
    mockConsumer.connect.mockRejectedValueOnce(new Error("connect failed"));
    const { startKafkaSseConsumer, getActiveConsumerCount } = await import("@/lib/streams/kafka-sse");
    const ctrl = new AbortController();

    await expect(
      startKafkaSseConsumer({ topic: "incidents", signal: ctrl.signal, onMessage: () => undefined })
    ).rejects.toThrow(/connect failed/);
    expect(getActiveConsumerCount()).toBe(0);
  });

  it("aborts trigger disconnect and remove the entry from the active set", async () => {
    const { startKafkaSseConsumer, getActiveConsumerCount } = await import("@/lib/streams/kafka-sse");
    const ctrl = new AbortController();

    await startKafkaSseConsumer({ topic: "incidents", signal: ctrl.signal, onMessage: () => undefined });
    expect(getActiveConsumerCount()).toBe(1);

    ctrl.abort();
    await Promise.resolve();
    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
    expect(getActiveConsumerCount()).toBe(0);
  });

  it("disconnect is idempotent (returned cleanup + abort do not double-call)", async () => {
    const { startKafkaSseConsumer } = await import("@/lib/streams/kafka-sse");
    const ctrl = new AbortController();

    const disconnect = await startKafkaSseConsumer({ topic: "incidents", signal: ctrl.signal, onMessage: () => undefined });
    disconnect();
    ctrl.abort();
    disconnect();
    await Promise.resolve();

    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnect failure is logged but does not throw", async () => {
    mockConsumer.disconnect.mockRejectedValueOnce(new Error("network blip"));
    const { startKafkaSseConsumer } = await import("@/lib/streams/kafka-sse");
    const ctrl = new AbortController();

    await startKafkaSseConsumer({ topic: "incidents", signal: ctrl.signal, onMessage: () => undefined });
    ctrl.abort();
    await new Promise((r) => setImmediate(r));

    const records = stderrWrites.map((s) => JSON.parse(s));
    expect(records).toContainEqual(
      expect.objectContaining({ level: "warn", scope: "kafka-sse", msg: expect.stringContaining("disconnect failed") })
    );
  });

  it("registers consumer.events.CRASH handler that logs", async () => {
    const { startKafkaSseConsumer } = await import("@/lib/streams/kafka-sse");
    const ctrl = new AbortController();

    await startKafkaSseConsumer({ topic: "incidents", signal: ctrl.signal, onMessage: () => undefined });

    const crashCall = mockConsumer.on.mock.calls.find((c) => c[0] === "consumer.crash");
    expect(crashCall).toBeDefined();
    const handler = crashCall![1] as (e: { payload: { error: Error; groupId: string; restart: boolean } }) => void;
    handler({ payload: { error: new Error("kaboom"), groupId: "g1", restart: true } });

    const records = stderrWrites.map((s) => JSON.parse(s));
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", scope: "kafka-sse", msg: expect.stringContaining("crash") })
    );

    ctrl.abort();
  });

  it("replayCount > 0 forces fromBeginning=true regardless of fromOffset", async () => {
    const { startKafkaSseConsumer } = await import("@/lib/streams/kafka-sse");
    const ctrl = new AbortController();

    await startKafkaSseConsumer({
      topic: "incidents",
      fromOffset: "latest",
      replayCount: 3,
      signal: ctrl.signal,
      onMessage: () => undefined,
    });

    expect(mockConsumer.subscribe).toHaveBeenCalledWith({ topic: "incidents", fromBeginning: true });
    ctrl.abort();
  });

  it("fromOffset=latest with no replayCount uses fromBeginning=false", async () => {
    const { startKafkaSseConsumer } = await import("@/lib/streams/kafka-sse");
    const ctrl = new AbortController();

    await startKafkaSseConsumer({
      topic: "incidents",
      fromOffset: "latest",
      signal: ctrl.signal,
      onMessage: () => undefined,
    });

    expect(mockConsumer.subscribe).toHaveBeenCalledWith({ topic: "incidents", fromBeginning: false });
    ctrl.abort();
  });
});
