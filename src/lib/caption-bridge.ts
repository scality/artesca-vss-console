import "server-only";
import { appendFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createLogger } from "@/lib/logger";

const log = createLogger("caption-bridge");

const RTVI_BASE = process.env.RTVI_VLM_URL ?? "http://127.0.0.1:8018";
const JSONL_PATH =
  process.env.SYNTHETIC_EVENTS_PATH ?? "/data/synthetic-events.jsonl";
const MODEL = process.env.VLM_MODEL ?? "nvidia/cosmos-reason2-8b";
const PROMPT =
  process.env.VLM_PROMPT ??
  "Describe what you see in this video. Focus on people, objects, and activities.";
const CHUNK_DURATION_S = Number(process.env.VLM_CHUNK_DURATION ?? "10");
const POLL_INTERVAL_MS = 6_000;
const CAPTION_TIMEOUT_MS = 120_000;

interface StreamInfo {
  id: string;
  liveStreamUrl?: string;
  description?: string;
  sensor_name?: string;
}

async function getActiveStreams(): Promise<StreamInfo[]> {
  try {
    const r = await fetch(`${RTVI_BASE}/v1/streams/get-stream-info`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as unknown;
    return Array.isArray(data) ? (data as StreamInfo[]) : [];
  } catch {
    return [];
  }
}

function appendCaption(envelope: Record<string, unknown>): void {
  const dir = path.dirname(JSONL_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(JSONL_PATH, JSON.stringify(envelope) + "\n", "utf8");
}

async function consumeOneCaptionCycle(stream: StreamInfo): Promise<void> {
  const streamId = stream.id;
  const liveStreamUrl = stream.liveStreamUrl ?? "";
  const description = stream.description ?? stream.sensor_name ?? streamId;

  const payload = {
    id: streamId,
    prompt: PROMPT,
    model: MODEL,
    stream: true,
    max_tokens: 256,
    chunk_duration: CHUNK_DURATION_S,
  };

  const response = await fetch(`${RTVI_BASE}/v1/generate_captions_alerts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;

      let vlmResponse: Record<string, unknown>;
      try {
        vlmResponse = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }

      const chunks = vlmResponse["chunk_responses"];
      if (!Array.isArray(chunks) || chunks.length === 0) continue;
      const firstChunk = chunks[0] as Record<string, unknown>;
      if (!firstChunk?.["content"]) continue;

      const content = (firstChunk as Record<string, unknown>)["content"];
      appendCaption({
        ingestedAt: new Date().toISOString(),
        streamId,
        sensorName: description,
        liveStreamUrl,
        content,
        vlmResponse,
      });
    }
  }
}

export function startCaptionBridge(): void {
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const streams = await getActiveStreams();
      for (const stream of streams) {
        try {
          await consumeOneCaptionCycle(stream);
        } catch {
          // per-stream errors are non-fatal
        }
      }
    } finally {
      running = false;
    }
  }

  tick();
  setInterval(tick, POLL_INTERVAL_MS);

  log.info(`started — polling vss-rtvi-vlm at ${RTVI_BASE} every ${POLL_INTERVAL_MS / 1000}s`);
}
